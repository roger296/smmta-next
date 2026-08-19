/**
 * A JWT-shaped token carrying roles, for tests that exercise role-gated UI.
 *
 * Only the payload is read client-side (`decodeJwt`), so the signature is a
 * placeholder — the server is the authority on whether a role may act, and
 * these specs are about what the UI SHOWS.
 */
export function tokenWithRoles(roles: string[], siteId: string | null = null): string {
  const payload = {
    userId: 'test-user',
    companyId: '11111111-1111-4111-8111-111111111111',
    email: 'test@example.invalid',
    roles,
    siteId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.test-signature`;
}
