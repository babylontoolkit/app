/**
 * The envelope is a WIRE FORMAT with a producer we do not test from here (`Chat.client.tsx` builds it
 * from a template literal in six places) and a consumer that broke silently for every `/slash`
 * invocation. So every case below builds its input the way the CLIENT builds it — via `clientEnvelope`,
 * a copy of that template literal — rather than hand-writing the string the stripper expects. A test
 * that asserts the stripper removes what the stripper's own regex describes proves nothing.
 */
import { describe, expect, it } from 'vitest';
import { splitCarriedArtifact, stripTransportEnvelopes, stripTransportPrefix, userTypedText } from './message-envelope';

/** Byte-for-byte what `Chat.client.tsx` posts (`[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n…`). */
function clientEnvelope(body: string, model = 'claude-opus-4-8', provider = 'KIE'): string {
  return `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${body}`;
}

describe('stripTransportPrefix', () => {
  it('recovers the exact message that broke the demo', () => {
    const typed = '/bt-spec add user authentication with login and signup pages';

    expect(stripTransportPrefix(clientEnvelope(typed))).toBe(typed);
  });

  it('leaves a message with no envelope byte-identical', () => {
    const typed = 'add a boost pad to the track';

    expect(stripTransportPrefix(typed)).toBe(typed);
  });

  it('does not strip a [Model: …] the user typed mid-sentence', () => {
    const typed = 'the header should read [Model: whatever]\n\nand be centered';

    expect(stripTransportPrefix(typed)).toBe(typed);
  });

  it('strips only the leading envelope, never a second one in the body', () => {
    const body = 'explain this line: [Provider: KIE]\n\nfrom the log';

    expect(stripTransportPrefix(clientEnvelope(body))).toBe(body);
  });

  it('is idempotent — a message re-posted every turn is stripped once, not eroded', () => {
    const once = stripTransportPrefix(clientEnvelope('hello'));

    expect(stripTransportPrefix(once)).toBe(once);
  });
});

describe('splitCarriedArtifact', () => {
  const artifact =
    '<boltArtifact id="x" title="y"><boltAction type="file" filePath="a.ts">code</boltAction></boltArtifact>';

  it('carries the modified-files artifact and returns the typed text', () => {
    const { carried, text } = splitCarriedArtifact(`${artifact}/bt-spec add auth`);

    expect(carried).toBe(artifact);
    expect(text).toBe('/bt-spec add auth');
  });

  it('carries nothing when there is no artifact', () => {
    expect(splitCarriedArtifact('/bt-spec add auth')).toEqual({ carried: '', text: '/bt-spec add auth' });
  });
});

describe('userTypedText', () => {
  it('finds the slash command behind BOTH the envelope and a modified-files artifact', () => {
    const artifact = '<boltArtifact id="m"><boltAction type="file" filePath="a.ts">x</boltAction></boltArtifact>';

    expect(userTypedText(clientEnvelope(`${artifact}/bt-spec add auth`))).toBe('/bt-spec add auth');
  });
});

describe('stripTransportEnvelopes', () => {
  it('strips content AND text parts — the SDK reads parts when they exist', () => {
    const text = clientEnvelope('/bt-spec add auth');

    const [message] = stripTransportEnvelopes([{ role: 'user', content: text, parts: [{ type: 'text', text }] }]);

    expect(message.content).toBe('/bt-spec add auth');
    expect(message.parts).toEqual([{ type: 'text', text: '/bt-spec add auth' }]);
  });

  it('never touches assistant messages', () => {
    const assistant = { role: 'assistant', content: clientEnvelope('I would not have written this') };
    const [message] = stripTransportEnvelopes([assistant]);

    expect(message).toBe(assistant);
  });

  it('leaves non-text parts (images) untouched', () => {
    const image = { type: 'image', image: 'data:image/png;base64,AAA' };

    const [message] = stripTransportEnvelopes([
      { role: 'user', content: clientEnvelope('look'), parts: [{ type: 'text', text: clientEnvelope('look') }, image] },
    ]);

    expect((message.parts as unknown[])[1]).toBe(image);
  });

  it('returns an unenveloped message by IDENTITY — no needless copies on every turn', () => {
    const plain = { role: 'user', content: 'add a boost pad', parts: [{ type: 'text', text: 'add a boost pad' }] };
    const [message] = stripTransportEnvelopes([plain]);

    expect(message).toBe(plain);
  });
});
