const TOKEN_KEY = 'smmta_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export interface DecodedJwt {
  userId: string;
  companyId: string;
  email: string;
  roles: string[];
  /** A PIN sign-in's person name (the PIN label). Absent on email sign-ins. */
  label?: string;
  iat?: number;
  exp?: number;
}

export function decodeJwt(token: string): DecodedJwt | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    const json = atob(padded);
    return JSON.parse(json) as DecodedJwt;
  } catch {
    return null;
  }
}

/**
 * The signed-in user's id, as the server records it on what they save
 * (`pin:<uuid>` for a PIN sign-in, a bare uuid for an email one). Used to say
 * "you" instead of your own name; the server, not this, decides who saved what.
 */
export function currentUserId(): string | null {
  const token = getToken();
  if (!token) return null;
  return decodeJwt(token)?.userId ?? null;
}

export function isAuthenticated(): boolean {
  const token = getToken();
  if (!token) return false;
  const decoded = decodeJwt(token);
  if (!decoded?.exp) return true;
  return decoded.exp * 1000 > Date.now();
}
