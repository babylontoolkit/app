/**
 * `validateSoundRequest` — the argument rules for `generate_sound` (SPEC §4.16).
 *
 * Pure, and tested on its own because it is the ONE door both the agent tool and the Media panel pass
 * through. A rule that is wrong here is wrong in both places at once, and the failure is quiet in
 * opposite directions: too strict refuses work the user paid a round to ask for, too loose sends KIE a
 * body it rejects AFTER the debit.
 *
 * The sentences are the MCP's (`kie-sound`), kept verbatim — the model has seen them before.
 */
import { describe, expect, it } from 'vitest';
import { SOUND_MODELS } from './provider-defaults';
import { validateSoundRequest } from './sound-request';

/** Narrow to the success shape, failing loudly with the refusal when a test expected one. */
function ok(args: Record<string, unknown>) {
  const result = validateSoundRequest(args);

  if (!result.ok) {
    throw new Error(`expected a valid request, got: ${result.error}`);
  }

  return result;
}

function error(args: Record<string, unknown>): string {
  const result = validateSoundRequest(args);

  expect(result.ok, `expected a refusal for ${JSON.stringify(args)}`).toBe(false);

  return result.ok ? '' : result.error;
}

describe('kind routing', () => {
  it('defaults to a sound effect and resolves each kind to its PRICED model id', () => {
    expect(ok({ prompt: 'coin chime' })).toMatchObject({ kind: 'sound_effect', model: SOUND_MODELS.effect });
    expect(ok({ kind: 'music', prompt: 'synthwave' })).toMatchObject({ model: SOUND_MODELS.music });
    expect(ok({ kind: 'speech', prompt: 'Go' })).toMatchObject({ model: SOUND_MODELS.speech });
  });

  it('refuses an unknown kind', () => {
    expect(error({ kind: 'podcast', prompt: 'x' })).toMatch(/kind must be sound_effect, speech or music/);
  });

  /*
   * 🔴 `model` means two different things. For Suno kinds it is a VERSION (V5) that rides in
   * `options.sunoModel`; the priced id comes from the kind. Collapsing them would send `V5` to the
   * price lookup — unpriced, refused, a wasted round.
   */
  it('carries a Suno version as an option, never as the priced model', () => {
    const request = ok({ prompt: 'coin chime', model: 'V5_5' });

    expect(request.model).toBe(SOUND_MODELS.effect);
    expect(request.options.sunoModel).toBe('V5_5');
  });

  it('treats a speech model id as the priced model itself', () => {
    expect(ok({ kind: 'speech', prompt: 'Go', model: SOUND_MODELS.speechTurbo }).model).toBe(SOUND_MODELS.speechTurbo);
  });

  it('refuses a version that does not exist for the kind', () => {
    expect(error({ prompt: 'x', model: 'V4' })).toMatch(/Unsupported sound_effect model: V4/);
    expect(error({ kind: 'speech', prompt: 'x', model: 'V5' })).toMatch(/Unsupported speech model/);
  });

  it('accepts the older Suno versions for music only', () => {
    expect(ok({ kind: 'music', prompt: 'x', model: 'V4' }).options.sunoModel).toBe('V4');
  });
});

describe('cross-kind options are refused by name', () => {
  /* Silently dropping them renders something the caller did not ask for, at full price. */
  it.each([
    ['voice', { prompt: 'x', voice: 'James' }, 'sound_effect'],
    ['tempo', { kind: 'speech', prompt: 'x', tempo: 120 }, 'speech'],
    ['loop', { kind: 'music', prompt: 'x', loop: true }, 'music'],
    ['instrumental', { prompt: 'x', instrumental: false }, 'sound_effect'],
  ])('%s is not supported for the wrong kind', (key, args, kind) => {
    expect(error(args as Record<string, unknown>)).toBe(`${key} is not supported for ${kind}`);
  });

  /* CONTROL: an `undefined` value is not "passing the option" — the model emits those routinely. */
  it('CONTROL: an explicitly undefined foreign key is ignored, not refused', () => {
    expect(ok({ prompt: 'coin chime', voice: undefined }).kind).toBe('sound_effect');
  });
});

describe('prompt limits', () => {
  it('bounds each kind at its documented length', () => {
    expect(ok({ prompt: 'x'.repeat(500) }).prompt).toHaveLength(500);
    expect(error({ prompt: 'x'.repeat(501) })).toMatch(/at most 500 characters/);

    expect(ok({ kind: 'speech', prompt: 'x'.repeat(5000) }).prompt).toHaveLength(5000);
    expect(error({ kind: 'speech', prompt: 'x'.repeat(5001) })).toMatch(/at most 5000 characters/);

    expect(error({ kind: 'music', prompt: 'x'.repeat(3001) })).toMatch(/at most 3000 characters/);
  });

  /* Custom mode raises the music limit — except on V4, which never got the raise. */
  it('raises the custom-mode music limit, but not on V4', () => {
    const base = { kind: 'music', custom_mode: true, style: 'synthwave', title: 'Night Run' };

    expect(ok({ ...base, prompt: 'x'.repeat(5000) }).prompt).toHaveLength(5000);
    expect(error({ ...base, model: 'V4', prompt: 'x'.repeat(3001) })).toMatch(/at most 3000 characters/);
  });

  it('refuses an empty or missing prompt', () => {
    expect(error({})).toMatch(/prompt/i);
    expect(error({ prompt: '   ' })).toMatch(/prompt/i);
  });
});

describe('sound effect options', () => {
  it('defaults loop to false and passes tempo and key through', () => {
    expect(ok({ prompt: 'engine' }).options).toMatchObject({ loop: false });
    expect(ok({ prompt: 'engine', loop: true, tempo: 128, key: 'Am' }).options).toMatchObject({
      loop: true,
      tempo: 128,
      key: 'Am',
    });
  });

  it('bounds tempo and requires it to be whole', () => {
    expect(error({ prompt: 'x', tempo: 0 })).toMatch(/between 1 and 300/);
    expect(error({ prompt: 'x', tempo: 301 })).toMatch(/between 1 and 300/);
    expect(error({ prompt: 'x', tempo: 120.5 })).toMatch(/an integer/);
  });

  it('refuses a key that is not a real musical key', () => {
    expect(error({ prompt: 'x', key: 'H' })).toMatch(/key must be one of/);
    expect(ok({ prompt: 'x', key: 'F#m' }).options.key).toBe('F#m');
  });
});

describe('speech options', () => {
  it('maps the tool’s names onto the request record', () => {
    const options = ok({
      kind: 'speech',
      prompt: 'Lap record',
      voice: 'James',
      stability: 0.4,
      similarity_boost: 0.8,
      speech_style: 0.2,
      speed: 1.1,
    }).options;

    expect(options).toMatchObject({
      voice: 'James',
      stability: 0.4,
      similarityBoost: 0.8,
      speechStyle: 0.2,
      speed: 1.1,
    });
  });

  it('bounds the numeric voice controls', () => {
    expect(error({ kind: 'speech', prompt: 'x', stability: 1.5 })).toMatch(/between 0 and 1/);
    expect(error({ kind: 'speech', prompt: 'x', speed: 0.5 })).toMatch(/between 0.7 and 1.2/);
  });

  it('accepts language_code only on turbo 2.5, and only as ISO 639-1', () => {
    expect(
      ok({ kind: 'speech', prompt: 'x', model: SOUND_MODELS.speechTurbo, language_code: 'fr' }).options.languageCode,
    ).toBe('fr');

    expect(error({ kind: 'speech', prompt: 'x', language_code: 'fr' })).toMatch(/only supported by/);
    expect(error({ kind: 'speech', prompt: 'x', model: SOUND_MODELS.speechTurbo, language_code: 'FRA' })).toMatch(
      /at most 2 characters|two-letter/,
    );
  });
});

describe('music options', () => {
  it('defaults to instrumental, non-custom', () => {
    expect(ok({ kind: 'music', prompt: 'synthwave' }).options).toMatchObject({
      instrumental: true,
      customMode: false,
    });
  });

  /* These fields do nothing outside custom mode — accepting them silently promises an effect we would not deliver. */
  it('refuses custom-only fields without custom_mode', () => {
    expect(error({ kind: 'music', prompt: 'x', style: 'synthwave' })).toMatch(/require custom_mode: true/);
    expect(error({ kind: 'music', prompt: 'x', duration: 60 })).toMatch(/require custom_mode: true/);
  });

  it('requires style and title in custom mode', () => {
    expect(error({ kind: 'music', prompt: 'x', custom_mode: true })).toMatch(/style|title/);
    expect(
      ok({ kind: 'music', prompt: 'x', custom_mode: true, style: 'synthwave', title: 'Night Run' }).options,
    ).toMatchObject({ style: 'synthwave', title: 'Night Run' });
  });

  it('allows a vocal gender only on a vocal track', () => {
    const base = { kind: 'music', prompt: 'x', custom_mode: true, style: 's', title: 't' };

    expect(error({ ...base, vocal_gender: 'm' })).toMatch(/requires instrumental: false/);
    expect(error({ ...base, instrumental: false, vocal_gender: 'x' })).toMatch(/vocal_gender must be m or f/);
    expect(ok({ ...base, instrumental: false, vocal_gender: 'f' }).options.vocalGender).toBe('f');
  });

  it('allows duration only on V5_5 custom music, within range', () => {
    const base = { kind: 'music', prompt: 'x', custom_mode: true, style: 's', title: 't' };

    expect(error({ ...base, duration: 60 })).toMatch(/only supported for custom-mode music with model V5_5/);
    expect(error({ ...base, model: 'V5_5', duration: 9 })).toMatch(/between 10 and 360/);
    expect(ok({ ...base, model: 'V5_5', duration: 60 }).options.duration).toBe(60);
  });
});

describe('the result never throws', () => {
  it.each([[null], [undefined], ['a string'], [42], [[]]])('returns a refusal for %p', (input) => {
    const result = validateSoundRequest(input as never);

    expect(result.ok).toBe(false);
  });
});

describe('file_name', () => {
  it('passes a usable name through', () => {
    expect(ok({ prompt: 'coin chime', file_name: 'coin-pickup' }).fileName).toBe('coin-pickup');
  });

  /*
   * Refused by NAME, not dropped. The ternary that guards the return used to read `file_name` inside
   * its own else-branch, so a bad value set the failure flag a moment too late to be reported and the
   * request succeeded with the name silently discarded — the one place this file's opening rule
   * ("refuse by name, never ignore") was not met.
   */
  it.each(['sound_effect', 'speech', 'music'])('refuses a mistyped file_name on %s', (kind) => {
    expect(error({ kind, prompt: 'x', file_name: 42 })).toMatch(/file_name must be a nonempty string/);
  });
});
