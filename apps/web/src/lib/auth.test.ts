import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearToken, decodeJwt, getToken, isAuthenticated, setToken } from './auth';

// A valid-looking JWT with payload { exp: far-future }
// header {"alg":"HS256","typ":"JWT"} / payload {"userId":"u","companyId":"c","email":"e","roles":["admin"],"exp":9999999999}
const FUTURE_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1IiwiY29tcGFueUlkIjoiYyIsImVtYWlsIjoiZSIsInJvbGVzIjpbImFkbWluIl0sImV4cCI6OTk5OTk5OTk5OX0.signature';

// Expired token: exp=1
const EXPIRED_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1IiwiY29tcGFueUlkIjoiYyIsImVtYWlsIjoiZSIsInJvbGVzIjpbImFkbWluIl0sImV4cCI6MX0.signature';

describe('token storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('stores and retrieves a token', () => {
    setToken('abc');
    expect(getToken()).toBe('abc');
  });
  it('clears a token', () => {
    setToken('abc');
    clearToken();
    expect(getToken()).toBeNull();
  });
  it('returns null when no token present', () => {
    expect(getToken()).toBeNull();
  });
});

describe('decodeJwt', () => {
  it('decodes a valid JWT payload', () => {
    const decoded = decodeJwt(FUTURE_TOKEN);
    expect(decoded).toEqual({
      userId: 'u',
      companyId: 'c',
      email: 'e',
      roles: ['admin'],
      exp: 9999999999,
    });
  });
  it('returns null for malformed token', () => {
    expect(decodeJwt('not-a-jwt')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(decodeJwt('')).toBeNull();
  });
});

describe('isAuthenticated', () => {
  beforeEach(() => window.localStorage.clear());

  it('returns false when no token', () => {
    expect(isAuthenticated()).toBe(false);
  });
  it('returns true for future-exp token', () => {
    setToken(FUTURE_TOKEN);
    expect(isAuthenticated()).toBe(true);
  });
  it('returns false for expired token', () => {
    setToken(EXPIRED_TOKEN);
    expect(isAuthenticated()).toBe(false);
  });
});
