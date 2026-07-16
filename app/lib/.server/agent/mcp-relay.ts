/**
 * The MCP tool-call relay (SPEC §4.14).
 *
 * MCP servers run in the USER'S WebContainer, never on platform infrastructure (§5). So when the model
 * calls an MCP tool mid-generation, the platform cannot execute it — the client must, and hand the
 * result back. This registry is the server side of that hand-off.
 *
 * **Why a blocking side-channel and not the AI SDK's `addToolResult` flow.** The idiomatic client-tool
 * path re-POSTs the whole conversation after each tool result — a NEW request, and therefore a new
 * `generationId`, a new credit gate, and a new settlement per tool round. That fragments the billing,
 * effort, and cache accounting that §4.2 / §4.2.8 build around ONE generation. Instead we keep the
 * single `streamText` call alive: the MCP tool's `execute` registers here and AWAITS, the tool-call is
 * streamed to the client, the client runs it in its sandbox and POSTs the result to
 * `/api/agent/tool-result`, which delivers it here and unblocks `execute`. One generation, one
 * settlement, the prefix cached once — the tool round-trip happens INSIDE it, exactly like a skill tool,
 * except the execution is remote.
 *
 * The registry is in-process, keyed by the server-minted `generationId` (one container per environment,
 * spec/hosting.md). Every pending call carries the OWNER's id: a result POST is honoured only if its
 * caller owns the generation, so one user cannot inject a tool result into another's generation.
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('mcp-relay');

/** How long the server waits for the client to run a tool before giving up. A sandbox tool is not instant. */
export const MCP_RELAY_TIMEOUT_MS = 60_000;

export interface ClientToolResult {
  /** The tool's return value (untrusted — §4.14). Present on success. */
  result?: unknown;

  /** An error message if the client could not run the tool. Fed back to the model as a tool_result. */
  error?: string;
}

interface Pending {
  userId: string;

  /** Settles the promise AND cleans up (clears the timer, removes the entry). Idempotent. */
  settle: (value: ClientToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** generationId → (toolCallId → pending). */
const registry = new Map<string, Map<string, Pending>>();

export interface AwaitToolResultInput {
  generationId: string;
  toolCallId: string;
  userId: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Register a pending client tool call and return a promise that resolves when the client delivers its
 * result — or on timeout / generation abort. NEVER rejects: a failure comes back as `{ error }` so the
 * tool loop can feed it to the model as a normal tool_result rather than killing the generation.
 */
export function awaitClientToolResult(input: AwaitToolResultInput): Promise<ClientToolResult> {
  const { generationId, toolCallId, userId } = input;

  return new Promise<ClientToolResult>((resolve) => {
    let byGen = registry.get(generationId);

    if (!byGen) {
      byGen = new Map();
      registry.set(generationId, byGen);
    }

    const settle = (value: ClientToolResult) => {
      const map = registry.get(generationId);
      const entry = map?.get(toolCallId);

      if (!entry) {
        return; // already settled
      }

      clearTimeout(entry.timer);
      map!.delete(toolCallId);

      if (map!.size === 0) {
        registry.delete(generationId);
      }

      resolve(value);
    };

    const timer = setTimeout(() => {
      logger.warn(`MCP tool call ${toolCallId} timed out after ${input.timeoutMs ?? MCP_RELAY_TIMEOUT_MS}ms`);
      settle({ error: 'The tool did not respond in time.' });
    }, input.timeoutMs ?? MCP_RELAY_TIMEOUT_MS);

    byGen.set(toolCallId, { userId, settle, timer });

    // If the generation is aborted (Stop / closed tab), stop waiting.
    input.abortSignal?.addEventListener('abort', () => settle({ error: 'The generation was stopped.' }), {
      once: true,
    });
  });
}

/**
 * Deliver a client's tool result. Returns true if a matching pending call was waiting AND the caller
 * owns the generation. A false return is a no-op (unknown/settled call, or an ownership mismatch) — it
 * must never resolve someone else's pending call.
 */
export function deliverClientToolResult(input: {
  generationId: string;
  toolCallId: string;
  userId: string;
  result?: unknown;
  error?: string;
}): boolean {
  const entry = registry.get(input.generationId)?.get(input.toolCallId);

  if (!entry) {
    return false;
  }

  // Ownership: only the user whose generation this is may deliver a result into it.
  if (entry.userId !== input.userId) {
    logger.warn(`Rejected tool result for ${input.toolCallId}: caller does not own generation ${input.generationId}`);
    return false;
  }

  entry.settle(input.error ? { error: input.error } : { result: input.result });

  return true;
}

/** Reject every pending call for a generation (its stream ended). Prevents a leaked awaiting promise. */
export function cancelGenerationToolCalls(generationId: string): void {
  const byGen = registry.get(generationId);

  if (!byGen) {
    return;
  }

  // `settle` mutates `byGen` as it removes each entry — snapshot first so iteration is stable.
  for (const entry of [...byGen.values()]) {
    entry.settle({ error: 'The generation ended before the tool responded.' });
  }

  registry.delete(generationId);
}

/** Test seam. */
export function pendingCountForTests(generationId: string): number {
  return registry.get(generationId)?.size ?? 0;
}
