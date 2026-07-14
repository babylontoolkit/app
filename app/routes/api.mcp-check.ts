import { type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { MCPService } from '~/lib/services/mcpService';
import { serverSideMcpDisabled } from '~/lib/.server/mcp/server-guard';

const logger = createScopedLogger('api.mcp-check');

export async function loader({ context }: LoaderFunctionArgs) {
  // SECURITY (SPEC §4.14, §5): server-side MCP connects/spawns from client config — fail closed.
  const disabled = serverSideMcpDisabled(context, '/api/mcp-check');

  if (disabled) {
    return disabled;
  }

  try {
    const mcpService = MCPService.getInstance();
    const serverTools = await mcpService.checkServersAvailabilities();

    return Response.json(serverTools);
  } catch (error) {
    logger.error('Error checking MCP servers:', error);
    return Response.json({ error: 'Failed to check MCP servers' }, { status: 500 });
  }
}
