/**
 * Runs one admin MCP call through the admin's own HTTP routes, signed in as
 * the key's user (docs/MCP-CONNECTOR.md). Nothing is reimplemented: the call
 * goes through the same route, validation, service code, ledger postings and
 * side effects as a click in the web UI, so the connector can do exactly what
 * that person can do there, no more and no less.
 *
 * The request is made in-process (`app.inject`) with a five-minute JWT for
 * the user, and every call is written to `mcp_audit` (key, user, route,
 * status; never the body).
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../config/database.js';
import { mcpAudit } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { API_PREFIX, isDenied, matchRoute, normalisePath } from './catalogue.js';

export interface AdminContext {
  app: FastifyInstance;
  user: { id: string; email: string; roles: string[] };
  keyPrefix: string;
  /** The key also carries `email:approve`. */
  canApprove: boolean;
}

export interface ApiCall {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface ApiResult {
  status: number;
  ok: boolean;
  /** Parsed JSON, or a note for a file such as a PDF. */
  body: unknown;
}

/** Longest response handed back in one call; longer ones are cut, with a note. */
export const MAX_RESPONSE_CHARS = 200_000;

export class ApiCallRefused extends Error {}

function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) qs.append(k, String(item));
    else qs.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export async function callApi(ctx: AdminContext, tool: string, call: ApiCall): Promise<ApiResult> {
  const method = call.method.toUpperCase();
  const path = normalisePath(call.path);
  if (isDenied(path, ctx.canApprove)) {
    await record(ctx, tool, method, path, 403);
    throw new ApiCallRefused(
      APPROVAL_HINT.test(path)
        ? `${method} ${path} is not open to this key: approving a campaign needs a key that also carries email:approve.`
        : `${method} ${path} is not open to the connector (see docs/MCP-CONNECTOR.md).`,
    );
  }
  if (!matchRoute(method, path)) {
    await record(ctx, tool, method, path, 404);
    throw new ApiCallRefused(`There is no ${method} ${path} route. Use admin_list_endpoints to see the routes.`);
  }

  const token = ctx.app.jwt.sign(
    { userId: ctx.user.id, companyId: getSingletonCompanyId(), email: ctx.user.email, roles: ctx.user.roles, via: `mcp:${ctx.keyPrefix}` },
    { expiresIn: '5m' },
  );
  const hasBody = call.body !== undefined && method !== 'GET' && method !== 'DELETE';
  const res = await ctx.app.inject({
    method: method as 'GET',
    url: `${API_PREFIX}${path}${queryString(call.query)}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(hasBody ? { payload: JSON.stringify(call.body) } : {}),
  });

  await record(ctx, tool, method, path, res.statusCode);
  const type = String(res.headers['content-type'] ?? '');
  let body: unknown;
  if (type.includes('json')) {
    body = res.payload.length > MAX_RESPONSE_CHARS ? truncated(res.payload) : safeJson(res.payload);
  } else if (type.startsWith('text/')) {
    body = res.payload.length > MAX_RESPONSE_CHARS ? `${res.payload.slice(0, MAX_RESPONSE_CHARS)}… (cut)` : res.payload;
  } else {
    body = { file: true, contentType: type || 'unknown', bytes: res.rawPayload.length, note: 'A file; open it in the admin to view or print it.' };
  }
  return { status: res.statusCode, ok: res.statusCode < 400, body };
}

const APPROVAL_HINT = /\/approve$/;

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function truncated(s: string) {
  return {
    truncated: true,
    note: `The response was ${s.length} characters, more than the ${MAX_RESPONSE_CHARS} one call returns. Ask for a smaller page (page / pageSize / limit) or a narrower filter.`,
    start: s.slice(0, MAX_RESPONSE_CHARS),
  };
}

async function record(ctx: AdminContext, tool: string, method: string, path: string, status: number): Promise<void> {
  await getDb()
    .insert(mcpAudit)
    .values({
      companyId: getSingletonCompanyId(),
      keyPrefix: ctx.keyPrefix,
      userId: ctx.user.id,
      tool: tool.slice(0, 80),
      method,
      path,
      status,
      ok: status < 400,
    })
    .catch(() => undefined);
}
