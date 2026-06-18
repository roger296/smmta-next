/**
 * MCP server for Claude / Cowork (P14, spec §A9).
 *
 *   GET  /.well-known/oauth-protected-resource   — RFC 9728 discovery (public)
 *   POST /mcp                                     — MCP JSON-RPC (bearer-authed)
 *
 * The MCP wire protocol (initialize / tools/list / tools/call) is implemented
 * directly over JSON-RPC-on-HTTP rather than via the SDK's session-managed
 * streamable transport (DECISIONS D8) — fully testable, dependency-free, and
 * the same tool registry P19 extends with guarded write tools. Auth reuses the
 * api_keys verification (scope `mcp:read`) and, on 401, returns the RFC 9728
 * `WWW-Authenticate: Bearer resource_metadata="…"` hint (BumbleBee's pattern).
 * Every tool call is audited (best-effort).
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../../config/database.js';
import { apiKeys, mcpAuditLog } from '../../db/schema/index.js';
import { parseRawKey, verifySecret } from '../../shared/auth/api-key.js';
import { MCP_TOOLS, getMcpTool } from './tools.js';
import { MCP_ACTION_TOOLS, getMcpActionTool } from './action-tools.js';

function baseUrl(request: FastifyRequest): string {
  const proto = (request.headers['x-forwarded-proto'] as string) ?? request.protocol;
  return `${proto}://${request.headers.host ?? 'localhost'}`;
}

async function mcpAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const metaUrl = `${baseUrl(request)}/.well-known/oauth-protected-resource`;
  const unauth = (msg: string) => {
    reply
      .header('WWW-Authenticate', `Bearer resource_metadata="${metaUrl}"`)
      .status(401)
      .send({ success: false, error: msg });
    return false;
  };
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return unauth('Missing Bearer token');
  const parsed = parseRawKey(auth.slice('Bearer '.length).trim());
  if (!parsed) return unauth('Malformed API key');
  const row = await getDb().query.apiKeys.findFirst({
    where: and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.deletedAt)),
  });
  if (!row || row.revokedAt) return unauth('Unknown or revoked API key');
  if (!(await verifySecret(parsed.secret, row.keyHash))) return unauth('Invalid API key');
  // Any MCP scope gets past auth; per-tool the dispatch requires mcp:read for
  // read tools and mcp:write for action (write) tools.
  if (!row.scopes.includes('mcp:read') && !row.scopes.includes('mcp:write')) {
    reply.status(403).send({ success: false, error: 'Missing required scope: mcp:read or mcp:write' });
    return false;
  }
  request.apiKey = {
    companyId: row.companyId,
    scopes: row.scopes,
    keyId: row.id,
    prefix: row.prefix,
    channelId: row.channelId ?? null,
  };
  return true;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

export async function mcpRoutes(app: FastifyInstance) {
  // RFC 9728 protected-resource metadata (public).
  app.get('/.well-known/oauth-protected-resource', async (request) => ({
    resource: `${baseUrl(request)}/mcp`,
    scopes_supported: ['mcp:read', 'mcp:write'],
    bearer_methods_supported: ['header'],
  }));

  app.post('/mcp', async (request, reply) => {
    if (!(await mcpAuth(request, reply))) return reply;
    const body = (request.body ?? {}) as JsonRpcRequest;
    const id = body.id ?? null;
    const rpc = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const rpcErr = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (body.method) {
      case 'initialize':
        return rpc({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'auto-stock', version: '0.1.0' },
        });
      case 'tools/list':
        return rpc({
          tools: [...MCP_TOOLS, ...MCP_ACTION_TOOLS].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call': {
        const name = body.params?.name ?? '';
        const args = body.params?.arguments ?? {};
        const readTool = getMcpTool(name);
        const actionTool = getMcpActionTool(name);
        if (!readTool && !actionTool) return rpcErr(-32602, `Unknown tool: ${name}`);
        const ctx = { companyId: request.apiKey!.companyId };
        let ok = true;
        let errorMessage: string | null = null;
        let result: unknown;
        try {
          if (actionTool) {
            // Write tools require the mcp:write scope; a read-only key is rejected.
            if (!request.apiKey!.scopes.includes('mcp:write')) {
              throw new Error('Missing required scope: mcp:write');
            }
            // Confirm guard: no confirm ⇒ a no-mutation preview.
            result = args.confirm === true
              ? { executed: true, result: await actionTool.execute(args, ctx) }
              : { preview: true, ...(await actionTool.preview(args, ctx) as object) };
          } else {
            // Read tools require mcp:read.
            if (!request.apiKey!.scopes.includes('mcp:read')) {
              throw new Error('Missing required scope: mcp:read');
            }
            result = await readTool!.handler(args, ctx);
          }
        } catch (err) {
          ok = false;
          errorMessage = (err as Error).message;
        }
        // Audit (best-effort — never fail the call).
        try {
          await getDb().insert(mcpAuditLog).values({
            companyId: ctx.companyId,
            keyPrefix: request.apiKey!.prefix,
            toolName: name,
            args: (body.params?.arguments ?? {}) as Record<string, unknown>,
            ok,
            errorMessage,
          });
        } catch {
          // swallow
        }
        if (!ok) return rpcErr(-32603, errorMessage ?? 'Tool error');
        return rpc({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      }
      default:
        return rpcErr(-32601, `Method not found: ${body.method ?? ''}`);
    }
  });
}
