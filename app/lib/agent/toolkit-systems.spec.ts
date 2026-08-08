/**
 * The "Toolkit systems" preference (§4.4e) — the per-user control over built-in controllers vs. the
 * model's own architecture.
 *
 * Every failure here is silent. A leaked block overrides a choice the user deliberately made; a
 * wrongly-omitted one drops them back into the behaviour they just switched away from; and a value
 * that resolves UPWARD changes what their game is made of without them asking. Nothing throws in any
 * of those cases — the prompt is simply different, and the game comes out different.
 *
 * The `auto` branch is pinned hardest, because it is the common case AND it is the branch that must
 * cost nothing: it returns no block at all, since the baked batteries-included rule already states
 * the balanced position.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOLKIT_SYSTEMS,
  parseToolkitSystems,
  toolkitSystemsNoteForRequest,
  type ToolkitSystemsPreference,
} from './toolkit-systems';

describe('parseToolkitSystems — an untrusted value never resolves upward', () => {
  it('accepts each of the three real settings', () => {
    for (const value of ['prefer', 'auto', 'own'] as ToolkitSystemsPreference[]) {
      expect(parseToolkitSystems(value)).toBe(value);
    }
  });

  /*
   * 🔴 THE MONEY-SHAPED RULE, borrowed from `parseUserEffort`. This arrives in a browser body. Junk,
   * a stale client that never sends the field, or a renamed setting must all land on the shipped
   * default — inventing `prefer` or `own` silently changes what the user's game is built out of.
   */
  it('resolves absent, unknown and wrong-typed values to the default', () => {
    for (const junk of [undefined, null, '', 'PREFER', 'Prefer', 'toolkit', 42, true, {}, [], 'own ']) {
      expect(parseToolkitSystems(junk)).toBe(DEFAULT_TOOLKIT_SYSTEMS);
    }
  });

  it('the shipped default is auto — the model judges from the request', () => {
    expect(DEFAULT_TOOLKIT_SYSTEMS).toBe('auto');
  });
});

describe('auto costs nothing', () => {
  /*
   * 🔴 The default must emit NO block. `20-hard-constraints.md` already carries the balanced
   * "a menu, not a mapping" wording in the CACHED prefix, so a note here would restate the cached
   * prompt at full rate on every turn forever (§4.2.8) — the exact silent-waste shape this codebase
   * keeps rediscovering.
   */
  it('emits no block for auto', () => {
    expect(toolkitSystemsNoteForRequest('auto')).toBeUndefined();
  });

  it('emits no block when the field is absent, so a stale client pays nothing either', () => {
    expect(toolkitSystemsNoteForRequest(undefined)).toBeUndefined();
    expect(toolkitSystemsNoteForRequest(null)).toBeUndefined();
  });

  it('emits no block for junk, rather than defaulting to an override', () => {
    expect(toolkitSystemsNoteForRequest('something-else')).toBeUndefined();
  });
});

describe('prefer — reach for the built-ins', () => {
  it('names the controllers the user is asking for', () => {
    const block = toolkitSystemsNoteForRequest('prefer')!;

    expect(block).toMatch(/StandardCarController/);
    expect(block).toMatch(/StandardPlayerController/);
    expect(block).toMatch(/src\/babylon\/classes/);
  });

  /*
   * 🔴 The consistency fix, stated at the point of use. A preference for the built-ins is worthless —
   * and actively harmful — if the model writes an API it never loaded: our own prompt says inventing
   * an API is worse than not using the system. The instruction must carry its own fallback.
   */
  it('tells the model to load the reference first, and what to do when it cannot', () => {
    const block = toolkitSystemsNoteForRequest('prefer')!;

    expect(block).toMatch(/load the reference document for a system BEFORE you write against it/i);
    expect(block).toMatch(/cannot write these\s+APIs from memory/i);
    expect(block).toMatch(/author that part yourself/i);
  });

  /*
   * The §4.4d lesson, one level down: "prefer the built-in systems" is about ARCHITECTURE. It must not
   * become permission to ship the demo's Mustang — that is the exact defect that prompted this whole
   * control existing.
   */
  it('does not authorise shipping a demo’s assets', () => {
    expect(toolkitSystemsNoteForRequest('prefer')!).toMatch(/ARCHITECTURE, not content/);
  });
});

describe('own — author the architecture', () => {
  it('rules out the high-level controllers by name', () => {
    const block = toolkitSystemsNoteForRequest('own')!;

    expect(block).toMatch(/Do NOT reach for/);
    expect(block).toMatch(/StandardCarController/);
  });

  /*
   * 🔴 "Write your own architecture", read literally, means writing a physics engine. The block has to
   * draw the line explicitly, or this setting turns a preference about game FEEL into a mandate to
   * reimplement Havok — which the batteries-included rule correctly calls a defect.
   */
  it('still requires the infrastructure systems', () => {
    const block = toolkitSystemsNoteForRequest('own')!;

    expect(block).toMatch(/RigidbodyPhysics/);
    expect(block).toMatch(/keep using them/i);
    expect(block).toMatch(/physics engine or an input layer by hand is a defect/i);
  });
});

describe('the three branches are genuinely distinct', () => {
  /*
   * The CONTROL. Without it, a function that returned ONE constant for every non-auto input would
   * satisfy most assertions above — both blocks legitimately mention `StandardCarController`, because
   * one recommends it and the other rules it out.
   */
  it('CONTROL: prefer and own do not return the same block', () => {
    const prefer = toolkitSystemsNoteForRequest('prefer')!;
    const own = toolkitSystemsNoteForRequest('own')!;

    expect(prefer).not.toBe(own);
    expect(prefer).toMatch(/PREFER THE BUILT-INS/);
    expect(own).toMatch(/AUTHOR YOUR OWN ARCHITECTURE/);
  });

  /*
   * The second CONTROL, guarding the opposite mistake: a function hardcoded to always return a string
   * would pass every assertion in this file except the auto ones. This states the relationship those
   * tests rest on — exactly one of the three settings is free.
   */
  it('CONTROL: exactly one of the three settings emits nothing', () => {
    const emitted = (['prefer', 'auto', 'own'] as ToolkitSystemsPreference[]).map((value) =>
      toolkitSystemsNoteForRequest(value),
    );

    expect(emitted.filter((block) => block === undefined)).toHaveLength(1);
    expect(emitted.filter((block) => typeof block === 'string')).toHaveLength(2);
  });
});
