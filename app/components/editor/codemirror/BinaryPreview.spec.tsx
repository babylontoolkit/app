// @vitest-environment jsdom
/**
 * What a binary file looks like in Code view (SPEC §4.1b, T4).
 *
 * Behavioural, not structural: the REAL component is mounted with the real `previewUrlForProjectFile`,
 * `mediaKindForPath` and `withCacheBuster` behind it. Only `workbenchStore` is doubled, because
 * importing it for real boots a sandbox and a file watcher — the established shape from
 * `creation-celebration.spec.tsx` / `model-tier-wire.spec.tsx`.
 *
 * 🔴 **The `src` assertions are the point, and both halves of AC-9 are load-bearing.** The whole design
 * is "point an element at the running dev server, read no bytes" — so it is not enough that a `<video>`
 * appears; its `src` must be an `http(s)` URL and must NOT be a `blob:`. A test asserting only that an
 * element rendered goes green for a re-added Blob design, which is the specific regression this exists
 * to catch (the doc comment on `project-file-url.ts` lists what reverting would cost: HTTP range
 * requests, no revoke-on-unmount leak, no detached-ArrayBuffer class).
 *
 * ⚠️ Likewise the retry test asserts the SHAPE of the cache buster, not merely that the src changed.
 * `` `${url}?t=${n}` `` changes the src too — and destroys a CodeSandbox `?preview_token=…`, so the
 * retry 401s. "It is different" is true for the broken spelling; "the token survived and there is one
 * `?`" is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ------------------------------------------------------------------ the workbench double */

/**
 * The workbench double — REAL `atom()`s, because the component reads `previews` through `useStore`.
 *
 * `workbenchStore` cannot be imported for real in a unit test: importing it boots a sandbox and a file
 * watcher. The atoms are minted inside the (async) mock factory and hung on a hoisted holder, which is
 * what lets the test body reach them — the factory runs when `./BinaryPreview` is first imported, and a
 * plain module-scope `const` is not initialised yet at that moment.
 *
 * `files` is read NON-reactively by the component (`.get()` only, so the watcher's mount storm cannot
 * re-render it), but it is still an atom here so the double matches the real store's surface rather
 * than a tidier one.
 */
const workbench = vi.hoisted(
  () => ({}) as { previews: import('nanostores').WritableAtom<any[]>; files: import('nanostores').WritableAtom<any> },
);

vi.mock('~/lib/stores/workbench', async () => {
  const { atom } = await import('nanostores');

  workbench.previews = atom<any[]>([]);
  workbench.files = atom<Record<string, any>>({});

  return { workbenchStore: workbench };
});

import { BinaryPreview } from './BinaryPreview';
import { WORK_DIR } from '~/utils/constants';

/* ------------------------------------------------------------------------------- fixtures */

/** A ready preview on a plain host — the Nodepod/WebContainer shape. */
const READY = { port: 5173, ready: true, baseUrl: 'https://preview.example.dev' };

/** The CodeSandbox shape: the base carries a CREDENTIAL in its query (AC-10's whole reason). */
const READY_WITH_TOKEN = { port: 5173, ready: true, baseUrl: 'https://sb1-5173.csb.app?preview_token=abc' };

/** A `FileMap`-shaped binary entry — content is ALWAYS empty for a binary (`spec/binary-files.md`). */
const binary = (size: number) => ({ type: 'file' as const, content: '', isBinary: true, size });

/**
 * A `FileMap`-shaped TEXT entry — the SVG case, where `content` really is the file.
 *
 * Kept as its own helper rather than a flag on `binary()` because the difference is the whole point of
 * `sourceAvailable`: this is the only shape in the file map that has something behind the preview.
 */
const text = (size: number, content = '<svg xmlns="http://www.w3.org/2000/svg" />') => ({
  type: 'file' as const,
  content,
  isBinary: false,
  size,
});

/** Keys are sandbox-ABSOLUTE, which is what `doc.filePath` carries off the editor. */
const path = (relative: string) => `${WORK_DIR}/${relative}`;

function givenProject(previews: any[], files: Record<string, any>) {
  workbench.previews.set(previews);
  workbench.files.set(files);
}

/** Every element this component can draw — the "no media at all" assertions read off this list. */
function mediaElements(container: HTMLElement) {
  return container.querySelectorAll('img, video, audio');
}

beforeEach(() => {
  workbench.previews.set([]);
  workbench.files.set({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------------- the tests */

describe('BinaryPreview — no preview (FR-4, AC-1)', () => {
  it('names the state and renders NO media element', () => {
    givenProject([], { [path('public/hero.png')]: binary(1024) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    expect(screen.getByText('Start the dev server to preview this file.')).toBeInTheDocument();

    /*
     * The explicit absence is the assertion that matters. A component that renders `<img src="">`
     * alongside the sentence satisfies the text check and shows the user a broken-image icon — which is
     * exactly the outcome FR-4's named state exists to replace.
     */
    expect(container.querySelector('img')).toBeNull();
    expect(mediaElements(container)).toHaveLength(0);
  });

  it('an UN-READY preview is not a preview', () => {
    // `selectPreviewBaseUrl` filters on `ready` deliberately: a booting server 404s every <img>.
    givenProject([{ port: 5173, ready: false, baseUrl: 'https://preview.example.dev' }], {
      [path('public/hero.png')]: binary(1024),
    });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    expect(screen.getByText('Start the dev server to preview this file.')).toBeInTheDocument();
    expect(mediaElements(container)).toHaveLength(0);
  });
});

describe('BinaryPreview — the rendered kinds (FR-2, AC-2/3/4)', () => {
  it('a .png renders an <img> pointed at the resolved http URL', () => {
    givenProject([READY], { [path('public/hero.png')]: binary(2048) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();

    /*
     * 🔴 EXACTLY ONE. Each kind test below asks only for its own tag, so a component that dropped its
     * `kind === …` guards and drew an <img>, a <video> AND an <audio> on every file would satisfy all
     * three — the "a test asserting png is an image passes for a function that calls everything an
     * image" control, one layer up in the component. Found by mutation, not by reading.
     */
    expect(mediaElements(container)).toHaveLength(1);

    // `public/` is served at the preview ROOT, so the prefix is stripped.
    expect(img).toHaveAttribute('src', 'https://preview.example.dev/hero.png');
    expect(img!.getAttribute('src')).toMatch(/^https?:/);
    expect(img!.getAttribute('src')).not.toMatch(/^blob:/);
  });

  it('a non-public image goes through Vite’s /@fs door', () => {
    givenProject([READY], { [path('src/assets/logo.webp')]: binary(500) });

    const { container } = render(<BinaryPreview filePath={path('src/assets/logo.webp')} />);

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      `https://preview.example.dev/@fs${WORK_DIR}/src/assets/logo.webp`,
    );
  });

  it('an .mp4 renders a <video> with controls — and AC-9: an http src, never a blob:', () => {
    givenProject([READY], { [path('public/clip.mp4')]: binary(200 * 1024 * 1024) });

    const { container } = render(<BinaryPreview filePath={path('public/clip.mp4')} />);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(mediaElements(container)).toHaveLength(1); // see the <img> test — the kind guards are load-bearing
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');

    /*
     * AC-9, BOTH halves. The positive alone passes for a design that also mints a Blob somewhere; the
     * negative alone passes for `src=""`. Together they pin "the element is fed by the dev server".
     */
    const src = video!.getAttribute('src')!;
    expect(src).toMatch(/^https?:/);
    expect(src).not.toMatch(/^blob:/);
  });

  it('an .mp3 renders an <audio> with controls', () => {
    givenProject([READY], { [path('public/theme.mp3')]: binary(4096) });

    const { container } = render(<BinaryPreview filePath={path('public/theme.mp3')} />);

    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(mediaElements(container)).toHaveLength(1); // see the <img> test — the kind guards are load-bearing
    expect(audio).toHaveAttribute('controls');
    expect(audio!.getAttribute('src')).toMatch(/^https?:/);
    expect(audio!.getAttribute('src')).not.toMatch(/^blob:/);
  });

  it('the caption names dimensions and size once the element reports them (OQ-4)', () => {
    givenProject([READY], { [path('public/hero.png')]: binary(2048) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);
    const img = container.querySelector('img')!;

    // jsdom never loads media, so the natural dimensions have to be supplied and the event fired.
    Object.defineProperty(img, 'naturalWidth', { value: 1920, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1080, configurable: true });
    fireEvent.load(img);

    expect(screen.getByText('1920 × 1080 · 2.0 KB')).toBeInTheDocument();
  });
});

describe('BinaryPreview — the named fallbacks (FR-3, AC-5/6)', () => {
  it('havok.wasm renders NO element and names both the type and the size', () => {
    givenProject([READY], { [path('public/havok.wasm')]: binary(2 * 1024 * 1024) });

    const { container } = render(<BinaryPreview filePath={path('public/havok.wasm')} />);

    expect(mediaElements(container)).toHaveLength(0);

    /*
     * BOTH facts in one sentence, asserted from the rendered text rather than by calling
     * `describeUnrenderable` — a test that re-derives the string from the same function it is checking
     * cannot notice the component rendering something else entirely.
     */
    const text = container.textContent ?? '';
    expect(text).toContain('WebAssembly');
    expect(text).toContain('2.0 MB');
  });

  it('a zero-byte file shows the empty-file sentence and requests nothing', () => {
    givenProject([READY], { [path('public/hero.png')]: binary(0) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    expect(screen.getByText('Empty file')).toBeInTheDocument();

    /*
     * "Issues no request" is observable here only as "no element exists to issue one" — which is the
     * mechanism itself: this component never fetches, it points elements at a URL, so an `<img src>` in
     * the document IS the request.
     */
    expect(mediaElements(container)).toHaveLength(0);
  });
});

/*
 * ── THE SOURCE TOGGLE (owner, 2026-08-15: *"let make svg show up a render image like other images"*) ──
 *
 * SVG is the one file this viewer draws that is TEXT, so it is the one file where covering the editor
 * takes something away. The toggle is what makes the preview a DEFAULT rather than the only option —
 * `icons.svg` in the starter is hand-edited markup, and a viewer that replaces an editor is a feature
 * while one that removes it is a regression.
 *
 * The mechanism is that the editor is never unmounted, only COVERED: `BinaryPreview` is an absolutely
 * positioned overlay drawn as a sibling of the live CodeMirror container. So "show me the source" is
 * implemented by rendering no overlay at all — which is why the assertions below are about the ABSENCE
 * of the shell, not about any text this component renders.
 */
describe('BinaryPreview — the Source toggle', () => {
  const SVG = path('public/icons.svg');
  const OTHER_SVG = path('public/logo.svg');

  const source = () => screen.queryByRole('button', { name: 'Source' });
  const preview = () => screen.queryByRole('button', { name: 'Preview' });

  it('a binary gets NO Source button — there is nothing behind it (§4.1a: no dead ends)', () => {
    givenProject([READY], { [path('public/hero.png')]: binary(2048) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    /*
     * 🔴 THE ABSENCE IS THE ASSERTION. `CodeMirrorEditor`'s document effect returns early on
     * `doc.isBinary`, so the CodeMirror underneath a binary was NEVER populated — a Source button here
     * reveals an empty editor and cannot be got out of except by reselecting the file. A permanently
     * inert control is a dead end, not a roadmap (§4.1a, the "Coming Soon" menu row).
     */
    expect(source()).toBeNull();
    expect(preview()).toBeNull();

    /* And the preview itself is unaffected — this is a missing button, not a missing feature. */
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('an explicit sourceAvailable={false} is the same as omitting it', () => {
    /* The default lives in the signature; this pins that the explicit spelling agrees with it. */
    givenProject([READY], { [path('public/clip.mp4')]: binary(4096) });

    render(<BinaryPreview filePath={path('public/clip.mp4')} sourceAvailable={false} />);

    expect(source()).toBeNull();
    expect(preview()).toBeNull();
  });

  it('an .svg renders BOTH the image and a Source button', () => {
    givenProject([READY], { [SVG]: text(1024) });

    const { container } = render(<BinaryPreview filePath={SVG} sourceAvailable />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://preview.example.dev/icons.svg');

    /* Rendered by the dev server like every other image — no bytes read, no blob: minted (AC-9). */
    expect(img!.getAttribute('src')).toMatch(/^https?:/);
    expect(img!.getAttribute('src')).not.toMatch(/^blob:/);

    expect(source()).toBeInTheDocument();
    expect(preview()).toBeNull();
  });

  it('clicking Source removes the overlay entirely, leaving only the way back', () => {
    givenProject([READY], { [SVG]: text(1024) });

    const { container } = render(<BinaryPreview filePath={SVG} sourceAvailable />);

    fireEvent.click(source()!);

    /*
     * 🔴 EVERY media element is gone, not just the <img>. An overlay that keeps drawing while the user
     * reads the markup is the failure this component is one half of — the editor is underneath, and
     * anything painted over it is in the way.
     */
    expect(mediaElements(container)).toHaveLength(0);
    expect(container.querySelector('img')).toBeNull();

    /*
     * And the SHELL is gone with it — asserted as "the only thing rendered is the button" rather than
     * by class name, because the shell is what covers the editor: a component that hid the <img> but
     * kept the opaque full-bleed panel would satisfy every assertion above and still show the user a
     * blank rectangle where their SVG source should be.
     */
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('BUTTON');

    expect(preview()).toBeInTheDocument();
    expect(source()).toBeNull();
  });

  it('clicking Preview brings the image back', () => {
    givenProject([READY], { [SVG]: text(1024) });

    const { container } = render(<BinaryPreview filePath={SVG} sourceAvailable />);

    fireEvent.click(source()!);
    fireEvent.click(preview()!);

    expect(container.querySelector('img')).toHaveAttribute('src', 'https://preview.example.dev/icons.svg');
    expect(mediaElements(container)).toHaveLength(1);
    expect(source()).toBeInTheDocument();
    expect(preview()).toBeNull();
  });

  it('🔴 changing filePath while in source mode RESETS to the preview', () => {
    givenProject([READY], { [SVG]: text(1024), [OTHER_SVG]: text(2048) });

    const { container, rerender } = render(<BinaryPreview filePath={SVG} sourceAvailable />);

    fireEvent.click(source()!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<BinaryPreview filePath={OTHER_SVG} sourceAvailable />);

    /*
     * 🔴 Same class as the error reset one block down, and the same reasoning: "I wanted to read THIS
     * file's markup" is a statement about ONE file. Carried forward, it silently opens the next SVG the
     * user clicks as raw markup — they asked to see a picture and got angle brackets, with the only
     * clue a small button in the corner. The failure is invisible in the component and visible only as
     * the product behaving oddly two clicks later.
     */
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://preview.example.dev/logo.svg');
    expect(mediaElements(container)).toHaveLength(1);
    expect(source()).toBeInTheDocument();
    expect(preview()).toBeNull();
  });

  it('the toggle survives the named fallback states — it is not gated on a preview existing', () => {
    /*
     * A dev server that is not up is exactly when reading the markup is the only thing left to do, so
     * the way to the source must not be a casualty of the FR-4 state. This is the inverse of the
     * dead-end rule: the button is offered wherever there IS source, and only there.
     */
    givenProject([], { [SVG]: text(1024) });

    render(<BinaryPreview filePath={SVG} sourceAvailable />);

    expect(screen.getByText('Start the dev server to preview this file.')).toBeInTheDocument();
    expect(source()).toBeInTheDocument();

    fireEvent.click(source()!);
    expect(screen.queryByText('Start the dev server to preview this file.')).toBeNull();
    expect(preview()).toBeInTheDocument();
  });
});

/*
 * ── THE ICON-SPRITE NOTE (measured 2026-08-15) ────────────────────────────────────────────────────
 *
 * An icon-sprite SVG renders as genuinely NOTHING — its `<symbol>` shapes draw only where a `<use>`
 * references them — and a correct blank pane is indistinguishable from a broken viewer. Measured on the
 * starter's own files by decoding rendered pixels: `vite.svg` 51.8% non-transparent, `react.svg` 41.8%,
 * `icons.svg` **0%**.
 *
 * So this is FR-3's rule one format down: name what you found rather than showing an empty box. The
 * note is a CAPTION on the preview, not a fallback state — the `<img>` is still correct, still pointed
 * at the dev server, and still the thing being explained.
 */
describe('BinaryPreview — the icon-sprite note (FR-3, one format down)', () => {
  const SPRITE = path('public/icons.svg');
  const PLAIN = path('public/vite.svg');

  /** The shape the starter's own `icons.svg` has: definitions only, nothing drawn. */
  const SPRITE_SOURCE =
    '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="play" viewBox="0 0 16 16">' +
    '<path d="M4 2l10 6-10 6z"/></symbol></svg>';

  /** An ordinary SVG — the same file type, drawing real pixels. */
  const PLAIN_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="4"/></svg>';

  const note = () => screen.queryByText('Icon sprite — its <symbol> shapes draw only where a <use> references them.');

  it('an SVG of <symbol> definitions renders the image AND says why it looks empty', () => {
    givenProject([READY], { [SPRITE]: text(1024, SPRITE_SOURCE) });

    const { container } = render(<BinaryPreview filePath={SPRITE} sourceAvailable />);

    /*
     * BOTH halves. The note is an explanation of the preview, not a replacement for it — a component
     * that swapped the sprite for a sentence would be a fallback state, and the whole point is that
     * this file previews correctly and the correct preview is blank.
     */
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://preview.example.dev/icons.svg');
    expect(note()).toBeInTheDocument();
  });

  it('🔴 CONTROL: an ordinary SVG renders the image and NO note', () => {
    /*
     * 🔴 THE CONTROL THAT MATTERS. The test above passes for a note rendered unconditionally — at which
     * point every SVG in the project carries an explanation that is FALSE for most of them (measured:
     * `vite.svg` and `react.svg` draw 51.8% and 41.8% of their pixels). A caption that misdescribes what
     * the user is looking at is worse than no caption: it teaches them to distrust the one case where it
     * is true, and nothing throws.
     *
     * Mutation-verified 2026-08-15: `isSpriteSheet` returning `true` unconditionally fails this and
     * nothing else in the repo.
     */
    givenProject([READY], { [PLAIN]: text(512, PLAIN_SOURCE) });

    const { container } = render(<BinaryPreview filePath={PLAIN} sourceAvailable />);

    expect(container.querySelector('img')).not.toBeNull();
    expect(note()).toBeNull();
  });

  it('a binary never shows the note — its content is empty by design', () => {
    /*
     * `spec/binary-files.md`: `File.content` is ALWAYS empty when `isBinary`, and the map carries only
     * `isBinary` + `size`. So this pins two things at once — the note is scoped to the text media, and
     * the component is not reaching for bytes it is structurally forbidden from having (the AC-5 rule
     * `binary-preview-guards.spec.ts` enforces at source level).
     *
     * ⚠️ HONEST SCOPE: this passes whether or not the `!entry.isBinary` guard is present, because an
     * empty string is falsy and `isSpriteSheet('')` is false either way. It pins the OUTCOME for every
     * fixture the contract permits; the guard itself is pinned one test down.
     */
    givenProject([READY], { [path('public/hero.png')]: binary(2048) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    expect(container.querySelector('img')).not.toBeNull();
    expect(note()).toBeNull();
  });

  it('the note is scoped by the isBinary FLAG, not merely by content being empty (defense in depth)', () => {
    /*
     * ⚠️ **THE FIXTURE BELOW IS IMPOSSIBLE BY CONTRACT — that is the point, and it must not be read as
     * documentation that binaries can carry content.** `spec/binary-files.md` makes `content` empty for
     * every `isBinary` entry, so no realistic fixture can distinguish `!entry.isBinary && content` from
     * `content` alone, and the guard is genuinely unreachable today.
     *
     * It is pinned anyway because the guard is the cheap half of a rule this repo has watched break
     * before: an ingest path that starts populating `content` on a binary entry is exactly the
     * §1.3-principle-10 corruption the binary spec exists to prevent, and if it ever happens the guard
     * is what stops this component sniffing markup out of a PNG's bytes. Asserting it here means the
     * guard cannot be deleted as dead code by someone who reasonably concludes it is redundant —
     * without this, that deletion is invisible to all 6,900 tests.
     *
     * What this does NOT claim: that the guard is reachable, or that this is a scenario a user can
     * produce. It asserts a defensive branch against a deliberately malformed entry, nothing more.
     */
    const impossible = { type: 'file' as const, content: '<svg><symbol id="x"/></svg>', isBinary: true, size: 2048 };

    givenProject([READY], { [path('public/hero.png')]: impossible });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    expect(container.querySelector('img')).not.toBeNull();
    expect(note()).toBeNull();
  });

  it('the note belongs to the PREVIEW — gone in source mode, back on return', () => {
    givenProject([READY], { [SPRITE]: text(1024, SPRITE_SOURCE) });

    render(<BinaryPreview filePath={SPRITE} sourceAvailable />);

    expect(note()).toBeInTheDocument();

    /*
     * In source mode the user is reading the very markup the note describes — the `<symbol>` elements
     * are right there on screen — so an explanation of why the picture looks empty is both redundant
     * and, since no picture is being shown, wrong. It is part of the overlay and goes with it.
     */
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(note()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(note()).toBeInTheDocument();
  });

  it('the note sits alongside the dimensions caption rather than replacing it (OQ-4)', () => {
    /*
     * Two captions, two facts. The sprite note explains the blankness; the OQ-4 caption still has to say
     * what the file IS — an implementation that returned early on a sprite would silently drop the size
     * for exactly the files the user is most confused about.
     */
    givenProject([READY], { [SPRITE]: text(1024, SPRITE_SOURCE) });

    const { container } = render(<BinaryPreview filePath={SPRITE} sourceAvailable />);
    const img = container.querySelector('img')!;

    Object.defineProperty(img, 'naturalWidth', { value: 24, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 24, configurable: true });
    fireEvent.load(img);

    expect(screen.getByText('24 × 24 · 1.0 KB')).toBeInTheDocument();
    expect(note()).toBeInTheDocument();
  });
});

describe('BinaryPreview — failure and retry (FR-6, AC-7/8/10)', () => {
  it('an error swaps to the reason plus a Retry button, and Retry re-mints a DIFFERENT src', () => {
    givenProject([READY], { [path('public/hero.png')]: binary(2048) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    const first = container.querySelector('img')!.getAttribute('src');
    fireEvent.error(container.querySelector('img')!);

    expect(screen.getByText('Could not load this file from the dev server.')).toBeInTheDocument();
    expect(mediaElements(container)).toHaveLength(0);

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);

    const second = container.querySelector('img')!.getAttribute('src');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second).toMatch(/^https?:/);
  });

  it('AC-10: Retry keeps the preview credential and never adds a second "?"', () => {
    givenProject([READY_WITH_TOKEN], { [path('public/hero.png')]: binary(2048) });

    const { container } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    const before = container.querySelector('img')!.getAttribute('src')!;
    expect(before).toContain('preview_token=abc');

    fireEvent.error(container.querySelector('img')!);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const after = container.querySelector('img')!.getAttribute('src')!;

    /*
     * 🔴 The naive `` `${url}?t=1` `` passes "the src changed" and fails BOTH of these: it produces
     * `…?preview_token=abc?t=1`, where the token is now part of a garbage query value and the retry
     * 401s on CodeSandbox. This is the assertion that distinguishes the URL API from string concat.
     */
    expect(after).toContain('preview_token=abc');
    expect(after.split('?')).toHaveLength(2);
    expect(after).toContain('t=1');
    expect(after).not.toBe(before);
  });

  it('AC-8: changing filePath after an error CLEARS the error', () => {
    givenProject([READY], {
      [path('public/hero.png')]: binary(2048),
      [path('public/other.png')]: binary(4096),
    });

    const { container, rerender } = render(<BinaryPreview filePath={path('public/hero.png')} />);

    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByText('Could not load this file from the dev server.')).toBeInTheDocument();

    rerender(<BinaryPreview filePath={path('public/other.png')} />);

    /*
     * A failure belongs to ONE file at ONE URL. Without the reset a single transient 404 poisons every
     * later file in the session — the user clicks a good PNG and is told the dev server is unreachable.
     */
    expect(screen.queryByText('Could not load this file from the dev server.')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://preview.example.dev/other.png');
  });
});
