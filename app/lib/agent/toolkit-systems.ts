/**
 * The "Toolkit systems" preference — built-in controllers vs. the model's own architecture (§4.4e).
 *
 * ## Why this exists
 *
 * Reported 2026-08-08: an identical "mario kart clone" prompt produced, on Fable 5, a Ford Mustang on
 * an open-terrain test map driven by simulation raycast vehicle physics — and on Opus 5, hand-written
 * movement that ignored the Toolkit's racing stack entirely. Same prompt, same prefix, opposite
 * results, and the owner could not steer either one. In their words: *"there are times when I do want
 * it to use the included interactive glTF script components and then there are times when I need it
 * to be creative itself and make its architecture."*
 *
 * That is a REQUEST FOR A CONTROL, not for better prompt wording. The prompt's "batteries-included
 * rule" can state a sensible default, but it cannot know which of those two moods the user is in, and
 * no amount of rewording will make it guess right every time.
 *
 * ## The shape, and why `auto` costs nothing
 *
 * Three settings, mirroring the §4.4d asset-library toggle end to end (per-user, localStorage, rides
 * in the agent request body, honored by ONE pure function the proxy calls):
 *
 *  - `prefer` — reach for `StandardCarController`, the player controllers and the interactive glTF
 *    script components wherever they plausibly fit.
 *  - `auto`   — **the default, and it emits NO BLOCK AT ALL.** The baked "batteries-included rule" in
 *    `20-hard-constraints.md` already states the balanced position ("a menu, not a mapping"), so the
 *    default behaviour is the absence of an override. This is deliberate: the common case must not
 *    pay a single token, and a note that merely restates the cached prompt would be pure waste on
 *    every turn forever (§4.2.8).
 *  - `own`    — author movement and architecture over `RigidbodyPhysics` + `ScriptComponent`.
 *
 * ## Never regress — each of these fails SILENTLY
 *
 *  - **An unrecognised value resolves to `auto`, never to a stronger setting.** This arrives in a
 *    BROWSER BODY. `parseToolkitSystems` is the `parseUserEffort` rule applied here: inventing a
 *    preference the user did not choose is the direction that quietly changes what their game is made
 *    of, so junk, absent and stale-client all land on the shipped default.
 *  - **`auto` returns `undefined`, not an empty string.** The caller pushes a system entry only when
 *    a block exists; an empty entry is a wasted message slot and, worse, reads as "configured" to
 *    anyone debugging the prompt.
 *  - **Neither override may claim a capability the model cannot check.** `prefer` says to LOAD the
 *    reference first and fall back to authoring if it cannot — see the fallback rule in
 *    `20-hard-constraints.md`. Telling the model to use an API it has no documentation for is how the
 *    invented-API failure happens, which our own prompt calls worse than not using the system at all.
 *  - **`own` must not forbid the INFRASTRUCTURE systems.** Physics, animation, navmesh, cameras,
 *    input, audio and netcode are plumbing; a preference for bespoke game feel is not a licence to
 *    reimplement Havok. The block says so explicitly, because "write your own architecture" read
 *    literally would do exactly that.
 *
 * PURE and exported, like `discussModeNote` and `assetLibraryIndexForRequest`, because both failure
 * modes are invisible: a leaked block overrides a choice the user made, and a wrongly-omitted one
 * silently returns them to the behaviour they just switched away from.
 *
 * ⚠️ **It lives OUTSIDE `~/lib/.server/**` on purpose**, beside `turn-outcome.ts`: the settings store
 * and the Features tab are client code and need the type and the parser, and the alternative is the
 * `MODEL_TIER_IDS` shape — the same union declared twice, once here and once client-side, which is
 * the two-writers drift this codebase keeps rediscovering. Safe to ship in the client bundle because
 * it is prompt text and a string union: no secrets, no privileged logic, nothing a browser must not
 * see (the `capabilities.ts` precedent, SPEC §4.2a).
 */

/** The three settings. Wire values — they are persisted and sent, so do not rename casually. */
export type ToolkitSystemsPreference = 'prefer' | 'auto' | 'own';

/**
 * The shipped default. `auto` means "the baked batteries-included rule governs" — the model judges
 * from the request whether a built-in controller matches the feel that was asked for.
 */
export const DEFAULT_TOOLKIT_SYSTEMS: ToolkitSystemsPreference = 'auto';

const VALID = new Set<string>(['prefer', 'auto', 'own']);

/**
 * Normalise an untrusted value to a setting.
 *
 * Absent, unknown, wrong-typed and stale-client values all resolve to `auto`. There is no clamping in
 * the other direction and there must never be: `prefer` and `own` both materially change what the
 * model builds, so they are only ever reached by an explicit, recognised choice.
 */
export function parseToolkitSystems(raw: unknown): ToolkitSystemsPreference {
  return typeof raw === 'string' && VALID.has(raw) ? (raw as ToolkitSystemsPreference) : DEFAULT_TOOLKIT_SYSTEMS;
}

const PREFER_BLOCK = [
  '# Toolkit systems — PREFER THE BUILT-INS (user preference)',
  '',
  "This user has asked you to lean on the Toolkit's ready-made systems for this project rather than",
  'design your own. Where one plausibly fits the request, use it:',
  '',
  '- Vehicles → the RacingSystem (`StandardCarController`, `VehicleInputController`,',
  '  `VehicleCameraManager`, `RaceTrackManager`, `CheckpointManager`).',
  '- Characters → `StandardPlayerController` / `ThirdPersonPlayerController` /',
  '  `TOOLKIT.CharacterController`.',
  '- Interactive content → the demo Script Components in `src/babylon/classes/`, copied into',
  '  `src/scripts/` and re-based (never edited in place).',
  '',
  '**Load the reference document for a system BEFORE you write against it** — you cannot write these',
  'APIs from memory, and inventing a method that does not exist is worse than not using the system.',
  'If you cannot load what you need, author that part yourself over `RigidbodyPhysics` and say so in',
  'your closing summary rather than guessing at the API.',
  '',
  'This preference is about ARCHITECTURE, not content: it does not authorise shipping a demo’s car,',
  'character or level. Build the assets the request asks for.',
].join('\n');

const OWN_BLOCK = [
  '# Toolkit systems — AUTHOR YOUR OWN ARCHITECTURE (user preference)',
  '',
  'This user wants the game designed from first principles for this project. Do NOT reach for the',
  "Toolkit's high-level controllers — `StandardCarController`, `StandardPlayerController`,",
  '`ThirdPersonPlayerController` and the ready-made demo Script Components — even where one would',
  'nominally fit. Their handling and structure are not what is wanted here.',
  '',
  'Write the movement, the game rules and the component structure yourself as `ScriptComponent`',
  'classes in `src/scripts/`, tuned to the feel the request describes.',
  '',
  '**This does NOT mean reimplementing infrastructure.** Physics (Havok / `RigidbodyPhysics`),',
  '`AnimationState`, `NavigationAgent`, `DefaultCameraSystem`, `InputController`, `AudioSource` and',
  'the networking stack are plumbing — keep using them, and build your own game logic on top. Writing',
  'a physics engine or an input layer by hand is a defect, not creativity.',
].join('\n');

/**
 * The per-request form — the ONE call the proxy makes.
 *
 * Returns `undefined` for `auto` (and for anything unrecognised, which resolves to `auto`), so the
 * default costs no tokens and the caller pushes nothing.
 */
export function toolkitSystemsNoteForRequest(raw: unknown): string | undefined {
  switch (parseToolkitSystems(raw)) {
    case 'prefer':
      return PREFER_BLOCK;
    case 'own':
      return OWN_BLOCK;
    default:
      return undefined;
  }
}
