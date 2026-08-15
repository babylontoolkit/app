/**
 * Where the Code-view binary preview points (T2, SPEC §4.1b).
 *
 * Two rules, and both fail SILENTLY when they are wrong — a broken-image icon or an iframe showing the
 * builder is what the user sees, never an exception:
 *
 *   - **which preview may be pointed at.** An un-`ready` preview 404s every `<img>` on the page, so
 *     "there is a preview" is not the question; "is it serving" is.
 *   - **how a project file becomes a URL.** `public/` is served AT THE PREVIEW ROOT, everything else
 *     goes through Vite's `/@fs/<absolute>` door — and the absolute form is a property of the PROVIDER
 *     (`/home/project` vs `/project/workspace`), which is why the rebase is delegated to
 *     `sandbox-paths` rather than sliced here.
 *
 * The join itself belongs to `previewUrlWithPath` and is tested there; what is asserted here is that
 * this module DELEGATES to it — i.e. that a CodeSandbox credential survives and a Nodepod mount prefix
 * is not replaced. A second copy of that rule in this file would re-derive both of those live defects.
 */
import { describe, expect, it } from 'vitest';
import type { PreviewInfo } from '~/lib/stores/previews';
import { previewUrlForProjectFile, selectPreviewBaseUrl } from './project-file-url';

/**
 * The two roots `SANDBOX_PROVIDER_TRAITS` ships today, written out because a spec asserting a value
 * must not import the thing it is pinning. That they still match the traits table is asserted by
 * `sandbox-runtime.spec.ts` against `SANDBOX_ROOTS`, not by this file.
 */
const NODEPOD_WORKDIR = '/home/project';
const CODESANDBOX_WORKDIR = '/project/workspace';

const BASE = 'https://sb1-5173.csb.app';

const preview = (over: Partial<PreviewInfo> = {}): PreviewInfo => ({
  port: 5173,
  ready: true,
  baseUrl: BASE,
  ...over,
});

describe('previewUrlForProjectFile', () => {
  /*
   * 🔴 `public/` is Vite's `publicDir`: it is served at the ROOT of the preview, so the prefix must be
   * stripped. Leaving it on produces `<base>/public/assets/…`, which 404s — and a 404 on an <img> is a
   * broken-image icon, not an error anyone can trace back to this function.
   */
  it('serves a public/ file from the preview root', () => {
    const url = previewUrlForProjectFile(`${NODEPOD_WORKDIR}/public/assets/generated/hero.jpg`, BASE, NODEPOD_WORKDIR);

    expect(new URL(url!).pathname).toBe('/assets/generated/hero.jpg');
  });

  /*
   * The match is on exactly the FIRST segment. A `startsWith('public')` (no slash) eats `publicity/`,
   * and an `includes('public/')` eats `src/public/` — both are ordinary project files that must go
   * through `/@fs`, and both would silently resolve to a path the dev server does not serve.
   */
  it('strips public/ only as a leading segment', () => {
    expect(new URL(previewUrlForProjectFile('src/public/x.png', BASE, NODEPOD_WORKDIR)!).pathname).toBe(
      '/@fs/home/project/src/public/x.png',
    );
    expect(new URL(previewUrlForProjectFile('publicity/x.png', BASE, NODEPOD_WORKDIR)!).pathname).toBe(
      '/@fs/home/project/publicity/x.png',
    );
  });

  /** Everything outside `public/` goes through Vite's `/@fs/<sandbox-absolute path>` door. */
  it('serves a src/ file through the /@fs door', () => {
    expect(new URL(previewUrlForProjectFile(`${NODEPOD_WORKDIR}/src/tex/x.png`, BASE, NODEPOD_WORKDIR)!).pathname).toBe(
      '/@fs/home/project/src/tex/x.png',
    );
  });

  /*
   * `null` is a real answer, not a failure: with no preview up there is nothing to point at, and FR-4's
   * named "start the dev server" state is the honest render. `''` matters as much as `undefined` — an
   * empty base is what a provider reports mid-boot, and `new URL('')` throws.
   */
  it('answers null when there is no preview to point at', () => {
    expect(previewUrlForProjectFile('public/a.png', undefined, NODEPOD_WORKDIR)).toBeNull();
    expect(previewUrlForProjectFile('public/a.png', '', NODEPOD_WORKDIR)).toBeNull();
  });

  /** A base's trailing slash is cosmetic; two spellings of one preview must not produce two URLs. */
  it('produces the identical URL with or without a trailing slash on the base', () => {
    expect(previewUrlForProjectFile('public/a.png', `${BASE}/`, NODEPOD_WORKDIR)).toBe(
      previewUrlForProjectFile('public/a.png', BASE, NODEPOD_WORKDIR),
    );
  });

  /*
   * 🔴 THE CREDENTIAL. A CodeSandbox preview base carries `?preview_token=…`, so string-appending glues
   * the path onto the QUERY (`…token=abc/assets/x.png`) and breaks the route and the token at once. The
   * visible symptom is a 401 page, which reads as "the preview broke".
   */
  it('keeps a CodeSandbox preview token intact instead of gluing the path onto the query', () => {
    const url = previewUrlForProjectFile(
      `${CODESANDBOX_WORKDIR}/public/assets/x.png`,
      `${BASE}/?preview_token=abc`,
      CODESANDBOX_WORKDIR,
    );
    const parsed = new URL(url!);

    expect(parsed.pathname).toBe('/assets/x.png');
    expect(parsed.searchParams.get('preview_token')).toBe('abc');
    expect(url).not.toContain('preview_token=abc/');
  });

  /*
   * 🔴 THE MOUNT PREFIX. Nodepod serves previews SAME-ORIGIN at `/__virtual__/<pod>/<port>`, so a
   * root-absolute path replaces the mount and points at the BUILDER page rather than the game — the
   * defect `previewUrlWithPath` was fixed for, which this module must not re-derive.
   */
  it('appends under a Nodepod mount prefix instead of replacing it', () => {
    const url = previewUrlForProjectFile(
      'public/assets/x.png',
      'https://app.example/__virtual__/pod/5173',
      NODEPOD_WORKDIR,
    );

    expect(new URL(url!).pathname).toBe('/__virtual__/pod/5173/assets/x.png');
  });

  /*
   * The FileMap is keyed sandbox-ABSOLUTE, but callers (artifact paths, hand-typed inputs) carry the
   * relative form. Both spellings name one file, so both must resolve to one URL — the idempotence
   * `toProjectRelativePath` is built to provide.
   */
  it('is idempotent between the absolute and project-relative spellings of one file', () => {
    for (const relative of ['public/a.png', 'src/a.png']) {
      expect(previewUrlForProjectFile(relative, BASE, NODEPOD_WORKDIR)).toBe(
        previewUrlForProjectFile(`${NODEPOD_WORKDIR}/${relative}`, BASE, NODEPOD_WORKDIR),
      );
    }
  });

  describe('the workdir is the PROVIDER’s, never a literal', () => {
    it('uses the CodeSandbox root for a CodeSandbox project', () => {
      expect(
        new URL(previewUrlForProjectFile(`${CODESANDBOX_WORKDIR}/src/a.png`, BASE, CODESANDBOX_WORKDIR)!).pathname,
      ).toBe('/@fs/project/workspace/src/a.png');
    });

    /*
     * A map key can outlive the provider that wrote it — a working copy (§4.5.4c) written under one
     * runtime is restored into a project on another, and its keys still carry the old root. Rebasing is
     * what makes that survivable instead of a `/@fs` path nothing on this disk matches.
     */
    it('rebases a key carrying the OTHER provider’s root', () => {
      expect(
        new URL(previewUrlForProjectFile(`${CODESANDBOX_WORKDIR}/src/a.png`, BASE, NODEPOD_WORKDIR)!).pathname,
      ).toBe('/@fs/home/project/src/a.png');
      expect(
        new URL(previewUrlForProjectFile(`${NODEPOD_WORKDIR}/src/a.png`, BASE, CODESANDBOX_WORKDIR)!).pathname,
      ).toBe('/@fs/project/workspace/src/a.png');
    });
  });

  /*
   * CONTROLS. Every assertion above is of the shape "this input yields a URL ending in that path" — and
   * every one of them passes for a function that ignores its arguments and returns one constant string.
   * These two are the only tests in this file that can tell the difference.
   */
  describe('CONTROLS — the arguments are load-bearing', () => {
    it('CONTROL: the baseUrl reaches the result (a constant-returning impl fails here)', () => {
      const a = previewUrlForProjectFile('public/a.png', 'https://one.example', NODEPOD_WORKDIR);
      const b = previewUrlForProjectFile('public/a.png', 'https://two.example', NODEPOD_WORKDIR);

      expect(a).not.toBe(b);
      expect(new URL(a!).origin).toBe('https://one.example');
      expect(new URL(b!).origin).toBe('https://two.example');
    });

    it('CONTROL: the filePath reaches the result', () => {
      expect(previewUrlForProjectFile('public/a.png', BASE, NODEPOD_WORKDIR)).not.toBe(
        previewUrlForProjectFile('public/b.png', BASE, NODEPOD_WORKDIR),
      );
    });
  });
});

describe('selectPreviewBaseUrl', () => {
  it('answers undefined when there are no previews at all', () => {
    expect(selectPreviewBaseUrl([])).toBeUndefined();
  });

  /*
   * Deliberately stricter than `Preview.tsx`, which does not filter on `ready` — right for an iframe
   * (a booting server beats a blank pane) and wrong here, where every `<img>` on the page would 404.
   */
  it('answers undefined while every preview is still booting', () => {
    expect(selectPreviewBaseUrl([preview({ ready: false }), preview({ port: 4000, ready: false })])).toBeUndefined();
  });

  /* `find`, not `[0]`: the first entry is routinely a port that has not come up yet. */
  it('picks the first READY preview, not the first preview', () => {
    expect(
      selectPreviewBaseUrl([
        preview({ port: 4000, ready: false, baseUrl: 'https://booting.example' }),
        preview({ baseUrl: 'https://serving.example' }),
      ]),
    ).toBe('https://serving.example');
  });

  /* A ready preview with no URL is not something that can be pointed at; `new URL('')` throws. */
  it('skips a ready preview that reports no baseUrl', () => {
    expect(selectPreviewBaseUrl([preview({ baseUrl: '' }), preview({ port: 4000 })])).toBe(BASE);
  });
});
