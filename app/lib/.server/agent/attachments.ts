/**
 * Server-side attachment validation (SPEC §4.12).
 *
 * Attachments arrive as `experimental_attachments` on the chat message: a name, a content type, and a
 * `data:` URL carrying the bytes. Every one of those three fields is supplied by the CLIENT, so none
 * of them can be trusted:
 *
 * - The client already limits size and type. That limit lives in a browser the user controls, and this
 *   route is a plain HTTP endpoint — `curl` does not run our React code. Client-side validation is a
 *   UX affordance, not a control.
 * - `contentType` is a claim, not a fact. A caller can label a 40MB video `image/png`. We therefore
 *   sniff the actual bytes for images and require the claim to MATCH what we find.
 * - Vision tokens are billed through the normal formula (§4.12), so an unbounded attachment is an
 *   unbounded bill — on OUR platform key. This is the money path, not just a robustness nicety.
 *
 * Rejection is a 400 with a human-readable reason, before the credit gate and before the model.
 */
import { envNumber } from '~/lib/.server/env';

/** Images the model can actually see, plus the small text/code files §4.12 asks us to support. */
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const ALLOWED_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/css',
  'application/json',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'text/typescript',
  'application/typescript',
]);

export class AttachmentError extends Error {
  readonly statusCode = 400;
  readonly isRetryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface AttachmentLimits {
  maxBytesEach: number;
  maxBytesTotal: number;
  maxCount: number;
}

export function getAttachmentLimits(context?: unknown): AttachmentLimits {
  return {
    maxBytesEach: envNumber(context, 'MAX_ATTACHMENT_BYTES', 5_000_000),
    maxBytesTotal: envNumber(context, 'MAX_ATTACHMENT_BYTES_TOTAL', 20_000_000),
    maxCount: envNumber(context, 'MAX_ATTACHMENTS', 8),
  };
}

/** The shape the AI SDK puts on a message. Every field is client-supplied. */
export interface IncomingAttachment {
  name?: string;
  contentType?: string;
  url?: string;
}

interface ParsedDataUrl {
  mediaType: string;
  bytes: number;
  head: Uint8Array;
}

/**
 * Parse a `data:` URL far enough to know its true size and leading bytes.
 *
 * We deliberately do NOT decode the whole payload: a caller can send a gigabyte, and materialising it
 * just to measure it is the denial-of-service we are trying to prevent. base64 length gives the byte
 * count by arithmetic (3 bytes per 4 chars, minus padding), so the size check happens BEFORE any
 * allocation. Only a small head is decoded, for sniffing.
 */
function parseDataUrl(url: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);

  if (!match) {
    return null;
  }

  const [, mediaType, isBase64, payload] = match;

  if (!isBase64) {
    // A non-base64 data URL is percent-encoded text; its decoded length is what it costs us.
    const text = decodeURIComponent(payload);

    return { mediaType, bytes: new TextEncoder().encode(text).length, head: new Uint8Array() };
  }

  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((payload.length * 3) / 4) - padding);

  let head = new Uint8Array();

  try {
    // 16 base64 chars -> 12 bytes: enough for every magic number we check, and nothing more.
    head = Uint8Array.from(atob(payload.slice(0, 16)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }

  return { mediaType, bytes, head };
}

/**
 * Identify an image from its MAGIC NUMBER, not from what the caller called it.
 *
 * Returns null for anything we do not recognise — which then fails the match against the claimed
 * type, so "unrecognised" is rejected rather than waved through.
 */
function sniffImage(head: Uint8Array): string | null {
  const startsWith = (...sig: number[]) => sig.every((byte, i) => head[i] === byte);

  if (startsWith(0x89, 0x50, 0x4e, 0x47)) {
    return 'image/png';
  }

  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg';
  }

  if (startsWith(0x47, 0x49, 0x46, 0x38)) {
    return 'image/gif';
  }

  // WEBP: "RIFF" .... "WEBP"
  if (startsWith(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42) {
    return 'image/webp';
  }

  return null;
}

/**
 * Validate every attachment on every message. Throws `AttachmentError` (400) on the first problem.
 *
 * Called BEFORE the credit gate: a rejected upload must never cost the user credits, and must never
 * reach the model.
 */
export function validateAttachments(
  messages: Array<{ experimental_attachments?: IncomingAttachment[] }>,
  context?: unknown,
): void {
  const limits = getAttachmentLimits(context);
  const attachments = messages.flatMap((message) => message.experimental_attachments ?? []);

  if (attachments.length === 0) {
    return;
  }

  if (attachments.length > limits.maxCount) {
    throw new AttachmentError(
      `Too many attachments: ${attachments.length}. You can attach up to ${limits.maxCount} files per message.`,
    );
  }

  let total = 0;

  for (const attachment of attachments) {
    const label = attachment.name || 'attachment';

    if (!attachment.url) {
      throw new AttachmentError(`"${label}" has no content.`);
    }

    const parsed = parseDataUrl(attachment.url);

    if (!parsed) {
      /*
       * Only `data:` URLs. A remote URL would have the SERVER fetch a client-chosen address — an
       * SSRF into our own network — and would let the bytes change between validation and use.
       */
      throw new AttachmentError(`"${label}" is not an inline file. Attachments must be uploaded, not linked.`);
    }

    if (parsed.bytes > limits.maxBytesEach) {
      throw new AttachmentError(
        `"${label}" is ${(parsed.bytes / 1e6).toFixed(1)}MB. The limit is ${(limits.maxBytesEach / 1e6).toFixed(0)}MB per file.`,
      );
    }

    total += parsed.bytes;

    if (total > limits.maxBytesTotal) {
      throw new AttachmentError(
        `Those attachments total more than ${(limits.maxBytesTotal / 1e6).toFixed(0)}MB. Try fewer, or smaller, files.`,
      );
    }

    /*
     * The declared type must be one we allow AND must agree with the bytes. We compare against the
     * data URL's OWN media type as well as the SDK's `contentType`, because they are two separate
     * client-supplied fields and a mismatch between them is itself a red flag.
     */
    const claimed = (attachment.contentType || parsed.mediaType || '').toLowerCase().split(';')[0];

    if (ALLOWED_IMAGE_TYPES.has(claimed)) {
      const actual = sniffImage(parsed.head);

      if (actual === null) {
        throw new AttachmentError(`"${label}" is not a valid image file.`);
      }

      /* JPEG is served under two names; otherwise the bytes must be what the caller claimed. */
      const claimedNormalised = claimed === 'image/jpg' ? 'image/jpeg' : claimed;

      if (actual !== claimedNormalised) {
        throw new AttachmentError(`"${label}" claims to be ${claimed} but its contents are ${actual}.`);
      }

      continue;
    }

    if (ALLOWED_TEXT_TYPES.has(claimed)) {
      continue;
    }

    throw new AttachmentError(
      `"${label}" is a ${claimed || 'unknown'} file, which cannot be attached. ` +
        `Attach images (PNG, JPEG, WebP, GIF) or text files. ` +
        `To add 3D models, textures or audio to your game, use the Assets tab instead.`,
    );
  }
}
