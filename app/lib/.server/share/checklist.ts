/**
 * The Publishing Checklist — the pre-share pass (SPEC §4.8, §5).
 *
 * Publishing is the one irreversible thing a user can do here. A snapshot is private and a bad one is
 * undone by restore (§4.12); a *published build* is a static bundle on a public CDN, and once a
 * visitor (or a crawler) has fetched it, no amount of unpublishing takes it back. So everything this
 * function refuses to publish, it refuses for a reason that cannot be walked back later.
 *
 * Two classes of finding, and the distinction is the whole design:
 *
 * - **blocking** — publishing would do irreversible harm. In practice that is exactly one thing:
 *   shipping a SECRET. The Toolkit's own MCP template (§4.14) puts real API keys in the project's
 *   `.env`, and a user who has connected a Game Backend (§4.15) has a Supabase URL and key sitting in
 *   the tree. `.env` is gitignored, so it never reaches a repo — but a naive "upload the whole
 *   project" share path would push it straight to a public bucket. That is not a warning. That is a
 *   refusal.
 * - **warning** — the game will look unfinished or behave oddly (debug overlays on, a network game
 *   that will sit forever waiting for a peer). Annoying, entirely reversible, and NOT ours to veto:
 *   it is the user's game and they are allowed to publish a rough one.
 *
 * Anything that can be fixed FOR the user without guessing at their intent is neither — it is just
 * fixed (see `soloLaunchRequired`: a network-capable game is launched `?solo=true` rather than
 * blocked, per §4.8).
 *
 * Pure and exhaustively tested, because it is the last thing standing between a user's API key and a
 * public URL, and because it must run identically on the pre-share preview and on the publish itself.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { ChecklistFinding } from '~/types/share';

/*
 * Re-exported so existing importers of these types from this module keep working; the source of truth
 * is `~/types/share` (client-safe, since the share dialog renders findings — §4.8).
 */
export type { ChecklistFinding, FindingLevel } from '~/types/share';

export interface ChecklistResult {
  ok: boolean;
  findings: ChecklistFinding[];

  /** Network-capable game → the share launches with `?solo=true` (§4.8). Not a finding; a fix. */
  soloLaunchRequired: boolean;
}

/**
 * Files that must NEVER reach a public build, whatever else is true.
 *
 * Matched on the path, not the contents, because the contents are exactly what we must not have to
 * reason about. `.env.example` is deliberately allowed through — it is the template's documentation
 * of which keys exist, carries placeholders rather than values, and is committed upstream.
 */
const SECRET_FILES = [/(^|\/)\.env$/, /(^|\/)\.env\.local$/, /(^|\/)\.env\.[^/]*local$/, /(^|\/)\.npmrc$/];

/** A `.mcp.json` may legitimately carry keys inline instead of via `.env` (§4.14). */
const MCP_CONFIG = /(^|\/)\.mcp\.json$/;

/**
 * Values that look like live credentials, for the one case a path check cannot catch: a key pasted
 * into source. Deliberately narrow — these are prefixes that are unambiguously secret-shaped, so a
 * false positive (which BLOCKS a publish) stays vanishingly unlikely.
 *
 * A Supabase *anon* key is intentionally NOT here: shipping it is normal and correct for a Game
 * Backend (§4.15), safe under RLS. It gets a warning, not a block.
 */
const SECRET_VALUE = /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;

/** The service-role key is the one Supabase key that must never ship — it bypasses RLS entirely. */
const SERVICE_ROLE = /"?role"?\s*:\s*"?service_role|SUPABASE_SERVICE_ROLE/;

const DEBUG_KEYS_ON = /enableDebugKeys\s*[:=]\s*true/;
const DEBUG_OVERLAY_ON = /(showDebugLayer|showRenderStats|showPhysicsViewer|showCollisionViewer)\s*[:=]\s*true/;

/** Network-capable games must launch solo when shared, or they hang waiting for a peer (§4.8). */
const NETWORK_CAPABLE = /\b(Colyseus|NetworkManager|createRoom|joinOrCreate|multiplayer\s*[:=]\s*true)\b/;

function textFiles(files: SerializedFileMap): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  for (const [path, dirent] of Object.entries(files)) {
    // Binary dirents carry NO content by design (spec/binary-files.md) — never scan `.content` for one.
    if (dirent?.type === 'file' && !dirent.isBinary) {
      out.push([path, dirent.content]);
    }
  }

  return out;
}

/** Normalise `/home/project/src/x.ts` → `src/x.ts` so rules read the same however the map was built. */
function relative(path: string): string {
  return path.replace(/^\/?(home\/project\/)?/, '').replace(/^\/+/, '');
}

/**
 * Run the checklist over a project's source.
 *
 * Note this scans the SOURCE, not the built `dist/`. That is deliberate: a bundler inlines
 * `import.meta.env.VITE_*` values into the output, so by the time you are looking at `dist/` a leaked
 * key is a base64-ish string in a minified chunk and is genuinely hard to find. The source is where
 * secrets are still recognisable. (`publishBuild` independently refuses to upload a secret-shaped
 * path, so the two checks are belt and braces — see `share/publish.ts`.)
 */
export function runPublishingChecklist(files: SerializedFileMap): ChecklistResult {
  const findings: ChecklistFinding[] = [];
  let soloLaunchRequired = false;

  for (const [rawPath, content] of textFiles(files)) {
    const path = relative(rawPath);

    if (SECRET_FILES.some((rule) => rule.test(path))) {
      findings.push({
        level: 'blocking',
        code: 'secret-file',
        path,
        message: `${path} holds your private keys. It can never be part of a public build — remove it from the project, or move those values out of the shared game.`,
      });
      continue;
    }

    if (MCP_CONFIG.test(path) && SECRET_VALUE.test(content)) {
      findings.push({
        level: 'blocking',
        code: 'secret-in-mcp-config',
        path,
        message: `${path} has an API key written directly into it. Move the key into .env and reference it from the config, then publish again.`,
      });
      continue;
    }

    if (SECRET_VALUE.test(content) || SERVICE_ROLE.test(content)) {
      findings.push({
        level: 'blocking',
        code: 'secret-in-source',
        path,
        message: `${path} looks like it contains a private API key. Anyone who plays a published game can read its code, so this has to come out before you can share.`,
      });
      continue;
    }

    if (DEBUG_KEYS_ON.test(content)) {
      findings.push({
        level: 'warning',
        code: 'debug-keys',
        path,
        message: `Debug shortcut keys are switched on in ${path}. Players will be able to open debug tools in your game.`,
      });
    }

    if (DEBUG_OVERLAY_ON.test(content)) {
      findings.push({
        level: 'warning',
        code: 'debug-overlay',
        path,
        message: `A debug overlay is switched on in ${path}. It will be visible to everyone who plays.`,
      });
    }

    if (NETWORK_CAPABLE.test(content)) {
      soloLaunchRequired = true;
    }
  }

  return { ok: !findings.some((f) => f.level === 'blocking'), findings, soloLaunchRequired };
}
