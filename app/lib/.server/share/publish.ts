/**
 * Publishing a build (SPEC §4.8, §5, spec/hosting.md).
 *
 * The flow: the WebContainer runs `npm run build` (client side — the server never executes user code,
 * §5), the client hands us the resulting `dist/` as a byte-faithful `SerializedFileMap`, and this
 * module puts it in object storage under a share key and mints the public id.
 *
 * Two things here are load-bearing, and both are about the fact that **the file paths in that map came
 * from the client**:
 *
 * 1. **Every key is re-derived, never trusted.** A build map is a client-supplied
 *    `Record<path, dirent>`. `../` in one of those paths, applied naively to a storage prefix, writes
 *    OUTSIDE this share — over another user's build, or over a snapshot. `buildObjectKey` is the only
 *    way a path becomes a key, and it rejects rather than sanitises: a path that needed cleaning is a
 *    path we do not understand, and quietly "fixing" it into some other valid key is how you end up
 *    overwriting the wrong object with a straight face.
 * 2. **The secret rules run again, here, on the bytes actually being uploaded.** `runPublishingChecklist`
 *    (checklist.ts) already scanned the SOURCE, but this is the last code that touches the bytes before
 *    they become world-readable, and it is the only place that sees what is *actually* in the upload.
 *    Defence in depth on the one action that cannot be undone.
 */
import { randomInt } from 'node:crypto';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { base64ToBytes } from '~/lib/binary/binary-files';
import { stripSandboxRootPrefix } from '~/lib/common/sandbox-paths';
import { envNumber } from '~/lib/.server/env';
import { getObjectStore } from '~/lib/.server/storage';
import { getProjectStore } from '~/lib/.server/projects/store';
import { deleteRemixSeed, maxSeedBytes } from './seed-store';
import type { Project } from '~/lib/.server/projects/types';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('share.publish');

/**
 * Share ids are in URLs people paste to friends, so: no ambiguous glyphs (no `l`/`1`/`O`/`0`) and long
 * enough that the id space cannot be walked. 12 characters of a 31-symbol alphabet is ~59 bits.
 *
 * **`randomInt`, not `Math.random`.** A share that is not submitted to the gallery is *unlisted*, and
 * an unlisted game is protected by exactly one thing: the unguessability of this id. `Math.random` is
 * a PRNG whose internal state is recoverable from its outputs — an attacker who reads a handful of
 * public gallery share ids could then predict the unlisted ones. This is a CSPRNG for the same reason
 * a session token is.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SHARE_ID_LENGTH = 12;

export function generateShareId(): string {
  let id = '';

  for (let i = 0; i < SHARE_ID_LENGTH; i++) {
    id += ALPHABET[randomInt(ALPHABET.length)];
  }

  return id;
}

/** Where a share's static files live. One prefix per share id — never per project. */
export function buildPrefix(shareId: string): string {
  return `builds/${shareId}`;
}

export class UnsafeBuildPathError extends Error {
  readonly statusCode = 400;
  readonly isRetryable = false;

  constructor(path: string) {
    super(`That build contains a file path we cannot publish safely: ${path}`);
    this.name = 'UnsafeBuildPathError';
  }
}

/**
 * Caps on the uploaded build (SPEC §5) — **configurable**: `BUILD_MAX_MB`, `BUILD_MAX_FILES`.
 *
 * The `dist/` map is client-supplied and written to a PUBLIC bucket, so without a bound it is
 * unbounded S3 storage + CDN egress on the platform's bill for any verified user, repeatable on every
 * re-publish. Generous for a real game build (wasm + textures + audio), bounded against abuse.
 *
 * ⚠️ **A publish is bounded THREE times and they must stay in step** — this build, the remix seed
 * (`REMIX_SEED_MAX_MB`), and the whole request body (`PUBLISH_BODY_MAX_MB`, a cheap `Content-Length`
 * reject before anything is decoded). See `maxPublishBodyBytes` below and `.env.example`.
 */
export const DEFAULT_BUILD_MAX_MB = 150;
export const DEFAULT_BUILD_MAX_FILES = 10_000;

export function maxBuildBytes(context?: unknown): number {
  const mb = envNumber(context, 'BUILD_MAX_MB', DEFAULT_BUILD_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_BUILD_MAX_MB) * 1024 * 1024;
}

export function maxBuildFiles(context?: unknown): number {
  const n = envNumber(context, 'BUILD_MAX_FILES', DEFAULT_BUILD_MAX_FILES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUILD_MAX_FILES;
}

/** Headroom over build + seed, for the JSON envelope wrapping the two maps. */
const PUBLISH_BODY_HEADROOM = 1.1;

/**
 * Ceiling on the whole publish request body (dist + source) — **configurable**, `PUBLISH_BODY_MAX_MB`.
 *
 * A cheap header-level reject so an obviously oversized request is never parsed into memory. It lives
 * here, beside the caps it has to clear, rather than in the route: it is not a third independent number
 * but a FUNCTION of the other two, and the whole reason this exists is that independently-chosen limits
 * drift out of step and the drift is invisible.
 *
 * So the DEFAULT is derived — raise `BUILD_MAX_MB` or `REMIX_SEED_MAX_MB` and this follows. An explicit
 * override still wins (silently recomputing a number an operator typed is its own kind of mystery), but
 * an override BELOW build + seed is the effective cap, and the caller is expected to say so loudly at
 * the moment it bites rather than leave a 413 naming a limit nobody changed.
 */
export function maxPublishBodyBytes(context?: unknown): number {
  // 0 means "unset" — a real override is always positive, and a nonsense one is ignored like the rest.
  const mb = envNumber(context, 'PUBLISH_BODY_MAX_MB', 0);

  if (!Number.isFinite(mb) || mb <= 0) {
    return Math.ceil(publishBodyFloorBytes(context) * PUBLISH_BODY_HEADROOM);
  }

  return mb * 1024 * 1024;
}

/** What a publish body must be able to carry: a full build plus a full seed. */
export function publishBodyFloorBytes(context?: unknown): number {
  return maxBuildBytes(context) + maxSeedBytes(context);
}

export class BuildTooLargeError extends Error {
  readonly statusCode = 413;
  readonly isRetryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'BuildTooLargeError';
  }
}

/**
 * A build whose entry HTML asks for root-absolute assets can never boot as a share (T17b).
 *
 * Shares are served under a PREFIX — `/play/<shareId>/` — in every deployment (locally by
 * `buildContentKey`, and behind CloudFront the same key resolution applies on the play origin; there
 * is no deployment that serves a share at an origin root). `<script src="/index.js">` therefore
 * resolves to the BUILDER's 404 page, served as HTML to a module script: the game publishes fine and
 * renders nothing, silently. The share build passes `--base=./` (`SHARE_BUILD_COMMAND`), so this
 * refusal only fires on a regression — a project whose config or build path un-relativised the base —
 * and firing loudly beats shipping a game that cannot boot.
 */
export class RootAbsoluteAssetError extends Error {
  readonly statusCode = 422;
  readonly isRetryable = false;

  constructor(refs: string[]) {
    super(
      `This build cannot run at its share address: index.html points at ${refs
        .map((r) => `"${r}"`)
        .join(', ')} — root-absolute paths that break under /play/<id>/. ` +
        `Publish again (the platform builds shares with a relative base); if the project overrides vite's ` +
        `"base" during its build, set it to "./".`,
    );
    this.name = 'RootAbsoluteAssetError';
  }
}

/**
 * A build whose ROUTER is mounted at the literal vite base can never render at its share address.
 *
 * The sibling of {@link RootAbsoluteAssetError}, and strictly nastier: the assets all load with a 200,
 * so the game publishes, serves, and shows a blank screen. FOUND LIVE 2026-07-31 by opening a
 * published game instead of trusting the "Your game is live! 🎉" toast — the only trace was a console
 * warning inside the iframe:
 *
 *   <Router basename="/./"> is not able to match the URL "/play/9tkrubxyra36/?embed=1"
 *   because it does not start with the basename, so the <Router> won't render anything.
 *
 * Cause: `<BrowserRouter basename={import.meta.env.BASE_URL}>`. Shares build with `--base=./`
 * (`SHARE_BUILD_COMMAND`, T17b — which is what makes the ASSETS work), so `BASE_URL` is the string
 * `"./"`, and React Router normalises that to `/./`, which matches no URL anywhere. The current
 * starter fixed this by resolving the mount point at runtime (`appBasename()`), so a project created
 * from the pin is fine — but a project IMPORTED from a folder, or remixed from an old share, carries
 * whatever `app.tsx` it arrived with and publishes a blank page with nothing reporting why.
 *
 * Refusing costs the user one message; the alternative is a public link that looks fine to them and is
 * broken for everyone who opens it.
 */
export class UnmountableRouterBasenameError extends Error {
  readonly statusCode = 422;
  readonly isRetryable = false;

  constructor(literals: string[]) {
    super(
      `This build would render a blank page at its share address: the router is mounted at ` +
        `${literals.map((l) => `"${l}"`).join(', ')}, which matches no URL under /play/<id>/. ` +
        `In src/app.tsx, replace <BrowserRouter basename={import.meta.env.BASE_URL}> with a basename ` +
        `resolved at runtime:\n\n` +
        `  function appBasename(): string {\n` +
        `    return new URL(import.meta.env.BASE_URL, window.location.href).pathname;\n` +
        `  }\n\n` +
        `  <BrowserRouter basename={appBasename()}>\n\n` +
        `Then publish again. (Projects created from the current starter already do this.)`,
    );
    this.name = 'UnmountableRouterBasenameError';
  }
}

/**
 * Router basenames baked into built JS that cannot match a prefixed share URL.
 *
 * MEASURED against a real broken publish: the minifier keeps the object key and the string literal
 * intact (`basename:"./"` — object keys passed to `createElement` cannot be mangled), and the entry
 * chunk contained exactly ONE such literal, the app's own. A project using `appBasename()` computes
 * the value at runtime and therefore contains none, which is what makes this safe to refuse on.
 *
 * Only the relative forms are matched — `"./"`, `"."`, `"/./"`. A real absolute basename ("/", or a
 * genuine prefix) is somebody's deliberate choice and none of our business.
 */
export function unmountableRouterBasenames(js: string): string[] {
  const found: string[] = [];

  for (const match of js.matchAll(/\bbasename\s*:\s*(["'])(\.\/?|\/\.\/?)\1/g)) {
    if (!found.includes(match[2])) {
      found.push(match[2]);
    }
  }

  return found;
}

/**
 * Repair a bare `import_meta` identifier the SANDBOX left in an emitted ES-module chunk.
 *
 * 🔴 FOUND LIVE 2026-08-01: a published game rendered its landing page and then threw
 * `Uncaught ReferenceError: import_meta is not defined` the moment the lazy Babylon chunk executed —
 * i.e. on the button that starts the game. The culprit was Vite's own preload helper, emitted as:
 *
 *   return import_meta.resolve ? import_meta.resolve(e) : new URL(e, import_meta.url).href
 *
 * Nodepod rewrites `import.meta` → `import_meta` for its OWN CJS module loading, where its module
 * wrapper supplies the binding (`var import_meta = $importMeta`). That rewrite reaches code which is
 * then BUNDLED into the user's build, where no wrapper exists and the identifier is simply undefined.
 *
 * **The repair is exact, not a guess.** The original source was `import.meta`; the emitted chunks are
 * ES modules (loaded via `<script type="module">` and dynamic `import()`), where `import.meta` is
 * valid. Restoring it returns the code to what the compiler meant.
 *
 * Deliberately a REPAIR and not a refusal, unlike its two siblings below: this corruption is produced
 * by our own sandbox, not by anything in the user's project, so there is no edit they could make to
 * satisfy a refusal — it would be a permanent, unexplainable "your game cannot be published".
 *
 * ⚠️ Only a BARE identifier is rewritten. A property access (`x.import_meta`), a declaration
 * (`var import_meta`), or the string `"import_meta"` are all left alone: a chunk that legitimately
 * declares the binding is already correct, and rewriting its declaration would break it.
 */
export function repairBareImportMeta(js: string): { code: string; count: number } {
  // A chunk that declares the binding itself is self-contained — leave it entirely alone.
  if (/\b(?:var|let|const|function)\s+import_meta\b/.test(js)) {
    return { code: js, count: 0 };
  }

  let count = 0;

  const code = js.replace(/(^|[^\w$.])import_meta\b/g, (match, lead: string) => {
    count++;
    return `${lead}import.meta`;
  });

  return { code, count };
}

/**
 * Re-point a root-absolute asset URL in emitted JS at the file it actually means.
 *
 * 🔴 FOUND LIVE 2026-08-01: a published game rendered, played, and showed EMPTY BOXES where its
 * track art belonged. `Home.tsx` referenced `"/assets/generated/track-x.jpg"`; the share is served
 * under `/play/<id>/`, so that resolves to the app origin's root and 404s for every visitor.
 *
 * The generated media pipeline used to hand the model root-absolute URLs, which is fixed at the source
 * (`mediaReferenceUrl`) — but that only helps games generated AFTERWARDS. Every game already published,
 * every imported folder, and every remix of an old share carries the broken literal, and its owner has
 * no way to know: the same path is correct in dev, where the app IS at the origin root.
 *
 * **Only a path that names a REAL FILE IN THIS BUILD is rewritten**, which is what makes it safe rather
 * than a guess. `/assets/generated/x.png` is rewritten only when `assets/generated/x.png` was actually
 * emitted; anything else — an API route, a path on another service, a string that merely looks like one
 * — is left exactly as written. And a rewrite can only ever improve matters: under a share prefix the
 * original was a guaranteed 404.
 *
 * A REPAIR, not a refusal (like {@link repairBareImportMeta}, unlike its two neighbours): the art is
 * already paid for and the game is otherwise fine, so refusing would strand a working game over a URL
 * we can resolve ourselves.
 *
 * CSS needs none of this — the bundler rewrites `url()` at build time. That asymmetry is exactly why the
 * bug hid: on the game that surfaced it, the CSS hero loaded 200 while all four `<img>` tiles 404'd, in
 * the same build.
 */
export function repairRootAbsoluteAssetRefs(
  js: string,
  buildPaths: ReadonlySet<string>,
): { code: string; count: number } {
  let count = 0;

  const code = js.replace(
    /(["'`])(\/[A-Za-z0-9_\-./@]+\.[A-Za-z0-9]{2,5})\1/g,
    (match, quote: string, path: string) => {
      // Protocol-relative (`//cdn…`) is another origin's business, never ours.
      if (path.startsWith('//')) {
        return match;
      }

      if (!buildPaths.has(path.slice(1))) {
        return match;
      }

      count++;

      return `${quote}.${path}${quote}`;
    },
  );

  return { code, count };
}

/**
 * The boot-breaking references ONLY: entry `<script src="/…">` and `<link rel="stylesheet|modulepreload"
 * href="/…">`. Deliberately narrow — a root-absolute favicon merely misses an icon, and refusing a
 * publish for it would be vetoing a working game. Protocol-relative (`//cdn…`) is not root-absolute.
 */
export function rootAbsoluteEntryRefs(html: string): string[] {
  const refs: string[] = [];

  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"(\/[^/"][^"]*)"/gi)) {
    refs.push(match[1]);
  }

  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const link = tag[0];

    if (!/\brel\s*=\s*"(stylesheet|modulepreload)"/i.test(link)) {
      continue;
    }

    const href = link.match(/\bhref\s*=\s*"(\/[^/"][^"]*)"/i);

    if (href) {
      refs.push(href[1]);
    }
  }

  return refs;
}

/** Paths that must never be uploaded to a public bucket, whatever the checklist said. */
const NEVER_PUBLISH = [/(^|\/)\.env$/, /(^|\/)\.env\.[^/]*local$/, /(^|\/)\.npmrc$/, /(^|\/)\.git\//];

/**
 * Turn a client-supplied build path into a storage key, or throw.
 *
 * Rejects (never rewrites): absolute paths, `..` in any segment, backslashes (a Windows-shaped path
 * that a POSIX key would mangle), null bytes, and empty segments. Anything that survives is a plain
 * relative path made of ordinary segments, and joining it to the prefix cannot escape the prefix.
 */
export function buildObjectKey(shareId: string, rawPath: string): string {
  /*
   * Normalise ONLY a known sandbox root and the dist root — never a bare leading slash, so a genuinely
   * absolute path (`/etc/...`) is rejected below rather than silently relativised. That is why this
   * uses `stripSandboxRootPrefix` and NOT `toProjectRelativePath`, which strips leading slashes.
   *
   * It was a `/^\/?home\/project\//` literal, i.e. the T7b family — and invisible to every grep for
   * `home/project`, because the slashes are regex-escaped and the raw text reads `home\/project`. Only
   * the source scan (`workdir-literals.spec.ts`) found it, on the run that widened its detector.
   */
  const path = stripSandboxRootPrefix(rawPath).replace(/^dist\//, '');

  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new UnsafeBuildPathError(rawPath);
  }

  if (path.includes('\\') || path.includes('\0')) {
    throw new UnsafeBuildPathError(rawPath);
  }

  const segments = path.split('/');

  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new UnsafeBuildPathError(rawPath);
  }

  if (NEVER_PUBLISH.some((rule) => rule.test(path))) {
    throw new UnsafeBuildPathError(rawPath);
  }

  return `${buildPrefix(shareId)}/${segments.join('/')}`;
}

export interface PublishInput {
  project: Project;

  /** The contents of `dist/` after `npm run build`, byte-faithful (spec/binary-files.md). */
  dist: SerializedFileMap;
  title?: string;
  description?: string;

  /** Ask an admin to feature this in the gallery (§4.8). Curation is theirs, not the user's. */
  submitToGallery?: boolean;

  /** From the checklist — a network-capable game is launched solo (§4.8). */
  soloLaunch?: boolean;
}

export interface PublishResult {
  shareId: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * Upload a build and mint (or reuse) the project's share id.
 *
 * Re-publishing REUSES the existing share id — the URL a user already sent to their friends must keep
 * working and must show the new version. It writes the new files over the old prefix and then deletes
 * whatever the previous build left behind, in that order: a visitor mid-publish sees a stale file or a
 * fresh one, never a missing one.
 */
export async function publishBuild(input: PublishInput, context?: unknown): Promise<PublishResult> {
  const { project, dist } = input;
  const shareId = project.shareId ?? generateShareId();
  const objects = getObjectStore(context);
  const prefix = buildPrefix(shareId);

  const entries = Object.entries(dist).filter(
    (entry): entry is [string, Exclude<SerializedFileMap[string], undefined> & { type: 'file' }] =>
      entry[1]?.type === 'file',
  );

  if (entries.length === 0) {
    throw new UnsafeBuildPathError('the build produced no files');
  }

  // Cap BEFORE decoding/writing: reject an oversized build rather than stream it into the bucket.
  const fileLimit = maxBuildFiles(context);

  if (entries.length > fileLimit) {
    throw new BuildTooLargeError(
      `That build has too many files (${entries.length} > ${fileLimit}). Raise BUILD_MAX_FILES to publish it.`,
    );
  }

  const approxBytes = entries.reduce((sum, [, dirent]) => sum + (dirent.content?.length ?? 0), 0);
  const byteLimit = maxBuildBytes(context);

  if (approxBytes > byteLimit) {
    /* Say the size and the limit — "too large" alone leaves the operator nothing to act on. */
    throw new BuildTooLargeError(
      `That build is ${(approxBytes / 1048576).toFixed(1)}MB, over the ${Math.round(byteLimit / 1048576)}MB ` +
        'publish limit. Raise BUILD_MAX_MB to publish it.',
    );
  }

  /*
   * Repair the sandbox's `import_meta` corruption BEFORE the bytes are keyed (see
   * {@link repairBareImportMeta}). Text JS only — a binary is never a module, and decoding one to run
   * a regex over it would be both wrong and expensive.
   */
  let importMetaRepairs = 0;
  let assetRefRepairs = 0;

  /*
   * The set of paths this build actually emitted, build-relative. It is what makes the asset repair
   * exact instead of a guess — a URL is only re-pointed when it names a file that is really here.
   */
  const buildPaths = new Set(entries.map(([path]) => stripSandboxRootPrefix(path).replace(/^dist\//, '')));

  for (const entry of entries) {
    const [path, dirent] = entry;

    if (dirent.isBinary || !/\.[cm]?js$/i.test(path)) {
      continue;
    }

    const meta = repairBareImportMeta(dirent.content);
    const assets = repairRootAbsoluteAssetRefs(meta.code, buildPaths);

    importMetaRepairs += meta.count;
    assetRefRepairs += assets.count;

    if (meta.count > 0 || assets.count > 0) {
      entry[1] = { ...dirent, content: assets.code };
    }
  }

  /*
   * Surfaced, never silent. Both repairs paper over something upstream — a sandbox emitting broken
   * output, and project code written against a root-served app — and if either ever stops happening
   * (or starts happening somewhere new) these counts are the only way anyone finds out.
   */
  if (importMetaRepairs > 0) {
    logger.warn(`publish: repaired ${importMetaRepairs} bare import_meta reference(s) in ${shareId}`);
  }

  if (assetRefRepairs > 0) {
    logger.warn(`publish: re-pointed ${assetRefRepairs} root-absolute asset URL(s) in ${shareId}`);
  }

  // Derive every key BEFORE writing anything — one bad path fails the publish, it does not half-do it.
  const planned = entries.map(([path, dirent]) => ({
    key: buildObjectKey(shareId, path),
    bytes: dirent.isBinary ? base64ToBytes(dirent.content) : new TextEncoder().encode(dirent.content),
    path,
  }));

  /*
   * Refuse a build that cannot boot at its share address (T17b) — checked BEFORE writing, like the
   * caps: a broken game on a public URL is worse than a refused publish.
   */
  const entryHtml = entries.find(
    ([path, dirent]) => buildObjectKey(shareId, path) === `${prefix}/index.html` && !dirent.isBinary,
  );

  if (entryHtml) {
    const refs = rootAbsoluteEntryRefs(entryHtml[1].content);

    if (refs.length > 0) {
      throw new RootAbsoluteAssetError(refs);
    }
  }

  /*
   * And the same question one layer in: the assets can all load and the ROUTER still refuse to mount
   * (see UnmountableRouterBasenameError). Checked here, before any write, for the same reason — a
   * blank game on a public URL is worse than a refused publish, and this one leaves no 404 to notice.
   */
  for (const [path, dirent] of entries) {
    if (dirent.isBinary || !/\.js$/i.test(path)) {
      continue;
    }

    const literals = unmountableRouterBasenames(dirent.content);

    if (literals.length > 0) {
      throw new UnmountableRouterBasenameError(literals);
    }
  }

  const previous = await objects.list(prefix);
  const written = new Set<string>();
  let totalBytes = 0;

  for (const file of planned) {
    await objects.put(file.key, file.bytes, contentTypeFor(file.path));
    written.add(file.key);
    totalBytes += file.bytes.byteLength;
  }

  // Files the old build had and the new one does not. Left behind, they would be served forever.
  for (const stale of previous) {
    if (!written.has(stale.key)) {
      await objects.delete(stale.key);
    }
  }

  await getProjectStore(context).update(project.id, {
    shareId,
    shareTitle: input.title?.trim() || project.name,
    shareDescription: input.description?.trim() || undefined,
    sharedAt: new Date().toISOString(),
    soloLaunch: input.soloLaunch ?? false,

    // Submitting is a REQUEST. Nothing becomes publicly listed without an admin approving it (§5).
    galleryStatus: input.submitToGallery ? 'pending' : 'none',
  });

  logger.info(`Published ${project.id} as ${shareId}: ${planned.length} files, ${totalBytes} bytes`);

  return { shareId, fileCount: planned.length, totalBytes };
}

/**
 * Unpublish: the URL stops working, the build is deleted, and the remix seed is forgotten.
 *
 * The share id is NOT released back — it stays on the project (as `sharedAt: undefined`) so that a
 * later re-publish reuses it. Recycling ids would let a stale link land on somebody else's game.
 *
 * 🔴 The SEED goes too (§4.8, §4.5.4b), and that is not housekeeping. The seed is the only source the
 * platform holds, and the sole justification for holding it is that the owner deliberately made this
 * game public. Unpublishing withdraws exactly that. Keeping the seed would mean "make it private
 * again" left our copy of their code sitting in storage — the §4.5.4b promise reduced to a claim.
 *
 * An existing remix is unaffected: a clone has its own seed, under its own project id.
 */
export async function unpublish(project: Project, context?: unknown): Promise<void> {
  if (!project.shareId) {
    return;
  }

  const objects = getObjectStore(context);

  for (const object of await objects.list(buildPrefix(project.shareId))) {
    await objects.delete(object.key);
  }

  await deleteRemixSeed(project.id, context);
  await getProjectStore(context).update(project.id, {
    sharedAt: undefined,
    galleryStatus: 'none',
    remixSeedAt: undefined,
  });

  logger.info(`Unpublished ${project.id} (${project.shareId}) and deleted its remix seed`);
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  ktx2: 'image/ktx2',
  dds: 'image/vnd-ms.dds',
  env: 'application/octet-stream',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

/**
 * Content type by extension.
 *
 * `.wasm` and `.glb` matter more than they look: Babylon streams both, and a wrong type on the WASM
 * (Havok physics) makes the browser refuse to compile it — the game loads and then simply never
 * simulates. Unknown types fall back to a byte stream rather than guessing.
 */
export function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';

  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
