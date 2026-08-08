/**
 * The creation brief's CONTENT SOURCING rule — where a game's 3D models come from (§4.4d, §4.4e).
 *
 * ## The defect this exists to prevent
 *
 * The brief had exactly two branches, and the second one read:
 *
 *   "If no such block is present, build with the starter's own content and primitives"
 *
 * **"The starter's own content" is the demo library** — the read-only classes in
 * `src/babylon/classes/`, whose reference documents load `riggedmustang.gltf` and `openterrain.gltf`
 * from the shared playground repo. So the no-library branch, read literally and correctly, authorised
 * reaching for a demo asset. A "mario kart clone" duly shipped a white Ford Mustang on a flat grey
 * test map. Owner: *"If use asset library is off and the user did not somehow specify the models to
 * use, YOU SHOULD BE GENERATING THEM YOURSELF... not use the mustang."*
 *
 * That is the correct rule and it was never written down. The toggle chooses between **library** and
 * **author it yourself** — it never chooses between library and *whatever asset URL is nearest to
 * hand*, and no state of it makes a demo fixture the right answer.
 *
 * ## Why a test, and why on the STRING
 *
 * This whole file asserts prose, which is unusual and deliberate: the brief is a per-project prompt
 * built by a pure function, it rides on the most expensive turn in the product, and the bug above was
 * a single misleading noun that nothing could catch. There was no test of any kind over
 * `buildCreationBrief` — the function was not even exported. A rule that cost a real generation and
 * cannot be asserted is a rule that will come back.
 *
 * Assertions are on MEANING (does the no-library branch say author-it-yourself, does it name the
 * fixtures it must not ship) rather than on exact sentences, so ordinary rewording stays free.
 */
import { describe, expect, it } from 'vitest';
import type { GameRegistryEntry } from '~/types/game-registry';
import { buildCreationBrief } from './create-project';

const entry: GameRegistryEntry = {
  id: 'gm_blank_v1',
  title: 'Blank Canvas',
  genre: 'blank',
  description: 'A generic starting shell.',
  source_class: 'DefaultGameMode.ts',
  match_keywords: [],
  is_active: true,
};

function brief(overrides: Partial<Parameters<typeof buildCreationBrief>[0]> = {}) {
  return buildCreationBrief({
    entry,
    title: 'Kart Rush',
    className: 'KartRushMode',
    images: ['public/babylon.png'],
    scaffolded: true,
    ...overrides,
  });
}

describe('the sourcing rule has exactly two branches, and BOTH are stated', () => {
  /*
   * The branches are conditional on the BLOCK's presence in context, never on client state — that is
   * what makes the §4.4d toggle leak-free without the brief knowing anything about it.
   */
  it('describes the library branch conditionally on the block being present', () => {
    expect(brief()).toMatch(/If a \*\*Prototype Asset Library \(Synty\)\*\* block is present/);
  });

  it('describes the no-library branch conditionally on the block being absent', () => {
    expect(brief()).toMatch(/If no such block is present/);
  });
});

describe('🔴 no library means AUTHOR IT YOURSELF — never a demo asset', () => {
  /*
   * The headline. The replaced wording ("build with the starter's own content") pointed at the demo
   * library; this asserts the branch now tells the model to BUILD the content.
   */
  it('tells the model to author the content itself', () => {
    const text = brief();

    expect(text).toMatch(/AUTHOR THE CONTENT YOURSELF/i);
    expect(text).toMatch(/procedural geometry/i);
  });

  /*
   * 🔴 The exact fixtures that shipped. Naming them is the point: the two reference documents that
   * teach these URLs are authored in `babylontoolkit/agent` and are not editable from this codebase,
   * so the brief has to name what must not be shipped rather than rely on those docs saying it.
   */
  it('names the playground fixtures it must not substitute', () => {
    const text = brief();

    for (const fixture of ['riggedmustang', 'openterrain', 'samplescene', 'playerarmature']) {
      expect(text, `${fixture} is not named as a do-not-ship fixture`).toContain(fixture);
    }
  });

  it('says a specific asset URL is loaded only when the user named that asset', () => {
    expect(brief()).toMatch(/only when the user named that asset/i);
  });

  /*
   * The phrase that caused it. A regression here would most naturally arrive as someone restoring the
   * old, friendlier-sounding sentence — so the sentence itself is banned rather than merely replaced.
   */
  it("CONTROL: never tells the model to build with the starter's own CONTENT", () => {
    expect(brief()).not.toMatch(/build with the starter's own content/i);
  });

  /*
   * The second CONTROL, guarding the opposite over-correction: "author it yourself" must not become a
   * blanket ban on loading assets, or the LIBRARY branch — the whole point of §4.4d — reads as
   * forbidden too. Both branches have to survive in one brief.
   */
  it('CONTROL: the author-it-yourself rule does not suppress the library branch', () => {
    const text = brief();

    expect(text).toMatch(/ALWAYS PREFERRED/);
    expect(text).toMatch(/EXACT listed paths/);
  });
});

describe('the promise made about generation is accurate', () => {
  /*
   * "Generate them yourself" is right about GEOMETRY and wrong about glTF: the media tools produce
   * images and video, never 3D models, and they are off on this turn anyway (§4.4a). A brief that
   * implied otherwise would have the model announce assets it cannot produce — the "model narrates
   * success" failure this codebase keeps rediscovering.
   */
  it('states that 3D models are BUILT this turn, not generated', () => {
    const text = brief();

    expect(text).toMatch(/cannot generate 3D models on this turn/i);
    expect(text).toMatch(/Media panel/);
  });
});
