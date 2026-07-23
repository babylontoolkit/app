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

/** A labelled button: icon + text. The default for anything in the toolbar. */
export const TOOLBAR_BUTTON =
  'flex items-center justify-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-md ' +
  'border border-white/15 text-bolt-elements-textPrimary hover:bg-white/10 ' +
  'transition-colors outline-none disabled:opacity-50 disabled:cursor-not-allowed';

/** A square icon-only button. Same height, same border, same hover — only the width differs. */
export const TOOLBAR_ICON_BUTTON =
  'flex items-center justify-center h-7 w-7 rounded-md ' +
  'border border-white/15 text-bolt-elements-textPrimary hover:bg-white/10 ' +
  'transition-colors outline-none disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The FILLED look, reserved for the two controls that should stand out (owner decision, SPEC §4.1a):
 * the git chip (when it has something to say) and the ⋯ main menu. Everything else in the row is
 * bordered-only, even when "active" — the workbench toggle deliberately does NOT use this, so fill is a
 * reliable signal that means "the two controls worth noticing" rather than "some button happens to be
 * on". A fill, never a different border or shape: a filled control still reads as the same button.
 */
export const TOOLBAR_BUTTON_ACTIVE = 'bg-white/15 text-bolt-elements-textPrimary';

/** Shared menu-item style, so the ⋯ menu and the git chip's menu cannot drift apart either. */
export const TOOLBAR_MENU_ITEM =
  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-bolt-elements-textPrimary ' +
  'hover:bg-bolt-elements-background-depth-3 cursor-pointer outline-none select-none';

/** Shared menu-surface style (the popup panel itself). */
export const TOOLBAR_MENU_CONTENT =
  'rounded-lg p-1.5 z-[1000] bg-bolt-elements-background-depth-2 ' +
  'border border-bolt-elements-borderColor shadow-lg animate-in fade-in-80 zoom-in-95';
