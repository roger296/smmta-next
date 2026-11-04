import type { getDb } from '../../../config/database.js';
import type { DbTx } from '../../../shared/events/emit.js';

export type Db = ReturnType<typeof getDb>;
/** The root handle or a transaction: email services accept either, so a
 *  caller can make an email change part of its own transaction. */
export type Executor = Db | DbTx;
