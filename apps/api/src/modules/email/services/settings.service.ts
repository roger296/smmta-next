/**
 * Email settings: one row per key in `email_settings`, every key defaulting to
 * lib/settings-defaults.ts. The first read writes any missing defaults, so the
 * table (and the admin Settings page) always shows the whole set.
 */
import { getDb } from '../../../config/database.js';
import { emailSettings } from '../../../db/schema/index.js';
import {
  EMAIL_SETTING_DEFAULTS,
  defaultSettings,
  type EmailSettingKey,
  type EmailSettings,
} from '../lib/settings-defaults.js';

export class SettingsValidationError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored object setting over its default, so a key added to the defaults
 *  later still has a value (two levels deep, for automations). */
function mergeDefault(def: unknown, stored: unknown): unknown {
  if (!isObj(def) || !isObj(stored)) return stored;
  const out: Record<string, unknown> = { ...def };
  for (const [k, v] of Object.entries(stored)) out[k] = isObj(def[k]) && isObj(v) ? { ...(def[k] as object), ...v } : v;
  return out;
}

export async function getEmailSettings(): Promise<EmailSettings> {
  const db = getDb();
  const rows = await db.select().from(emailSettings);
  const settings = defaultSettings() as Record<string, unknown>;
  const present = new Set<string>();
  for (const r of rows) {
    if (r.key in settings) {
      settings[r.key] = mergeDefault(settings[r.key], r.value);
      present.add(r.key);
    }
  }
  const missing = Object.keys(EMAIL_SETTING_DEFAULTS).filter((k) => !present.has(k));
  if (missing.length > 0) {
    await db
      .insert(emailSettings)
      .values(missing.map((key) => ({ key, value: settings[key] as object, updatedBy: 'system' })))
      .onConflictDoNothing();
  }
  return settings as EmailSettings;
}

/** Checks a value against its default's shape: same type, and for objects the
 *  same keys with values of the same type (replenishment days may add keys). */
export function validateSetting(key: string, value: unknown): void {
  if (!(key in EMAIL_SETTING_DEFAULTS)) throw new SettingsValidationError(`unknown setting ${key}`);
  const def = (EMAIL_SETTING_DEFAULTS as Record<string, unknown>)[key];
  const fail = (why: string) => {
    throw new SettingsValidationError(`${key}: ${why}`);
  };
  if (typeof def === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('must be a number ≥ 0');
    return;
  }
  if (typeof def === 'boolean') {
    if (typeof value !== 'boolean') fail('must be true or false');
    return;
  }
  if (typeof def === 'string') {
    if (typeof value !== 'string') fail('must be text');
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be an object');
  const v = value as Record<string, unknown>;
  for (const [k, dv] of Object.entries(def as Record<string, unknown>)) {
    if (!(k in v)) fail(`missing ${k}`);
    if (typeof v[k] !== typeof dv) fail(`${k} must be ${typeof dv}`);
    if (typeof dv === 'number' && (!Number.isFinite(v[k] as number) || (v[k] as number) < 0)) fail(`${k} must be ≥ 0`);
    if (typeof dv === 'string' && /time|start|end/.test(k) && !/^\d{2}:\d{2}$/.test(v[k] as string)) {
      fail(`${k} must be HH:MM`);
    }
  }
  if (key === 'automations') {
    for (const [name, cfg] of Object.entries(v)) {
      const defCfg = (def as Record<string, Record<string, unknown>>)[name];
      if (!defCfg) fail(`unknown automation ${name}`);
      if (typeof cfg !== 'object' || cfg === null) fail(`${name} must be an object`);
      for (const [k, dv] of Object.entries(defCfg!)) {
        const val = (cfg as Record<string, unknown>)[k];
        if (typeof val !== typeof dv) fail(`${name}.${k} must be ${typeof dv}`);
        if (typeof dv === 'number' && (!Number.isFinite(val as number) || (val as number) < 0)) fail(`${name}.${k} must be ≥ 0`);
      }
    }
    return;
  }
  if (key !== 'replenishment_days') {
    for (const k of Object.keys(v)) if (!(k in (def as object))) fail(`unknown field ${k}`);
  } else {
    for (const [k, n] of Object.entries(v)) if (typeof n !== 'number' || n <= 0) fail(`${k} must be a number of days`);
  }
}

export async function updateEmailSettings(
  patch: Partial<Record<EmailSettingKey, unknown>>,
  actor: string,
): Promise<EmailSettings> {
  for (const [k, v] of Object.entries(patch)) validateSetting(k, v);
  const db = getDb();
  for (const [key, value] of Object.entries(patch)) {
    await db
      .insert(emailSettings)
      .values({ key, value: value as object, updatedBy: actor })
      .onConflictDoUpdate({
        target: emailSettings.key,
        set: { value: value as object, updatedBy: actor, updatedAt: new Date() },
      });
  }
  return getEmailSettings();
}
