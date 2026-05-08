/**
 * Connector error hierarchy. Connector implementations classify upstream
 * failures into one of these so the polling and placer workers can
 * apply the right retry policy:
 *
 *   - `SupplierAuthError`         — 401 / 403. Don't retry; alert ops; the
 *                                   credentials are wrong.
 *   - `SupplierBadRequestError`   — 400 / 422. Don't retry; the payload
 *                                   shape is wrong (a bug, not a transient).
 *   - `SupplierUpstreamError`     — 5xx. Retry with backoff.
 *   - `SupplierUnreachableError`  — DNS / connection refused / timeout.
 *                                   Retry with backoff.
 *   - `SupplierRejectedOrderError`— Their API said "we won't accept this
 *                                   order" — distinct from a network
 *                                   failure. Don't retry; surface to ops.
 */

export class SupplierError extends Error {
  public readonly status?: number;
  public readonly raw?: unknown;
  constructor(message: string, opts: { status?: number; raw?: unknown } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = opts.status;
    this.raw = opts.raw;
  }
}

export class SupplierAuthError extends SupplierError {}
export class SupplierBadRequestError extends SupplierError {}
export class SupplierUpstreamError extends SupplierError {}
export class SupplierUnreachableError extends SupplierError {}
export class SupplierRejectedOrderError extends SupplierError {}

export function isRetryable(err: unknown): boolean {
  return err instanceof SupplierUpstreamError || err instanceof SupplierUnreachableError;
}
