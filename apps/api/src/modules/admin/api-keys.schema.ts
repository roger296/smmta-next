import { z } from 'zod';

/**
 * Scope strings recognised today. The middleware only checks for
 * exact-match presence; this enum is purely a guard against typos
 * and a hint for OpenAPI consumers.
 */
export const apiKeyScopeSchema = z.enum([
  'storefront:read',
  'storefront:write',
  /** An external system posting orders to the order feed. */
  'orders:write',
  /** An external system reading an order's progress from the order feed. */
  'orders:read',
  /** Claude's email tools on the MCP server (docs/email/MCP.md). */
  'email:mcp',
  /** A person's key: may approve campaigns through MCP. */
  'email:approve',
  /** The admin MCP connector (docs/MCP-CONNECTOR.md): acts as the user who
   *  issued the key, with everything that user can do in the web UI. */
  'admin:mcp',
]);

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(apiKeyScopeSchema).default([]),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;
