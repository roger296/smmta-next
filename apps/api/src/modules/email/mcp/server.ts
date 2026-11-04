/**
 * The admin's MCP server (spec § MCP interface). The repo had none, so this
 * is it: stateless Streamable HTTP at `POST /api/mcp`, authenticated with an
 * API key carrying the `email:mcp` scope (issue one from the admin's API-key
 * route). Each request builds a server with the caller's context, runs the
 * call and closes.
 *
 * Actor: `claude` for an ordinary key. A key that also carries
 * `email:approve` is a person's (Roger's) key: its calls are recorded as
 * `mcp:<key prefix>` and it may approve campaigns.
 */
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { apiKeyAuth, getApiKeyContext } from '../../../shared/middleware/api-key.js';
import { audit } from '../services/operator.service.js';
import { EMAIL_TOOLS, type ToolContext } from './tools.js';

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'smmta-email', version: '1.0.0' });
  for (const tool of EMAIL_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      try {
        const result = await tool.handler(args, ctx);
        await audit(tool.name, ctx.actor, args, true, summarise(result));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await audit(tool.name, ctx.actor, args, false, message);
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    });
  }
  return server;
}

function summarise(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} items`;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const bits = ['id', 'status', 'total', 'count', 'changed', 'importId'].filter((k) => k in r).map((k) => `${k}=${JSON.stringify(r[k])}`);
    return bits.join(' ') || 'ok';
  }
  return String(result ?? 'ok');
}

export async function emailMcpRoutes(app: FastifyInstance) {
  app.post('/mcp', { preHandler: apiKeyAuth(['email:mcp']) }, async (request, reply) => {
    const key = getApiKeyContext(request);
    const canApprove = key.scopes.includes('email:approve');
    const ctx: ToolContext = { actor: canApprove ? `mcp:${key.prefix}` : 'claude', canApprove };
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: no server-initiated streams and no sessions to end.
  const notAllowed = async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
