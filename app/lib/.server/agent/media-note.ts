/**
 * The protocol for using the built-in media tools, on EVERY turn that offers them (SPEC §4.16).
 *
 * ## Why this exists
 *
 * These four rules were written for the creation brief (`registry/create-project.ts`) and lived ONLY
 * there. But the tools themselves are offered on ordinary and `/slash` turns too — so the most
 * demanding media turn in the product, `/bt-landing redesign the landing page for <game>`, handed the
 * model three spending tools and no protocol whatsoever. Each missing rule has its own failure, and
 * they are the failures that were reported:
 *
 *  - ⚠️ **This bullet used to say "batch the calls".** It instructed ONE parallel round because
 *    `MEDIA_TURN_STEPS` was 3 and a second round exhausted the loop. Both halves are retired
 *    (2026-08-08): `MEDIA_TURN_STEPS` was dead code with no reader, and the cap that enforced the
 *    instruction (`MAX_MEDIA_ROUNDS`) refused three images a live design had asked for. A media turn
 *    now gets its own ceiling (`MEDIA_IMAGE_ROUNDS`, tool-policy.ts) and the model requests one image
 *    per call. **Never reinstate a batching instruction without re-checking that ceiling first** — the
 *    instruction only ever existed because the ceiling was too low.
 *  - **Artifacts are TEXT, not tools.** This is the documented pathology that killed the first
 *    media-enabled creation: with tools in scope the model emits `<boltArtifact>` as a TOOL CALL,
 *    which is `NoSuchToolError` — historically a dead generation after the tokens were spent.
 *    `tool-repair.ts` now bounces it, but a bounce still burns a round out of three, and the rule is
 *    what stops it happening at all. It is exactly "the artifact doesn't come back when we use the
 *    image tools from chat".
 *  - **Reference the returned paths verbatim.** The system prompt says never invent an asset path;
 *    a generated file does not exist yet when the model writes the code, so without an explicit
 *    carve-out the model reasonably refuses to reference it — or invents a different name that will
 *    never exist.
 *  - **Degrade while the render lands.** Async-enqueue means the code ships ~30s before the bytes.
 *    Without a styled fallback the page renders visibly broken in the meantime.
 *
 * ## Placement (this is load-bearing, §4.2.8)
 *
 * Returned as a note for the VOLATILE TAIL — it must be pushed AFTER the last cache breakpoint, like
 * `discussNote`. Whether media tools are offered varies per turn (`hasMediaTools` depends on the KIE
 * key and the project), so a breakpoint-covered position would re-write the ~110k-token file-context
 * entry at 2x whenever it changed.
 *
 * Creation does NOT use this: its brief already carries a richer, art-directed version, and sending
 * both would pay twice for two copies that can disagree.
 */

export interface MediaNoteInput {
  /** Media tools are actually in this turn's tool set — never advertise a capability that is absent. */
  hasMediaTools: boolean;

  /** The creation brief owns its own, richer copy of these rules. */
  isFirstBuildTurn: boolean;

  /**
   * Which phase of the creation plan this is (§4.4e), or `null` for the pre-phase single turn.
   *
   * 🔴 The suppression above exists because SOMETHING ELSE already carries this copy — the creation
   * brief did. A PHASE does not: the art phase's task is two sentences about reading `DESIGN.md`, not
   * the protocol. So a creation phase gets the note, and only the old single-turn creation is
   * suppressed. Getting this backwards is silent in the expensive direction: the model would be
   * handed `generate_image` with no statement of how paths come back, and the §4.16 rule it most
   * reliably breaks without one is "do not wait for the render".
   */
  creationPhase?: string | null;
}

export function mediaProtocolNote(input: MediaNoteInput): string | null {
  if (!input.hasMediaTools || (input.isFirstBuildTurn && !input.creationPhase)) {
    return null;
  }

  return [
    '# Built-in media generation (available this turn)',
    '',
    'You have `generate_image` / `generate_video` / `generate_google_video`. They save into the ' +
      'project under `public/assets/generated/` and cost the user credits. Use them when the user asks ' +
      'for art, or when bespoke art is clearly needed for the design you are building. Rules:',
    '',
    '- `<boltArtifact>` and `<boltAction>` are PLAIN-TEXT TAGS you write in your reply. NEVER call ' +
      'them as tools — they are not tools, and the call fails.',
    '- Ask for ONE image per call, at the point in the design where you need it. There is no batching ' +
      'rule and no round budget: request a piece of art, get its path back immediately, keep ' +
      'designing, and request the next one when the design calls for it. You have room for several — ' +
      'just leave yourself a step to write the files in.',
    '- Each call returns the asset path IMMEDIATELY; the render finishes in the background. Do NOT ' +
      'wait for it, poll for it, or mention waiting.',
    '- The returned paths are the ONE exception to "never invent an asset path": reference them ' +
      'exactly as returned (as `./assets/generated/…` URLs) and the files will appear there.',
    '- Keep the leading `./` EXACTLY as returned, in JSX and in CSS. A published game is served under ' +
      'a prefix (`/play/<id>/`), so a root-absolute `/assets/…` resolves to the wrong origin path and ' +
      '404s for every visitor — it looks fine in dev, where the app is at the root, and fine in CSS, ' +
      'where the bundler rewrites it for you. Only your JSX string literals ship broken.',
    '- Design every surface to look finished while a render is still landing — a styled background ' +
      'colour or gradient behind each generated image, never a blank box.',
    '- These files SHIP IN THE GAME, so mind their weight. Ordinary art (backgrounds, textures, ' +
      'panels, scenery) defaults to jpg — leave `output_format` unset for it. A 2K photographic png ' +
      'is ~10MB against under 1MB as jpg, at the same price.',
    '- For art that must sit OVER something — a logo or wordmark on the hero, an emblem, a sprite, a ' +
      'cut-out character — pass `transparent: true`. It renders and then cuts the art out into a real ' +
      'RGBA PNG for a couple of extra credits. **Never write "transparent background" (or "no ' +
      'background", or "PNG with alpha") into the PROMPT**: the generator has no alpha channel, so it ' +
      'paints a fake grey-and-white checkerboard into the artwork instead, permanently. `transparent: ' +
      'true` is the only thing that produces actual transparency.',
  ].join('\n');
}
