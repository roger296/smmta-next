import { z } from 'zod';

/**
 * Scope strings recognised today. The middleware only checks for
 * exact-match presence; this enum is purely a guard against typos
 * and a hint for OpenAPI consumers.
 */
export const apiKeyScopeSchema = z.enum([
  'storefront:read',
  'storefront:write',
]);

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(apiKeyScopeSchema).default([]),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;
