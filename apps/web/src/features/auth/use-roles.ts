/**
 * The current user's roles, read from the JWT (Aug-2026 feedback set, E-4).
 *
 * The server is the authority — `requireRole` refuses regardless of what the
 * client believes. This exists so the UI can **hide** an action the role
 * cannot perform rather than merely disabling it: a disabled button a baker
 * cannot explain is worse than no button, and the tester's complaint was about
 * dead ends, not about missing affordances.
 */
import * as React from 'react';
import { decodeJwt, getToken } from '@/lib/auth';

export type Role = 'head_baker' | 'site_manager' | 'admin';

export function readRoles(): string[] {
  const token = getToken();
  if (!token) return [];
  return decodeJwt(token)?.roles ?? [];
}

/** Admin passes every check without being named in it — mirrors the server. */
export function roleAllows(roles: string[], allowed: readonly Role[]): boolean {
  if (roles.includes('admin')) return true;
  return allowed.some((r) => roles.includes(r));
}

export function useRoles(): { roles: string[]; can: (allowed: readonly Role[]) => boolean } {
  const roles = React.useMemo(readRoles, []);
  return React.useMemo(
    () => ({ roles, can: (allowed: readonly Role[]) => roleAllows(roles, allowed) }),
    [roles],
  );
}
