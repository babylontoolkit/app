/**
 * Attachment validation (§4.12) — a money path and a safety path.
 *
 * Vision tokens bill through the normal formula on OUR platform key, so an unbounded attachment is an
 * unbounded bill. And every field here is client-supplied: the browser's own limits are a UX
 * affordance, not a control, because `curl` does not run our React code.
 */
import { describe, expect, it } from 'vitest';
import { AttachmentError, validateAttachments } from './attachments';

/** Real magic numbers — the point of the sniffer is that it reads BYTES, not labels. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const dataUrl = (mime: string, b64: string) => `data:${mime};base64,${b64}`;
const msg = (attachments: Array<{ name?: string; contentType?: string; url?: string }>) => [
  { experimental_attachments: attachments },
];

describe('validateAttachments', () => {
  it('accepts a real PNG that says it is a PNG', () => {
    expect(() =>
      validateAttachments(msg([{ name: 'logo.png', contentType: 'image/png', url: dataUrl('image/png', PNG) }])),
    ).not.toThrow();
  });

  it('accepts a real JPEG and a text file', () => {
    expect(() =>
      validateAttachments(
        msg([
          { name: 'photo.jpg', contentType: 'image/jpeg', url: dataUrl('image/jpeg', JPEG) },
          { name: 'notes.md', contentType: 'text/markdown', url: 'data:text/markdown,hello%20world' },
        ]),
      ),
    ).not.toThrow();
  });

  it('does nothing when there are no attachments', () => {
    expect(() => validateAttachments([{ experimental_attachments: [] }, {}])).not.toThrow();
  });

  /**
   * The one that matters. `contentType` is a CLAIM. A caller can label anything `image/png`, and if we
   * trust the label we hand the model — and our bill — whatever they actually sent.
   */
  it('rejects a file whose bytes disagree with its claimed type', () => {
    expect(() =>
      validateAttachments(
        msg([{ name: 'evil.png', contentType: 'image/png', url: dataUrl('image/png', 'AAAAAAAAAAAAAAAA') }]),
      ),
    ).toThrow(AttachmentError);
  });

  it('rejects a JPEG masquerading as a PNG', () => {
    expect(() =>
      validateAttachments(msg([{ name: 'x.png', contentType: 'image/png', url: dataUrl('image/png', JPEG) }])),
    ).toThrow(/contents are image\/jpeg/);
  });

  it('rejects a type that is not on the allow list', () => {
    expect(() =>
      validateAttachments(
        msg([{ name: 'model.glb', contentType: 'model/gltf-binary', url: 'data:model/gltf-binary;base64,AAAA' }]),
      ),
    ).toThrow(/Assets tab/);
  });

  /**
   * A remote URL would make the SERVER fetch a client-chosen address — an SSRF into our own network —
   * and would let the bytes change between validation and use.
   */
  it('rejects a remote URL, allowing only inline data', () => {
    expect(() =>
      validateAttachments(msg([{ name: 'x.png', contentType: 'image/png', url: 'https://evil.test/x.png' }])),
    ).toThrow(/must be uploaded, not linked/);
  });

  it('rejects a file over the per-file byte limit', () => {
    /* ~7.5MB decoded, comfortably over the 5MB default, without allocating it. */
    const huge = dataUrl('image/png', 'A'.repeat(10_000_000));

    expect(() => validateAttachments(msg([{ name: 'huge.png', contentType: 'image/png', url: huge }]))).toThrow(
      /limit is 5MB per file/,
    );
  });

  it('rejects too many attachments', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `${i}.png`,
      contentType: 'image/png',
      url: dataUrl('image/png', PNG),
    }));

    expect(() => validateAttachments(msg(many))).toThrow(/up to 8 files/);
  });

  it('counts attachments across ALL messages, not just the last', () => {
    const one = { name: 'a.png', contentType: 'image/png', url: dataUrl('image/png', PNG) };
    const messages = Array.from({ length: 9 }, () => ({ experimental_attachments: [one] }));

    expect(() => validateAttachments(messages)).toThrow(/up to 8 files/);
  });

  it('reports a 400, not a 500 — a bad upload is the caller’s mistake', () => {
    try {
      validateAttachments(
        msg([{ name: 'x', contentType: 'application/x-msdownload', url: 'data:application/x-msdownload;base64,TVo=' }]),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AttachmentError);
      expect((error as AttachmentError).statusCode).toBe(400);
    }
  });
});
