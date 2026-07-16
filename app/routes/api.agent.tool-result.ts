/**
 * MCP tool-result delivery (SPEC §4.14).
 *
 *   POST /api/agent/tool-result  { generationId, toolCallId, result? , error? }  → { delivered }
 *
 * The other half of the relay. While a generation's server-side tool loop is BLOCKED awaiting an MCP
 * tool the model called, the client runs that tool in its WebContainer (`callMcpTool`) and posts the
 * result here. This hands it to `deliverClientToolResult`, which unblocks the waiting `execute` — the
 * generation then continues, all inside the SAME open request (one settlement, one cached prefix).
 *
 * Authenticated, and OWNERSHIP-checked at the relay: `deliverClientToolResult` refuses a result unless
 * the caller owns the generation (the pending call records the generation's user id), so one user can
 * never inject a tool result — untrusted, and possibly a prompt-injection payload (§4.14) — into
 * another user's generation. A miss (wrong id, already settled, not the owner) returns `delivered:false`
 * with 200: it is not an error, just a no-op.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';
import { deliverClientToolResult } from '~/lib/.server/agent/mcp-relay';
import { errorResponse } from '~/lib/.server/http';

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') {
      return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
    }

    const user = await requireVerifiedUser(request, context);
    const body = await request.json<{ generationId?: string; toolCallId?: string; result?: unknown; error?: string }>();

    if (!body.generationId || !body.toolCallId) {
      return json({ error: true, message: 'generationId and toolCallId are required.' }, { status: 400 });
    }

    const delivered = deliverClientToolResult({
      generationId: body.generationId,
      toolCallId: body.toolCallId,
      userId: user.id,
      result: body.result,
      error: body.error,
    });

    return json({ delivered });
  } catch (error) {
    return errorResponse(error);
  }
}
