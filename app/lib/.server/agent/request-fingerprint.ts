/**
 * 🔴 MODEL-VISIBLE MEANS LOGGED — the record of what we actually SENT (SPEC §4.2 step 2a, §4.2.8).
 *
 * Nothing in this codebase reconciles the facts we record about a generation with the request that
 * was actually assembled. Every incident in the class was found the same way: by a person noticing,
 * afterwards, that the model had behaved as if it could not see something — the 7-files-not-78 mount
 * race (the model SAID it could not see the file it was asked to edit), the double-keyed file map
 * (14 files shown twice, ~22.5k tokens a turn, for weeks), the history carrying stale file bodies.
 * None of them threw. In every case the input token count moved in a direction that reads as
 * ordinary, which is §4.2.8's stated failure mode: *a regression here throws no error and fails no
 * build; it silently multiplies the input bill.*
 *
 * This module is the record that makes such a thing answerable after the fact: one small, ordered
 * fact per model request, computed at the single seam every request passes through (`startStream`).
 *
 * ## Three properties, and each one is load-bearing
 *
 * 1. 🔴 **HASHES, COUNTS AND SHORT STRINGS — NEVER BODIES.** The assembled arrays contain the whole
 *    system prompt, the compacted history and, on an attachment turn, up to 20MB of image payload.
 *    Recording the request itself would make this feature a way to store project files on our
 *    servers, which is exactly what §4.5.4b, migration 0007 and `no-server-storage.spec.ts` exist to
 *    prevent. A hash answers "did this change?" — which is the only question being asked — and
 *    answers nothing else. `steps[].textChars` already follows this discipline: it records the LENGTH
 *    of a step's text and never the text.
 *
 * 2. 🔴 **ATTACHMENTS BY REFERENCE, NEVER BY CONTENT.** Even hashing a 20MB image is a real per-turn
 *    cost for no information. `canonicalize` refuses to walk into an image or file part's payload at
 *    all — a stronger guarantee than "we hash it, and a hash is safe", because it holds for a part
 *    shape nobody anticipated — and the spec pins it the only way that can fail: two attachments of
 *    EQUAL LENGTH and different bytes must produce the same hash. A secret-string grep over the
 *    OUTPUT cannot see this, because a payload folded into a hash INPUT never appears in the output.
 *
 *    ⚠️ The cost is recorded in TOKENS, not bytes, using `IMAGE_TOKENS_UPPER_BOUND` — the same
 *    constant and the same rule `historySize` uses. Byte size is the measure this codebase explicitly
 *    documents as wrong for this question (*"a 5MB photo and a 5MB screenshot of flat colour cost
 *    wildly different amounts to store and nearly the same to look at"*), and a record whose purpose
 *    is exposing a silently-multiplied input bill must not be denominated in the misleading unit.
 *    Byte length is also incoherent across part shapes: a decoded `Uint8Array`, a base64 string
 *    (~1.33x) and a `URL` (no bytes at all) are three different units under one field name.
 *
 * 3. 🔴 **DETERMINISTIC.** Every object is serialised with its keys SORTED, and `toolNames` is
 *    sorted. An unstable hash makes every comparison a false positive, which mutes the alert inside a
 *    day — and a muted alert is indistinguishable from no guard at all. This is the same rule, for
 *    the same reason, as "the skills index is sorted / prompt builds are hash-skipped": an unstable
 *    prefix busts the cache on every generation.
 *
 * ⚠️ **It costs the model nothing, and that is asserted rather than assumed.** It is computed strictly
 * AFTER assembly, it reads the arrays and mutates none of them, it never enters `system[]`, never
 * appears in a tool schema, and never rides in an annotation the model can read back. A verifier that
 * perturbs one byte of the cached prefix would cost more than the defects it watches for.
 */
import type { CoreMessage } from 'ai';
import { sha256 } from '~/lib/.server/prompt/store';
import { IMAGE_TOKENS_UPPER_BOUND } from '~/lib/.server/llm/history';

/**
 * WHICH REQUEST THIS IS. A turn makes one request and can then RE-ISSUE for five distinct reasons, so
 * `RequestKind` has six values — `first` plus the five. The re-issues are not interchangeable — the tool-free retry drops the tool DEFINITIONS and splices a synthetic system block, the
 * forced continuation forbids tool calls, the rescue and the completeness pass each append a
 * synthetic user message. **No persisted record has ever mentioned any of them.** Collapsing them
 * into one loses precisely the fact this feature exists to expose.
 *
 *   - `first`                     the turn's real request.
 *   - `provider-retry`            same shape as the first, thinking possibly disabled (`retry-policy.ts`).
 *   - `provider-retry-tool-free`  the tool DEFINITIONS dropped, and a synthetic media-recap block spliced in.
 *   - `forced-continuation`       `shouldForceContinuation` — the model stopped mid-tool-loop and must answer.
 *   - `unproductive-rescue`       the unproductive-turn rescue (`unproductive.ts`).
 *   - `creation-completeness`     the creation-completeness pass (`creation-completion.ts`).
 */
export type RequestKind =
  | 'first'
  | 'provider-retry'
  | 'provider-retry-tool-free'
  | 'forced-continuation'
  | 'unproductive-rescue'
  | 'creation-completeness';

export interface SystemBlockFingerprint {
  role: string;
  chars: number;
  sha256: string;

  /** `providerOptions !== undefined` — the same predicate `countCacheBreakpoints` applies. */
  hasBreakpoint: boolean;
}

export interface RequestFingerprint {
  kind: RequestKind;

  /** One entry per `role: 'system'` message, IN ORDER — order is the cached prefix (§4.2.8). */
  systemBlocks: SystemBlockFingerprint[];

  /** Mirrors `countCacheBreakpoints`. Computed every turn and, until now, thrown away. */
  breakpointCount: number;

  /** The conversation half, as one aggregate — it is uncached and re-sent whole every turn. */
  messages: { count: number; chars: number; sha256: string };

  /**
   * By reference. `count` is how many image/file parts rode along; `tokens` is an UPPER bound on what
   * they cost, by the same rule `historySize` uses — never their bytes, and never their content.
   */
  attachments: { count: number; tokens: number };

  /** Tools OFFERED, sorted. `steps[].tools` records tools CALLED — a different fact entirely. */
  toolNames: string[];

  /** `'auto' | 'none' | 'omitted'` — omitted is the empty-tool-set case, which must not send `none`. */
  toolChoice: 'auto' | 'none' | 'omitted';

  maxSteps: number;
  maxTokens: number;

  /** Decided per turn by `effortForTurn` and, until now, unrecoverable from the record. */
  effort?: string;
  thinkingMode?: string;

  /** The model REQUESTED. A refusal fallback may swap the model that SERVES — see `fallbackHandoffs`. */
  model: string;
  provider?: string;

  /** The file manifest the model was shown: how many entries, and a hash of the listing. */
  manifest: { entries: number; sha256: string };
}

export interface RequestFingerprintInput {
  kind: RequestKind;

  /** The exact array handed to `_streamText` — system blocks and conversation, already merged. */
  messages: readonly CoreMessage[];

  /** The KEYS of the tool object handed to the SDK. */
  toolNames: readonly string[];

  toolChoice: 'auto' | 'none' | 'omitted';
  maxSteps: number;
  maxTokens: number;
  model: string;
  provider?: string;
  effort?: string;
  thinkingMode?: string;

  /** The manifest entries the file-manifest block was rendered from, if the turn had one. */
  manifest?: readonly { path: string; size: number; kind: string }[];
}

/** Marks a value the canonicaliser deliberately REFUSED to walk into. Never contains the payload. */
const opaqueBytes = (length: number) => `«bytes:${length}»`;

const byteLengthOf = (value: unknown): number => {
  if (typeof value === 'string') {
    return value.length;
  }

  if (value instanceof Uint8Array) {
    return value.byteLength;
  }

  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }

  if (value && typeof value === 'object' && 'byteLength' in value && typeof (value as any).byteLength === 'number') {
    return (value as any).byteLength;
  }

  return 0;
};

/** A content part that carries an attachment payload rather than text. */
const isAttachmentPart = (value: unknown): value is { type: string } =>
  !!value && typeof value === 'object' && ((value as any).type === 'image' || (value as any).type === 'file');

/**
 * 🔴 KEYS SORTED, ATTACHMENTS REFUSED.
 *
 * The sort is what makes the hash a function of CONTENT rather than of the order some upstream
 * happened to build an object in — without it, two byte-identical requests fingerprint differently and
 * every comparison downstream is noise.
 *
 * The refusal is the §4.5.4b wall: an image part's payload is never walked, only measured. That means
 * a 20MB attachment costs one `byteLength` read instead of a 20MB hash, AND that no attachment byte
 * can reach a hash input in the first place — a stronger guarantee than "we hash it, and a hash is
 * safe", because it holds even for a future part shape nobody anticipated.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return opaqueBytes(byteLengthOf(value));
  }

  if (value instanceof URL) {
    return JSON.stringify(value.toString());
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  if (typeof value === 'object') {
    if (isAttachmentPart(value)) {
      const payload = (value as any).image ?? (value as any).data ?? (value as any).file;

      /* Type and size only. The payload is measured, never read — see the header, property 2. */
      return `{"type":${JSON.stringify((value as any).type)},"bytes":${byteLengthOf(payload)}}`;
    }

    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }

  /* A function or a symbol in an assembled message is not a thing we can hash; name the shape. */
  return `«${typeof value}»`;
}

/** How many characters of TEXT a message carries — length only, and never for an attachment part. */
function charsOf(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  return content.reduce<number>((total, part) => {
    if (isAttachmentPart(part)) {
      return total;
    }

    const text = (part as any)?.text;

    return total + (typeof text === 'string' ? text.length : 0);
  }, 0);
}

/** The prose rule of thumb §4.2.8 uses for turning text attachments into tokens. Mirrors `history.ts`. */
const CHARS_PER_TOKEN = 4;

/**
 * Attachment parts: how many, and an UPPER BOUND on what they cost. Never what they contain.
 *
 * The rule mirrors `measureAttachments` (`llm/history.ts`) deliberately — an image is the bound, a
 * text attachment is its length over four — because two estimators for one number is how a spend
 * indicator and a spend record end up disagreeing. It cannot literally reuse that function: it reads
 * the AI SDK's UI-side `Message` (`experimental_attachments`, `parts`), while this runs on the
 * CONVERTED `CoreMessage[]`, which is the only array that is actually sent.
 *
 * ⚠️ Over-reporting is the safe direction and is chosen on purpose: a 200x200 icon really costs ~54
 * tokens and is counted as 1,600. Under-reporting is the failure this measure exists to remove.
 */
function attachmentsOf(messages: readonly CoreMessage[]): { count: number; tokens: number } {
  let count = 0;
  let tokens = 0;

  for (const message of messages) {
    const content = (message as { content?: unknown }).content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!isAttachmentPart(part)) {
        continue;
      }

      count += 1;

      const mimeType = (part as any).mimeType;
      const isImage = (part as any).type === 'image' || (typeof mimeType === 'string' && mimeType.startsWith('image/'));

      if (isImage) {
        tokens += IMAGE_TOKENS_UPPER_BOUND;
        continue;
      }

      /* A text attachment IS text on the wire: its bytes are its characters. */
      tokens += Math.ceil(byteLengthOf((part as any).data ?? (part as any).file) / CHARS_PER_TOKEN);
    }
  }

  return { count, tokens };
}

/**
 * The record of one model request. Pure, allocation-light, and it mutates nothing it is handed.
 *
 * ⚠️ System blocks are picked out by ROLE, not by position, because they are not all at the head: the
 * tool-free retry splices a synthetic `# Media already generated for this request` block BETWEEN the
 * system array and the conversation. A positional split would silently file that block as a message,
 * which is precisely the difference this fingerprint exists to make visible.
 */
export function computeRequestFingerprint(input: RequestFingerprintInput): RequestFingerprint {
  const systemBlocks: SystemBlockFingerprint[] = [];
  const conversation: CoreMessage[] = [];

  /*
   * 🔴 COUNTED OVER EVERY MESSAGE, not just the system blocks — the same predicate and the same scope
   * as `countCacheBreakpoints` (`proxy.ts`), because the API's four-breakpoint ceiling counts
   * `cache_control` wherever it appears, user messages included. Counting only system blocks would
   * UNDER-report against that ceiling, which is the wrong direction for a field whose whole job is to
   * make a regression visible before it becomes an HTTP 400. Today every assignment happens to be on
   * a system block; "today" is not a guarantee, and this is the cheap side of the bet.
   */
  const breakpointCount = input.messages.filter(
    (m) => (m as { providerOptions?: unknown }).providerOptions !== undefined,
  ).length;

  for (const message of input.messages) {
    if (message.role === 'system') {
      systemBlocks.push({
        role: message.role,
        chars: charsOf(message.content),
        sha256: sha256(canonicalize(message.content)),
        hasBreakpoint: (message as { providerOptions?: unknown }).providerOptions !== undefined,
      });
      continue;
    }

    conversation.push(message);
  }

  const manifest = input.manifest ?? [];

  return {
    kind: input.kind,
    systemBlocks,
    breakpointCount,
    messages: {
      count: conversation.length,
      chars: conversation.reduce((total, message) => total + charsOf(message.content), 0),
      sha256: sha256(canonicalize(conversation.map((message) => ({ role: message.role, content: message.content })))),
    },
    attachments: attachmentsOf(input.messages),

    /* SORTED. The tool object's key order is construction order, which changes with the turn policy. */
    toolNames: [...input.toolNames].sort(),
    toolChoice: input.toolChoice,
    maxSteps: input.maxSteps,
    maxTokens: input.maxTokens,
    effort: input.effort,
    thinkingMode: input.thinkingMode,
    model: input.model,
    provider: input.provider,
    manifest: {
      entries: manifest.length,
      sha256: sha256(
        canonicalize(
          [...manifest]
            .map((e) => ({ path: e.path, size: e.size, kind: e.kind }))
            /*
             * ⚠️ CODE-UNIT ORDER, never `localeCompare` — the rule `createFilesContext` states two
             * modules over. Locale collation differs between machines, so the same manifest would
             * hash differently on two instances and this module's own determinism property would be
             * false in exactly the deployment where it matters. `buildFileManifest` already sorts
             * code-unit; this re-sort only makes an unsorted caller's array stable, and it must not
             * disagree with the listing the model was actually shown.
             */
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        ),
      ),
    },
  };
}
