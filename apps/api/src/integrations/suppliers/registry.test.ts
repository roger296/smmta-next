/**
 * Unit tests for the connector registry. No DB; just exercises the
 * resolver and stub-registration hooks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectorConfigError,
  registerStubConnectorForTests,
  resetRegistryCacheForTests,
  resolveConnector,
} from './registry.js';
import { encrypt, resetCryptoForTests } from '../../shared/crypto/encrypt.js';
import { UneekConnector } from './uneek.connector.js';
import type { SupplierConnector } from './types.js';

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'registry-test-key-some-entropy-zzzz';
  resetCryptoForTests();
  resetRegistryCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  resetCryptoForTests();
  resetRegistryCacheForTests();
});

describe('resolveConnector', () => {
  it('returns a UneekConnector for connectorKind=UNEEK', () => {
    const supplier = {
      id: 'sup-1',
      connectorKind: 'UNEEK',
      apiBaseUrl: 'https://api.uneekclothing.example/',
      apiKeyEnc: encrypt('plaintext-key'),
      apiAuthScheme: 'bearer',
    };
    const c = resolveConnector(supplier);
    expect(c).toBeInstanceOf(UneekConnector);
  });

  it('caches per supplier id', () => {
    const supplier = {
      id: 'sup-cached',
      connectorKind: 'UNEEK',
      apiBaseUrl: 'https://api.uneekclothing.example/',
      apiKeyEnc: encrypt('k'),
      apiAuthScheme: 'bearer',
    };
    const a = resolveConnector(supplier);
    const b = resolveConnector(supplier);
    expect(a).toBe(b);
  });

  it('throws on connectorKind=NONE', () => {
    expect(() =>
      resolveConnector({
        id: 'sup',
        connectorKind: 'NONE',
        apiBaseUrl: null,
        apiKeyEnc: null,
        apiAuthScheme: 'bearer',
      }),
    ).toThrow(ConnectorConfigError);
  });

  it('throws when apiBaseUrl is missing', () => {
    expect(() =>
      resolveConnector({
        id: 'sup',
        connectorKind: 'UNEEK',
        apiBaseUrl: null,
        apiKeyEnc: encrypt('k'),
        apiAuthScheme: 'bearer',
      }),
    ).toThrow(/apiBaseUrl/);
  });

  it('throws when apiKeyEnc is missing', () => {
    expect(() =>
      resolveConnector({
        id: 'sup',
        connectorKind: 'UNEEK',
        apiBaseUrl: 'https://x/',
        apiKeyEnc: null,
        apiAuthScheme: 'bearer',
      }),
    ).toThrow(/apiKey/);
  });

  it('throws on an unknown connectorKind', () => {
    expect(() =>
      resolveConnector({
        id: 'sup',
        connectorKind: 'NOT_A_REAL_KIND',
        apiBaseUrl: 'https://x/',
        apiKeyEnc: encrypt('k'),
        apiAuthScheme: 'bearer',
      }),
    ).toThrow(/Unknown connectorKind/);
  });

  it('refuses to instantiate a STUB connector outside test registration', () => {
    expect(() =>
      resolveConnector({
        id: 'sup',
        connectorKind: 'STUB',
        apiBaseUrl: 'https://x/',
        apiKeyEnc: encrypt('k'),
        apiAuthScheme: 'bearer',
      }),
    ).toThrow(/STUB connector must be registered via registerStubConnectorForTests/);
  });

  it('returns the registered stub when one is set', () => {
    const stub: SupplierConnector = {
      async getStockAndPrice() { return []; },
      async placeOrder() { return { orderRef: 'STUB-1', status: 'ACCEPTED' }; },
      async getOrderStatus() { return { orderRef: 'x', status: 'OK' }; },
      async cancelOrder() { return { ok: true }; },
    };
    registerStubConnectorForTests('sup-stub', stub);
    const c = resolveConnector({
      id: 'sup-stub',
      connectorKind: 'STUB',
      apiBaseUrl: null,
      apiKeyEnc: null,
      apiAuthScheme: 'bearer',
    });
    expect(c).toBe(stub);
  });
});
