/**
 * The admin routes the MCP connector may call (docs/MCP-CONNECTOR.md).
 *
 * Every route registered under /api/v1 is recorded as the app starts (an
 * `onRoute` hook in app.ts). The connector may call any of them except the
 * few below, which are not things a person does through the web UI, or which
 * would let a key widen its own powers:
 *
 *  - /auth/*                 signing in (the connector is already signed in)
 *  - /admin/api-keys*        issuing keys: a key must never mint another key
 *  - /storefront/*, /order-feed/*, /webhooks/*, /unsubscribe
 *                            called by the shops, outside systems, payment
 *                            and mail providers, or customers, not the admin
 *  - /email/campaigns/:id/approve
 *                            approving a campaign stays with a person unless
 *                            the key also carries `email:approve`
 *                            (docs/email/MCP.md)
 *
 * Anything else is reachable, and is checked by the route itself exactly as
 * it is when the web UI calls it.
 */

export interface RouteEntry {
  method: string;
  /** Path below /api/v1, with `:param` placeholders. */
  path: string;
  pattern: RegExp;
}

const API_PREFIX = '/api/v1';
const routes = new Map<string, RouteEntry>();

const DENIED: RegExp[] = [
  /^\/auth(\/|$)/,
  /^\/admin\/api-keys(\/|$)/,
  /^\/storefront(\/|$)/,
  /^\/order-feed(\/|$)/,
  /^\/webhooks(\/|$)/,
  /^\/unsubscribe(\/|$)/,
];
const APPROVE = /^\/email\/campaigns\/[^/]+\/approve$/;

function toPattern(path: string): RegExp {
  const body = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}$`);
}

/** Called from the onRoute hook for every route the app registers. */
export function recordRoute(method: string | string[], url: string): void {
  if (!url.startsWith(`${API_PREFIX}/`)) return;
  const path = url.slice(API_PREFIX.length);
  for (const m of Array.isArray(method) ? method : [method]) {
    const verb = m.toUpperCase();
    if (verb === 'HEAD' || verb === 'OPTIONS') continue;
    routes.set(`${verb} ${path}`, { method: verb, path, pattern: toPattern(path) });
  }
}

export function isDenied(path: string, canApprove: boolean): boolean {
  if (DENIED.some((re) => re.test(path))) return true;
  return !canApprove && APPROVE.test(path);
}

/** The routes the connector may call, sorted by path. */
export function allowedRoutes(canApprove: boolean): RouteEntry[] {
  return [...routes.values()]
    .filter((r) => !isDenied(r.path, canApprove))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Strip an optional /api/v1 prefix and any query string, and resolve `.`
 *  and `..` segments (plain or %2e-encoded) first, so a path such as
 *  `/products/../admin/api-keys` is checked as the route it really reaches. */
export function normalisePath(path: string): string {
  let p = path.trim();
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  if (!p.startsWith('/')) p = `/${p}`;
  p = new URL(p.replace(/\\/g, '/'), 'http://connector.invalid').pathname;
  if (p === API_PREFIX || p.startsWith(`${API_PREFIX}/`)) p = p.slice(API_PREFIX.length) || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** The registered route a concrete method + path would hit, if any. */
export function matchRoute(method: string, path: string): RouteEntry | undefined {
  const verb = method.toUpperCase();
  const exact = routes.get(`${verb} ${path}`);
  if (exact) return exact;
  for (const r of routes.values()) if (r.method === verb && r.pattern.test(path)) return r;
  return undefined;
}

export { API_PREFIX };
