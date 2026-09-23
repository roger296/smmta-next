/**
 * Who is acting, as a person's name — for records that must say who did it.
 *
 * Taken from the signed token, never from the request body: a name the client
 * sends is a name the client can get wrong (or fake), and the stock take's
 * "counted by" exists precisely so two counters can trust whose number is
 * whose.
 *
 *   PIN token    → its `label`, the person's name on the shared iPad
 *   email login  → `users.name` for that user id
 *   anything else → the email, and failing that "Unknown"
 *
 * A PIN token's `userId` is `pin:<uuid>`; an email user's is a bare uuid. Only
 * the latter is looked up, because `users.id` is a uuid column and querying it
 * with `pin:…` would throw.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { users } from '../../db/schema/index.js';
import type { JwtPayload } from '../middleware/auth.js';

export interface Actor {
  userId: string | null;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function actorOf(user: Partial<JwtPayload> | undefined | null): Promise<Actor> {
  const userId = user?.userId ?? null;
  const label = user?.label?.trim();
  if (label) return { userId, name: label };
  if (userId && UUID.test(userId)) {
    const row = await getDb().query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true },
    });
    if (row?.name?.trim()) return { userId, name: row.name.trim() };
  }
  return { userId, name: user?.email?.trim() || 'Unknown' };
}
