/**
 * The admin's MCP server: stateless Streamable HTTP at `POST /api/mcp`,
 * authenticated with an API key. Each request builds a server with the
 * caller's context, runs the call and closes. Which tools a key sees depends
 * on its scopes:
 *
 *  - `email:mcp`  the `email_` tools (docs/email/MCP.md).
 *  - `admin:mcp`  the `admin_` tools (docs/MCP-CONNECTOR.md): everything the
 *                 key's user can do in the web UI, run through the admin's own
 *                 routes as that user.
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
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { apiKeys, users } from '../../../db/schema/index.js';
import { ADMIN_TOOLS } from '../../mcp/tools.js';
import { ApiCallRefused, callApi, type AdminContext } from '../../mcp/dispatch.js';

export interface McpScopes {
  email: boolean;
  admin?: AdminContext;
}

export function buildMcpServer(ctx: ToolContext, scopes: McpScopes = { email: true }): McpServer {
  const server = new McpServer({ name: 'smmta', version: '1.1.0' });
  if (scopes.admin) registerAdminTools(server, scopes.admin);
  if (!scopes.email) return server;
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

function registerAdminTools(server: McpServer, admin: AdminContext): void {
  for (const tool of ADMIN_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      try {
        const call = tool.call(args ?? {}, admin);
        if ('local' in call) return { content: [{ type: 'text' as const, text: JSON.stringify(call.local, null, 2) }] };
        const res = await callApi(admin, tool.name, call);
        const text = JSON.stringify({ status: res.status, ...(isRecord(res.body) ? res.body : { body: res.body }) }, null, 2);
        return res.ok ? { content: [{ type: 'text' as const, text }] } : { isError: true, content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof ApiCallRefused ? err.message : `The call failed: ${err instanceof Error ? err.message : String(err)}`;
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The admin side of a key: the user it acts as, or why it cannot. */
async function adminContext(app: FastifyInstance, keyId: string, prefix: string, canApprove: boolean): Promise<AdminContext | string> {
  const db = getDb();
  const [key] = await db.select({ actingUserId: apiKeys.actingUserId }).from(apiKeys).where(eq(apiKeys.id, keyId));
  if (!key?.actingUserId) return 'This admin:mcp key has no user to act as. Issue a new key while signed in to the admin.';
  const [user] = await db
    .select({ id: users.id, email: users.email, roles: users.roles })
    .from(users)
    .where(and(eq(users.id, key.actingUserId), isNull(users.deletedAt)));
  if (!user) return 'The user this key acts as no longer exists. Issue a new key.';
  return { app, user, keyPrefix: prefix, canApprove };
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
  app.post('/mcp', { preHandler: apiKeyAuth([]) }, async (request, reply) => {
    const key = getApiKeyContext(request);
    const email = key.scopes.includes('email:mcp');
    const wantsAdmin = key.scopes.includes('admin:mcp');
    if (!email && !wantsAdmin) {
      return reply.status(403).send({ success: false, error: 'Missing required scope: email:mcp or admin:mcp' });
    }
    const canApprove = key.scopes.includes('email:approve');
    let admin: AdminContext | undefined;
    if (wantsAdmin) {
      const found = await adminContext(app, key.keyId, key.prefix, canApprove);
      if (typeof found === 'string') return reply.status(403).send({ success: false, error: found });
      admin = found;
    }
    const ctx: ToolContext = { actor: canApprove ? `mcp:${key.prefix}` : 'claude', canApprove };
    const server = buildMcpServer(ctx, { email, admin });
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
