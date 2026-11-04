/**
 * A small fixed-window rate limiter keyed by client IP, for the public email
 * pages (30 a minute). In memory, per process: the API runs as one process.
 */
export class IpRateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
  ) {}

  /** True when this request is within the limit. */
  allow(ip: string, now = Date.now()): boolean {
    const h = this.hits.get(ip);
    if (!h || now - h.windowStart >= this.windowMs) {
      this.hits.set(ip, { windowStart: now, count: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [ip, h] of this.hits) if (now - h.windowStart >= this.windowMs) this.hits.delete(ip);
  }

  reset(): void {
    this.hits.clear();
  }
}

/** The visitor's address: the first X-Forwarded-For hop (the storefront
 *  proxies these pages), else the socket address. */
export function clientIp(headers: Record<string, unknown>, socketIp: string): string {
  const xff = headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : typeof xff === 'string' ? xff : '')?.split(',')[0]?.trim();
  return first || socketIp;
}
