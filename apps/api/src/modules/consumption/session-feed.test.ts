/**
 * Why a day's session list is empty (Sept-2026, item 8 follow-up).
 *
 * The venue's End of Bake screen now OFFERS the day's sittings instead of
 * asking a baker to type a BumbleBee id. BumbleBee session polling is not
 * wired in production, so that list is empty there today — and a picker that
 * can only ever be empty, with no explanation, would be a worse dead end than
 * the typed field it replaced.
 *
 * `feedStatus` is what lets the screen tell the two apart, so it has to be
 * right for the reason rather than merely right for the count.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../config/database.js';
import { resetEnvForTests } from '../../config/env.js';
import { sessionFeedStatus } from './bumblebee-sessions.js';

const ORIGINAL = process.env.BUMBLEBEE_API_BASE_URL;

beforeEach(() => {
  delete process.env.BUMBLEBEE_API_BASE_URL;
  // getEnv() memoises, so a test that changes the variable has to clear it or
  // it is asserting against whatever the first call in the process happened to
  // read.
  resetEnvForTests();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BUMBLEBEE_API_BASE_URL;
  else process.env.BUMBLEBEE_API_BASE_URL = ORIGINAL;
  resetEnvForTests();
});

afterAll(() => closeDatabase());

describe('sessionFeedStatus', () => {
  it('reports not_connected when no BumbleBee URL is configured', () => {
    // The live state today. The screen says "session details do not come
    // across from BumbleBee yet" and offers the typed field instead of
    // showing a blank list.
    expect(sessionFeedStatus()).toBe('not_connected');
  });

  it('reports not_connected for an empty string, not just an absent one', () => {
    // `BUMBLEBEE_API_BASE_URL` defaults to '' in the env schema, so absent and
    // empty are the same state and must not diverge here.
    process.env.BUMBLEBEE_API_BASE_URL = '';
    resetEnvForTests();
    expect(sessionFeedStatus()).toBe('not_connected');
  });

  it('reports live once a URL is configured', () => {
    process.env.BUMBLEBEE_API_BASE_URL = 'https://bumblebee.example.invalid';
    resetEnvForTests();
    expect(sessionFeedStatus()).toBe('live');
  });
});
