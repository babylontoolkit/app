/**
 * The header toolbar's button style — ONE definition, used by every control in the row.
 *
 * ## Why this is a shared constant and not "just Tailwind classes"
 *
 * The toolbar was assembled one feature at a time over about a dozen changes, and every button brought
 * its own copy of a class string. They drifted, quietly and completely: some had a border and some did
 * not, some were accent-filled, some had a background tint and some were transparent, the paddings were
 * `px-3 py-1.5` in most places and `px-2 py-1` in others, and one group had `rounded-l-md`/`rounded-r-md`
 * left over from a segmented pair that no longer existed. Nothing was broken and every button was
 * individually defensible, which is exactly why it survived: a style only looks wrong NEXT TO the others,
 * and nothing in a code review shows you the row.
 *
 * A duplicated string cannot be kept consistent by intention — only by not being duplicated. So the
 * style lives here and the buttons reference it. A new control gets the row's look by importing it, and
 * changing the row's look is one edit rather than a hunt.
 *
 * ## The one deliberate exception
 *
 * `GitStatusChip` does NOT use these. It is the only element in the header carrying STATE rather than an
 * action, and §4.5.4b requires the unsynced state to be loud (amber) while the synced state is quiet —
 * an asymmetry that is the whole point of the badge and cannot be expressed in a uniform style. Every
 * other control here is an action and looks identical.
 */

/**
 * The row's shared SHAPE — geometry, border, transition, disabled state. No colour, no hover.
 *
 * Split out so a filled control can be built from the same shape WITHOUT inheriting the quiet hover
 * it has to override. That is not a style preference, it is a correctness requirement: when two
 * classes set the same property, the winner is decided by **rule order in the generated stylesheet**,
 * not by the order of the class string. Measured here — UnoCSS emits
 * `.hover\:bg-bolt-elements-button-primary-backgroundHover:hover` BEFORE `.hover\:bg-white\/10:hover`,
 * so composing `TOOLBAR_ICON_BUTTON + <accent hover>` lets the quiet hover win and the filled ⋯ button
 * loses its fill the moment you point at it. Composition is fine for properties the base never sets;
 * for the ones it does, the variant must not include the base at all.
 */
const TOOLBAR_SHAPE =
  'flex items-center justify-center h-7 rounded-md border border-white/15 ' +
  'transition-colors outline-none disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The row's shared FILL and hover (owner, 2026-08-02).
 *
 * The controls used to be transparent with only a `border-white/15` outline. That held while the bar
 * was the dark `--chrome-gradient`; once the workspace half was lightened
 * (`--chrome-gradient-workspace`, mid stop `#6a44b8`) the outline sat at nearly the same value as the
 * bar behind it and the buttons stopped reading as buttons. A darker fill gives every control a body
 * of its own instead of relying on a hairline to carry it.
 *
 * Both colours are CSS vars declared next to the bar's own gradients in `index.scss`, because "is
 * this darker than the header?" is a question about the PAIR — putting the hex here would let the two
 * drift the next time the bar is retoned, and nothing would notice.
 *
 * ⚠️ NOT folded into `TOOLBAR_SHAPE`. The shape is shared with `TOOLBAR_ICON_BUTTON_FILLED`, and two
 * background declarations on one element is exactly the stylesheet-ordering hazard documented there —
 * the variant must not inherit a background the base already set.
 */
const TOOLBAR_FILL = 'bg-[var(--toolbar-button-fill)] hover:bg-[var(--toolbar-button-fill-hover)]';

/** A labelled button: icon + text. The default for anything in the toolbar. */
export const TOOLBAR_BUTTON =
  `${TOOLBAR_SHAPE} gap-1.5 px-2.5 text-xs font-medium ` + `text-bolt-elements-textPrimary ${TOOLBAR_FILL}`;

/**
 * An icon-only button. Same height, same border, same hover as the labelled ones — only width differs.
 *
 * `w-9` is a FIXED width, wider than the icon it holds, and both halves of that matter. Fixed, because
 * a shrink-to-fit control changes size with its glyph and the row stops looking like a set. Wider,
 * because a 28×28 square next to `px-2.5` labelled buttons reads as a different, smaller kind of
 * control rather than the same button without a word in it.
 */
export const TOOLBAR_ICON_BUTTON = `${TOOLBAR_SHAPE} shrink-0 w-9 text-bolt-elements-textPrimary ${TOOLBAR_FILL}`;

/**
 * The FILLED icon button, reserved for the ⋯ main menu (owner decision, SPEC §4.1a).
 *
 * Fill is reserved for exactly two controls — the git chip when it has something to say, and this —
 * so it reliably means "the control worth noticing" rather than "some button happens to be on". The
 * workbench toggle deliberately does NOT use it. Same shape, same size, same border as every other
 * control: a filled button still reads as the same button.
 *
 * The colour is the **accent**, which is what the Share button wore before the toolbar rebuild
 * (`bg-accent-500` + `hover:bg-…button-primary-backgroundHover`, owner request 2026-07-22) — the
 * previous `bg-white/15` read as a grey smudge rather than a deliberate highlight.
 *
 * ⚠️ Built from `TOOLBAR_SHAPE`, NOT composed onto `TOOLBAR_ICON_BUTTON` — see the note there. The
 * base's `hover:bg-white/10` is emitted LATER in the stylesheet and would beat this hover, stripping
 * the fill on hover. Do not "simplify" this into `classNames(TOOLBAR_ICON_BUTTON, …)`.
 */
export const TOOLBAR_ICON_BUTTON_FILLED =
  `${TOOLBAR_SHAPE} shrink-0 w-9 ` + 'bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover';

/** Shared menu-item style, so the ⋯ menu and the git chip's menu cannot drift apart either. */
export const TOOLBAR_MENU_ITEM =
  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-bolt-elements-textPrimary ' +
  'hover:bg-bolt-elements-background-depth-3 cursor-pointer outline-none select-none';

/** Shared menu-surface style (the popup panel itself). */
export const TOOLBAR_MENU_CONTENT =
  'rounded-lg p-1.5 z-[1000] bg-bolt-elements-background-depth-2 ' +
  'border border-bolt-elements-borderColor shadow-lg animate-in fade-in-80 zoom-in-95';
