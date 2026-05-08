/**
 * Connector registry — maps a supplier row to its concrete
 * `SupplierConnector` instance.
 *
 * Lookup is by `supplier.connectorKind`. Instances are cached by
 * `supplier.id` so repeated calls within a worker run reuse the same
 * connector (and any internal HTTP client state).
 *
 * Test harnesses bypass the registry and pass a stub connector directly
 * to the service layer — see `supplier.service.test.ts`.
 */
import { decrypt } from '../../shared/crypto/encrypt.js';
import { UneekConnector } from './uneek.connector.js';
import type { SupplierConnector, SupplierConnectorContext } from './types.js';

export type ConnectorKind = 'NONE' | 'UNEEK' | 'STUB';

export interface SupplierLikeRow {
  id: string;
  connectorKind: ConnectorKind | string;
  apiBaseUrl: string | null;
  apiKeyEnc: string | null;
  apiAuthScheme: string;
}

const cache = new Map<string, SupplierConnector>();

export function resetRegistryCacheForTests(): void {
  cache.clear();
}

/**
 * Stub registration hook — used from inside test files to override the
 * registry without bringing the AES helper or fetch into the test path.
 */
export function registerStubConnectorForTests(
  supplierId: string,
  connector: SupplierConnector,
): void {
  cache.set(supplierId, connector);
}

export class ConnectorConfigError extends Error {}

export function resolveConnector(supplier: SupplierLikeRow): SupplierConnector {
  const cached = cache.get(supplier.id);
  if (cached) return cached;

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
  };

  let conn: SupplierConnector;
  switch (supplier.connectorKind) {
    case 'UNEEK':
      conn = new UneekConnector(ctx);
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
  cache.set(supplier.id, conn);
  return conn;
}
