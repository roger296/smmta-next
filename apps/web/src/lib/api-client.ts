import { clearToken, getToken } from './auth';

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  'http://localhost:8080/api/v1';

/**
 * Mirror of the API's `MAX_PAGE_SIZE` (`apps/api/src/shared/utils/pagination.ts`).
 *
 * Asking for more than this does not truncate — it **400s**, and on 12 Aug that
 * was invisible: the stock-take screen asked for twice the cap, the product
 * lookup errored, and every row on the count sheet rendered as a hex fragment
 * (defect D-1). `page-size-guard.test.ts` fails the build if any request in
 * `apps/web/src` exceeds it, so the two can't drift apart again silently.
 */
export const MAX_PAGE_SIZE = 250;

export class ApiError extends Error {
  public readonly status: number;
  public readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  details?: unknown;
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type SearchParamValue = string | number | boolean | undefined | null;

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /**
   * A body to send AS IS, without JSON.stringify — for the CSV import, which
   * posts the file's text under Content-Type: text/csv. Mutually exclusive
   * with `body`.
   */
  rawBody?: string;
  searchParams?: Record<string, SearchParamValue | SearchParamValue[]>;
  /**
   * Non-2xx statuses whose envelope should be RETURNED rather than thrown.
   *
   * The CSV import answers 422 with the full row-by-row report attached, and
   * that report is the thing the operator needs to read. Throwing it away and
   * showing "Request failed with status 422" would hide the only useful part
   * of the response.
   */
  acceptStatuses?: number[];
}

function buildUrl(path: string, searchParams?: ApiFetchOptions['searchParams']): string {
  // Assemble the raw URL. It can end up absolute (http://host/path) OR relative (/api/v1/path)
  // depending on whether VITE_API_BASE_URL was set to an absolute or relative URL.
  const raw = path.startsWith('http')
    ? path
    : `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

  // The URL constructor requires an absolute URL. When raw is relative, supply the current
  // origin as a base so the URL can be parsed. In production with VITE_API_BASE_URL=/api/v1
  // the request will be sent to the same origin (served by Nginx reverse-proxying /api/).
  const base =
    raw.startsWith('http') || typeof window === 'undefined' ? undefined : window.location.origin;
  const url = new URL(raw, base);

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
      // An array must become REPEATED keys — ?k=a&k=b. String(['a','b']) is
      // "a,b", a single value that no enum-validated parameter will accept, so
      // the request 400s and the caller sees an empty result rather than an
      // error. That is exactly how the ingredient search silently found
      // nothing: itemKind arrived as "INGREDIENT,PACKAGING".
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v === undefined || v === null || v === '') continue;
          url.searchParams.append(key, String(v));
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Fetches from the SMMTA API. Attaches JWT from localStorage, unwraps the
 * success/data envelope, throws ApiError on non-success responses.
 * On 401: clears token and redirects to /login.
 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const { body, rawBody, searchParams, headers, acceptStatuses, ...rest } = opts;
  const token = getToken();

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(headers as Record<string, string> | undefined),
  };

  const response = await fetch(buildUrl(path, searchParams), {
    ...rest,
    headers: finalHeaders,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    clearToken();
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError('Unauthorized', 401);
  }

  let envelope: ApiEnvelope<T> | undefined;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // Non-JSON response
  }

  if (!response.ok && !acceptStatuses?.includes(response.status)) {
    throw new ApiError(
      envelope?.error ?? `Request failed with status ${response.status}`,
      response.status,
      envelope?.details,
    );
  }

  if (!envelope) {
    throw new ApiError('Empty response body', response.status);
  }

  if (!envelope.success && !acceptStatuses?.includes(response.status)) {
    throw new ApiError(envelope.error ?? 'Request failed', response.status, envelope.details);
  }

  // Paginated result
  if (
    envelope.total !== undefined &&
    envelope.page !== undefined &&
    envelope.pageSize !== undefined
  ) {
    return {
      data: envelope.data,
      total: envelope.total,
      page: envelope.page,
      pageSize: envelope.pageSize,
      totalPages: envelope.totalPages ?? 0,
    } as unknown as T;
  }

  return envelope.data as T;
}

/**
 * Fetches a FILE from the API — a CSV export, say — rather than a JSON envelope.
 *
 * `apiFetch` cannot do this: it always parses the body as JSON and unwraps
 * `data`, so a text/csv response comes back as "Empty response body". This
 * shares the URL building, the bearer token and the 401 handling, and returns
 * the raw Blob plus the filename the server asked for.
 *
 * A plain `<a href>` is not an option either — the JWT lives in localStorage,
 * not a cookie, so an anchor navigation arrives unauthenticated and the user
 * gets bounced to /login instead of a download.
 */
export async function apiFetchBlob(
  path: string,
  opts: Omit<ApiFetchOptions, 'body'> = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const { searchParams, headers, ...rest } = opts;
  const token = getToken();

  const response = await fetch(buildUrl(path, searchParams), {
    ...rest,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  });

  if (response.status === 401) {
    clearToken();
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError('Unauthorized', 401);
  }

  if (!response.ok) {
    // A failure still answers in the JSON envelope, so surface its message
    // rather than a bare status code.
    let message = `Request failed with status ${response.status}`;
    try {
      const envelope = (await response.json()) as ApiEnvelope<unknown>;
      if (envelope?.error) message = envelope.error;
    } catch {
      // Non-JSON error body — keep the status message.
    }
    throw new ApiError(message, response.status);
  }

  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('Content-Disposition')),
  };
}

/** `attachment; filename="products-2026-09-16.csv"` -> the filename. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Hands a fetched Blob to the browser as a download.
 *
 * The object URL is revoked afterwards; without that, every export holds its
 * whole file in memory until the tab is closed, and head office exports a
 * catalogue of thousands of rows repeatedly while working through it.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
