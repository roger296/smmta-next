/**
 * Connector registry — maps a supplier row to its concrete
 * `SupplierConnector` instance.
 *
 * Lookup is by `supplier.connectorKind`. Instances are cached by
 * `supplier.id` so repeated calls within a worker run reuse the same
 * connector (and any internal HTTP client state). The cached instance is
 * rebuilt when any field it was built from changes, so an edit on the admin
 * Drop-ship tab (a new key, account number or rate limit) reaches a
 * long-running worker without a restart.
 *
 * Test harnesses bypass the registry and pass a stub connector directly
 * to the service layer — see `supplier.service.test.ts`.
 */
import { decrypt } from '../../shared/crypto/encrypt.js';
import { RalawiseConnector } from './ralawise.connector.js';
import { UneekConnector } from './uneek.connector.js';
import {
  deriveMinRequestIntervalMs,
  type SupplierConnector,
  type SupplierConnectorContext,
} from './types.js';

export type ConnectorKind = 'NONE' | 'UNEEK' | 'RALAWISE' | 'STUB';

export interface SupplierLikeRow {
  id: string;
  connectorKind: ConnectorKind | string;
  apiBaseUrl: string | null;
  apiKeyEnc: string | null;
  apiAuthScheme: string;
  /** Per-supplier rate-limit fields. See `deriveMinRequestIntervalMs`. */
  rateLimitRequests?: number | null;
  rateLimitWindowSeconds?: number | null;
  /** Explicit override (ms between requests). Wins over the derived
   *  rate-limit pair when both are set. */
  minRequestIntervalMs?: number | null;
  /** Our account (customer) number with the supplier. */
  accountNumber?: string | null;
  /** The email address on our account with the supplier. */
  customerAccountEmail?: string | null;
}

/** Stub connectors registered by tests, by supplier id. */
const stubs = new Map<string, SupplierConnector>();
/** Built connectors by supplier id, with the fields they were built from. */
const cache = new Map<string, { key: string; connector: SupplierConnector }>();

export function resetRegistryCacheForTests(): void {
  cache.clear();
  stubs.clear();
}

/**
 * Stub registration hook — used from inside test files to override the
 * registry without bringing the AES helper or fetch into the test path.
 */
export function registerStubConnectorForTests(
  supplierId: string,
  connector: SupplierConnector,
): void {
  stubs.set(supplierId, connector);
}

export class ConnectorConfigError extends Error {}

/** Every field a connector is built from. */
function buildKey(supplier: SupplierLikeRow): string {
  return JSON.stringify([
    supplier.connectorKind,
    supplier.apiBaseUrl,
    supplier.apiKeyEnc,
    supplier.apiAuthScheme,
    supplier.accountNumber ?? null,
    supplier.customerAccountEmail ?? null,
    supplier.rateLimitRequests ?? null,
    supplier.rateLimitWindowSeconds ?? null,
    supplier.minRequestIntervalMs ?? null,
  ]);
}

export function resolveConnector(supplier: SupplierLikeRow): SupplierConnector {
  const stub = stubs.get(supplier.id);
  if (stub) return stub;
  const key = buildKey(supplier);
  const cached = cache.get(supplier.id);
  if (cached && cached.key === key) return cached.connector;

  if (!supplier.connectorKind || supplier.connectorKind === 'NONE') {
    throw new ConnectorConfigError(
      `Supplier ${supplier.id} has connectorKind=NONE — drop-ship integration not configured`,
    );
  }
  if (!supplier.apiBaseUrl) {
    throw new ConnectorConfigError(`Supplier ${supplier.id} has no apiBaseUrl`);
  }
  if (!supplier.apiKeyEnc) {
    throw new ConnectorConfigError(`Supplier ${supplier.id} has no apiKey`);
  }

  const apiKey = decrypt(supplier.apiKeyEnc);
  const ctx: SupplierConnectorContext = {
    apiKey,
    apiBaseUrl: supplier.apiBaseUrl,
    apiAuthScheme: supplier.apiAuthScheme,
    // Connectors only see one number. The registry handles the
    // "rate limit pair vs explicit override" decision via the
    // shared helper.
    minRequestIntervalMs: deriveMinRequestIntervalMs({
      minRequestIntervalMs: supplier.minRequestIntervalMs ?? null,
      rateLimitRequests: supplier.rateLimitRequests ?? null,
      rateLimitWindowSeconds: supplier.rateLimitWindowSeconds ?? null,
    }),
    accountNumber: supplier.accountNumber ?? null,
    customerAccountEmail: supplier.customerAccountEmail ?? null,
  };

  let conn: SupplierConnector;
  switch (supplier.connectorKind) {
    case 'UNEEK':
      conn = new UneekConnector(ctx);
      break;
    case 'RALAWISE':
      conn = new RalawiseConnector(ctx);
      break;
    case 'STUB':
      throw new ConnectorConfigError(
        'STUB connector must be registered via registerStubConnectorForTests; ' +
          'do not instantiate STUB outside test code paths',
      );
    default:
      throw new ConnectorConfigError(
        `Unknown connectorKind "${supplier.connectorKind}" for supplier ${supplier.id}`,
      );
  }
  cache.set(supplier.id, { key, connector: conn });
  return conn;
}
