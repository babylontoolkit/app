/**
 * Unknown-tool calls are a correctable bounce, NEVER a dead generation (§4.2.8, §4.16).
 *
 * Observed live on the first media-enabled creation: the model emitted the ARTIFACT as a tool call —
 * `boltArtifact`, with the project in its args — and the AI SDK's `NoSuchToolError` killed the whole
 * generation AFTER the tokens were spent ("Model tried to call unavailable tool 'boltArtifact'").
 * Same family as the zod-violation pathology (`tools.ts`): a protocol slip costing an entire paid
 * generation, on the most expensive turn in the product.
 *
 * The fix uses `experimental_repairToolCall`: an unknown-tool call is REROUTED to the internal notice
 * tool below, whose result tells the model what went wrong and to continue — so the loop keeps going
 * and the project still gets built in the SAME generation. A repair function must return a valid call
 * to a DEFINED tool (it cannot inject text), which is why the notice tool exists and must be present
 * in every tool set that runs with `toolChoice: 'auto'`.
 *
 * Deliberately narrow: only `NoSuchToolError` is repaired. An args-parse failure on a KNOWN tool is
 * left to the schema rule in `tools.ts` (all-optional parameters, validated in `execute`) — repairing
 * args to `{}` here would silently violate third-party MCP schemas, which are not all-optional.
 */
import { NoSuchToolError, tool } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('tool-repair');

export const UNAVAILABLE_TOOL_NAME = 'unavailable_tool_notice';

/** The tags the model writes as OUTPUT text — the likeliest names to be mis-called as tools. */
const OUTPUT_PROTOCOL_TAGS = new Set(['boltartifact', 'boltaction', 'boltfile', 'artifact']);

export function unavailableToolNotice(attempted?: string): string {
  const name = attempted?.trim() || 'that tool';

  if (OUTPUT_PROTOCOL_TAGS.has(name.toLowerCase())) {
    return (
      `"${name}" is not a tool — it is a plain-text output tag. Write it directly in your reply text ` +
      `(e.g. <boltArtifact ...><boltAction type="file" filePath="...">...</boltAction></boltArtifact>). ` +
      `Continue your answer now and emit the full artifact as ordinary text.`
    );
  }

  return (
    `No tool named "${name}" exists on this turn. Do not call it again — continue the task now ` +
    `with the tools you do have, or with none.`
  );
}

/**
 * The internal bounce target. It is visible in the tool definitions (unavoidable — a repaired call
 * must resolve to a defined tool), so the description tells the model to never call it directly; a
 * direct call is harmless anyway (it returns the generic notice).
 */
export function createRepairTool() {
  return {
    [UNAVAILABLE_TOOL_NAME]: tool({
      description: 'INTERNAL error handler — never call this yourself. It answers calls to tools that do not exist.',
      parameters: z.object({ attempted: z.string().optional() }),
      execute: async ({ attempted }: { attempted?: string }) => unavailableToolNotice(attempted),
    }),
  };
}

interface RepairableToolCall {
  toolCallType: 'function';
  toolCallId: string;
  toolName: string;
  args: string;
}

/**
 * `experimental_repairToolCall` for every `streamText` call in the proxy. Returning `null` keeps the
 * SDK's original (fatal) behaviour — reserved for the error kinds we deliberately do not repair.
 */
export async function repairUnavailableToolCall(options: {
  toolCall: RepairableToolCall;
  error: unknown;
}): Promise<RepairableToolCall | null> {
  if (!NoSuchToolError.isInstance(options.error)) {
    return null;
  }

  logger.warn(
    `Model called unavailable tool "${options.toolCall.toolName}" — bounced to ${UNAVAILABLE_TOOL_NAME} ` +
      `instead of killing the generation`,
  );

  return {
    toolCallType: 'function',
    toolCallId: options.toolCall.toolCallId,
    toolName: UNAVAILABLE_TOOL_NAME,
    args: JSON.stringify({ attempted: options.toolCall.toolName }),
  };
}
