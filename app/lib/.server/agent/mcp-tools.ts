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

  /**
   * Which server owns the tool. Load-bearing, not decorative: two servers may expose the SAME tool name
   * (`read_file`, `search`), and without this the client resolves the call by name alone and runs it
   * against whichever server happens to be first in the list — the wrong process, silently.
   */
  server: string;
  args: unknown;
}

/**
 * How much of a tool's JSON Schema we show the model.
 *
 * The schema is client-supplied and third-party (§4.14) — an MCP server can declare an arbitrarily large
 * one, and this text rides in the tool definitions of every generation for that project (§4.2.8). Cap it.
 */
const MAX_SCHEMA_CHARS = 1500;

export interface McpRelayContext {
  generationId: string;
  userId: string;
  abortSignal?: AbortSignal;

  /** Push the tool-call to the client (api.agent writes it as a data part). */
  emit: (event: McpToolCallEvent) => void;
}

/** A safe MCP tool name for the AI SDK: it keys tools by name and rejects odd characters. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
}

/**
 * A key no other tool in this set already has.
 *
 * The tool set is a Record keyed by name, so a duplicate key does not error — it OVERWRITES, and the
 * model is simply never told the shadowed tool exists. Two ways that happens for real: two servers both
 * exposing a common name (`read_file`), and two distinct names that normalise to the same key
 * (`search web` / `search-web` → `search_web`). Qualify with the server, then disambiguate with a
 * counter, so every declared tool stays reachable.
 */
function uniqueKey(t: McpLiveTool, used: Set<string>): string {
  const bare = safeName(t.name);

  if (!used.has(bare)) {
    return bare;
  }

  const qualified = safeName(`${t.server}_${t.name}`);

  if (!used.has(qualified)) {
    return qualified;
  }

  for (let i = 2; ; i++) {
    const candidate = `${qualified.slice(0, 60)}_${i}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

export function createMcpRelayTools(
  liveTools: McpLiveTool[],
  ctx: McpRelayContext,
): Record<string, ReturnType<typeof tool>> {
  const tools: Record<string, ReturnType<typeof tool>> = {};
  const used = new Set<string>();

  for (const t of liveTools) {
    const key = uniqueKey(t, used);
    used.add(key);

    /*
     * The schema is how the model knows what ARGUMENTS this tool takes. Without it the relay still works
     * mechanically and the model still calls the tool — blind, with invented arguments — and the MCP
     * server rejects it. So this must survive the trip from the sandbox (`Chat.client.tsx` forwards it).
     */
    const schemaHint = t.inputSchema
      ? `\n\nInput schema (JSON Schema): ${JSON.stringify(t.inputSchema).slice(0, MAX_SCHEMA_CHARS)}`
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
        // Tell the client to run this tool in its sandbox — by its REAL name, on its OWN server.
        ctx.emit({ toolCallId, toolName: t.name, server: t.server, args });

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
