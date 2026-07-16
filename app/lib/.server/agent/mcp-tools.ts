/**
 * MCP relay tools for the server-side tool loop (SPEC §4.14).
 *
 * Unlike skill tools (which `execute` entirely on the server), an MCP tool runs in the USER'S
 * WebContainer (§5). So its `execute` does two things and nothing else: EMIT the tool-call to the client
 * (which runs it via `callMcpTool` in the sandbox) and AWAIT the result the client posts back
 * (`mcp-relay.ts`). The result is fed to the model as a normal tool_result, so from the model's point of
 * view this is an ordinary tool — the round-trip to the sandbox is invisible, exactly like a skill tool's
 * server round-trip is.
 *
 * The tool is offered with a permissive argument schema on purpose: MCP tools declare arbitrary JSON
 * inputs, and the REAL validation happens at the MCP server inside the sandbox. Per the codebase rule
 * (`tools.ts`), a schema that rejects is fatal to the whole generation, so we accept and let the sandbox
 * server be the authority — its error comes back as a tool_result the model can react to.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { awaitClientToolResult } from './mcp-relay';

export interface McpLiveTool {
  name: string;
  description?: string;
  server: string;
  inputSchema?: unknown;
}

/** What the model's MCP tool-call needs the client to run. Emitted to the client stream by `execute`. */
export interface McpToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface McpRelayContext {
  generationId: string;
  userId: string;
  abortSignal?: AbortSignal;

  /** Push the tool-call to the client (api.agent writes it as a data part). */
  emit: (event: McpToolCallEvent) => void;
}

/** A safe MCP tool name for the AI SDK: it keys tools by name and rejects odd characters. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function createMcpRelayTools(
  liveTools: McpLiveTool[],
  ctx: McpRelayContext,
): Record<string, ReturnType<typeof tool>> {
  const tools: Record<string, ReturnType<typeof tool>> = {};

  for (const t of liveTools) {
    const key = safeName(t.name);
    const schemaHint = t.inputSchema
      ? `\n\nInput schema (JSON Schema): ${JSON.stringify(t.inputSchema).slice(0, 1500)}`
      : '';

    /*
     * Cast through unknown: the AI SDK's `tool()` overloads infer a very specific type; we only need the
     * structural shape, and the proxy merges these into its tool set with its own cast.
     */
    tools[key] = tool({
      description: `[MCP tool from "${t.server}"] ${t.description ?? 'A project MCP tool.'}${schemaHint}`,

      // Arbitrary MCP args; the sandbox server is the real validator (see the module note).
      parameters: z.object({}).passthrough(),

      execute: async (args, { toolCallId, abortSignal }) => {
        // Tell the client to run this tool in its sandbox.
        ctx.emit({ toolCallId, toolName: t.name, args });

        // Block THIS generation's tool loop until the client posts the result back (or times out / aborts).
        const outcome = await awaitClientToolResult({
          generationId: ctx.generationId,
          toolCallId,
          userId: ctx.userId,
          abortSignal: abortSignal ?? ctx.abortSignal,
        });

        if (outcome.error) {
          // A friendly tool_result the model can react to — never a thrown error that kills the stream.
          return `The MCP tool "${t.name}" could not run: ${outcome.error}`;
        }

        // Untrusted result (§4.14) — returned verbatim as the tool_result for the model to read.
        return outcome.result ?? null;
      },
    }) as unknown as ReturnType<typeof tool>;
  }

  return tools;
}
