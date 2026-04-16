import { clearToken, getToken } from './auth';

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  'http://localhost:3000/api/v1';

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

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  searchParams?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, searchParams?: ApiFetchOptions['searchParams']): string {
  const url = new URL(
    path.startsWith('http') ? path : `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`,
  );
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
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
  const { body, searchParams, headers, ...rest } = opts;
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
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

  if (!response.ok) {
    throw new ApiError(
      envelope?.error ?? `Request failed with status ${response.status}`,
      response.status,
      envelope?.details,
    );
  }

  if (!envelope) {
    throw new ApiError('Empty response body', response.status);
  }

  if (!envelope.success) {
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
