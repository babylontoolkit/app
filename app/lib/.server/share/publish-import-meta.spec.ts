/**
 * The sandbox's `import_meta` corruption, and the repair that makes a published game playable.
 *
 * FOUND LIVE 2026-08-01 by pressing the button that starts the game on a real published share. The
 * landing page rendered, every asset returned 200, and the lazy Babylon chunk threw
 * `Uncaught ReferenceError: import_meta is not defined`. The sample below is the REAL emitted text
 * from `assets/preload-helper-TdVWNtjp.js` of build `9m2epwr45j6v` — Vite's own preload helper, which
 * every dynamic import in the game goes through.
 *
 * Nodepod rewrites `import.meta` → `import_meta` for its own CJS module loading, where its wrapper
 * declares the binding. That rewrite reaches code which is then bundled into the user's build, where
 * nothing declares it.
 */
import { describe, expect, it } from 'vitest';
import { repairBareImportMeta, repairRootAbsoluteAssetRefs } from './publish';

/** Real bytes from a real broken publish — not a hand-written approximation of one. */
const REAL_BROKEN_HELPER =
  'var E=function(){const n=typeof document<"u"&&document.createElement("link").relList;' +
  'return n&&n.supports&&n.supports("modulepreload")?"modulepreload":"preload"}(),' +
  'w=function(a,n){return new URL(a,n).href},f={},y=function(n,c,p){' +
  'v=function(e){return import_meta.resolve?import_meta.resolve(e):new URL(e,import_meta.url).href};' +
  'return u.then(o=>n().catch(m))};export{y as t};';

describe('repairBareImportMeta — the sandbox leaves an undeclared identifier in ES-module output', () => {
  it('restores every occurrence in the real broken preload helper', () => {
    const { code, count } = repairBareImportMeta(REAL_BROKEN_HELPER);

    expect(count).toBe(3);
    expect(code).not.toMatch(/\bimport_meta\b/);
    expect(code).toContain('import.meta.resolve?import.meta.resolve(e)');
    expect(code).toContain('new URL(e,import.meta.url).href');
  });

  it('leaves a chunk with no occurrences byte-identical', () => {
    const clean = 'export const a=1;const u=new URL("./x.js",import.meta.url).href;';

    const { code, count } = repairBareImportMeta(clean);

    expect(count).toBe(0);
    expect(code).toBe(clean);
  });

  /*
   * 🔴 The self-declaring case. Nodepod's own module wrapper emits `var import_meta = $importMeta`
   * and then USES the identifier — that chunk is internally consistent and already correct. Rewriting
   * it would turn a valid declaration into `var import.meta = …`, a syntax error, converting a
   * working publish into one that cannot parse at all. Strictly worse than the bug being fixed.
   */
  it('refuses to touch a chunk that declares the binding itself', () => {
    const selfContained = 'var import_meta={url:"file:///x"};console.log(import_meta.url);';

    const { code, count } = repairBareImportMeta(selfContained);

    expect(count).toBe(0);
    expect(code).toBe(selfContained);
  });

  it.each([
    ['a property access', 'const v=cfg.import_meta;'],
    ['a longer identifier', 'const v=import_metadata.url;'],
    ['a prefixed identifier', 'const v=my_import_meta;'],
  ])('leaves %s alone', (_label, source) => {
    const { code, count } = repairBareImportMeta(source);

    expect(count).toBe(0);
    expect(code).toBe(source);
  });

  /*
   * The repair must be IDEMPOTENT: publish runs on every re-share, and a second pass over already
   * repaired output must be a no-op rather than mangling `import.meta` further.
   */
  it('is idempotent — repairing twice equals repairing once', () => {
    const once = repairBareImportMeta(REAL_BROKEN_HELPER).code;
    const twice = repairBareImportMeta(once);

    expect(twice.count).toBe(0);
    expect(twice.code).toBe(once);
  });

  /*
   * CONTROL. Every assertion above is about what the function must NOT change, and a function that
   * returned its input unmodified would pass all of them. This is the one that fails if the repair
   * stops repairing.
   */
  it('CONTROL — a bare identifier really is rewritten', () => {
    const { code, count } = repairBareImportMeta('const u=import_meta.url;');

    expect(count).toBe(1);
    expect(code).toBe('const u=import.meta.url;');
  });
});

/**
 * Root-absolute asset URLs — the second thing that made a published game look broken.
 *
 * FOUND LIVE 2026-08-01 on the same share: the game played, and its three track tiles were empty
 * boxes. `Home.tsx` carried `"/assets/generated/track-x.jpg"`, which under `/play/<id>/` resolves to
 * the app origin's root. The CSS hero in the SAME build loaded fine, because bundlers rewrite `url()`
 * and cannot rewrite a JS string literal.
 */
describe('repairRootAbsoluteAssetRefs — only re-points URLs that name a real file in the build', () => {
  const BUILD = new Set(['index.js', 'assets/generated/track-neon-downtown.jpg', 'assets/generated/hero-car.png']);

  it('re-points a root-absolute URL that the build really contains', () => {
    const { code, count } = repairRootAbsoluteAssetRefs('const a="/assets/generated/hero-car.png";', BUILD);

    expect(count).toBe(1);
    expect(code).toBe('const a="./assets/generated/hero-car.png";');
  });

  it.each([
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
  ])('handles %s-quoted literals', (q) => {
    const { code, count } = repairRootAbsoluteAssetRefs(`const a=${q}/assets/generated/hero-car.png${q};`, BUILD);

    expect(count).toBe(1);
    expect(code).toContain(`${q}./assets/generated/hero-car.png${q}`);
  });

  /*
   * 🔴 The safety property. A path the build does not contain is somebody else's route — an API
   * endpoint, a path on another service — and silently relativising it would break a working game to
   * fix a cosmetic one. This is the assertion that keeps the repair exact rather than a guess.
   */
  it('leaves a path the build does NOT contain completely alone', () => {
    const source = 'fetch("/api/session.json");const b="/assets/generated/not-emitted.jpg";';

    const { code, count } = repairRootAbsoluteAssetRefs(source, BUILD);

    expect(count).toBe(0);
    expect(code).toBe(source);
  });

  it('never touches another origin (protocol-relative or absolute)', () => {
    const source = 'const a="//cdn.example.com/assets/generated/hero-car.png";const b="https://x.io/index.js";';

    const { code, count } = repairRootAbsoluteAssetRefs(source, BUILD);

    expect(count).toBe(0);
    expect(code).toBe(source);
  });

  it('leaves an already-relative reference alone (idempotent)', () => {
    const once = repairRootAbsoluteAssetRefs('const a="/assets/generated/hero-car.png";', BUILD).code;
    const twice = repairRootAbsoluteAssetRefs(once, BUILD);

    expect(twice.count).toBe(0);
    expect(twice.code).toBe(once);
  });

  /*
   * CONTROL — every assertion above except the first is about what must NOT change, and a function
   * returning its input would satisfy them. This one fails if the repair stops repairing.
   */
  it('CONTROL — the real broken pattern from the live game is repaired', () => {
    const real = 'src:"/assets/generated/track-neon-downtown.jpg",label:"ROOKIE"';

    const { code, count } = repairRootAbsoluteAssetRefs(real, BUILD);

    expect(count).toBe(1);
    expect(code).toContain('"./assets/generated/track-neon-downtown.jpg"');
  });
});
