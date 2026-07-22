/**
 * How much has this generation actually STREAMED so far? (§4.2a, §4.12)
 *
 * The chat's stall watchdog decides "the stream is dead" from whether this number is still moving.
 * That makes it a money path in disguise: the watchdog's terminal action is `stop()`, which aborts a
 * generation the user is being billed for. So a number that misses a whole CHANNEL of activity does
 * not merely mis-report — it CANCELS healthy work and charges for it.
 *
 * Which is exactly what shipped. The watchdog summed `message.content` (plus the data-part count) and
 * nothing else. But reasoning does not live on `content` — §4.2a routes it onto the AI SDK's own
 * channel precisely so it can NEVER reach the artifact parser (leaked reasoning inside a
 * `<boltAction>` gets written into the user's file), and `useChat` therefore delivers it as a
 * `ReasoningUIPart` in `message.parts`. So for the entire time the model is thinking, `content` is
 * frozen and the watchdog reads a completely silent stream — while the user is watching the thinking
 * panel fill up in front of them.
 *
 * The thresholds made that survivable-looking rather than obviously wrong: 120s buys a reassuring
 * toast, and only 300s cancels. But `spec/context-budget.md` has measured thinking windows of 219s
 * and 307.8s on hard asks, and a media turn is the hardest ask in the product — the model is planning
 * an entire page around art it just commissioned. So the generations most likely to be killed are the
 * expensive ones, and the user sees the three-dot spinner, then "Still working", then
 * "The generation stopped responding and was cancelled."
 *
 * The rule this encodes: **activity is any byte on any channel the server sent us**, never the one
 * channel that happens to feed the parser. A new part type is activity the moment it exists.
 */

/** The subset of `useChat`'s message shape this needs — kept structural so tests need no AI SDK types. */
export interface ActivityMessage {
  content?: unknown;
  parts?: unknown;
}

/**
 * A monotonic-ish size for "everything streamed so far".
 *
 * Only its CHANGES matter — the watchdog compares it against the previous tick — so it does not need
 * to be a byte count, just something that moves whenever the server sends anything.
 */
export function streamActivitySize(messages: readonly ActivityMessage[], dataLength: number): number {
  let size = dataLength;

  for (const message of messages) {
    if (typeof message.content === 'string') {
      size += message.content.length;
    }

    if (!Array.isArray(message.parts)) {
      continue;
    }

    for (const part of message.parts as Array<Record<string, unknown>>) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      /*
       * Text and reasoning are the two streaming channels. Reasoning is the one that was missing and
       * is the whole reason this function exists; text is counted here too so a future change that
       * moves text onto `parts` only cannot silently reintroduce the same blind spot.
       */
      if (typeof part.reasoning === 'string') {
        size += part.reasoning.length;
      }

      if (typeof part.text === 'string') {
        size += part.text.length;
      }

      /*
       * A tool call is activity even though it streams no prose — on a media turn (§4.16) the whole
       * of step 1 is `generate_image` calls, and its state transitions (`call` → `result`) are the
       * only sign of life until step 2 starts writing. Count the state string, not the payload: it
       * changes on every transition and costs nothing to read.
       */
      const invocation = part.toolInvocation as { state?: unknown } | undefined;

      if (invocation && typeof invocation.state === 'string') {
        size += invocation.state.length;
      }
    }
  }

  return size;
}
