/**
 * How a sitting is labelled on the venue picker (Sept-2026, item 8 follow-up).
 *
 * A bare BumbleBee uuid is not something anybody recognises, and two sittings
 * on one day would be two indistinguishable rows. The time is what makes one
 * identifiable to the baker who just finished it.
 */
import { describe, expect, it } from 'vitest';
import { describeSession, type AwaitingSession } from './use-consumption';

const session = (over: Partial<AwaitingSession> = {}): AwaitingSession => ({
  sessionId: 'bb-abcdef-0123',
  sessionDate: '2026-09-16',
  startsAt: '2026-09-16T18:30:00Z',
  covers: 24,
  ...over,
});

describe('describeSession', () => {
  it('reads as a time and a guest count', () => {
    expect(describeSession(session())).toBe('18:30 · 24 guests');
  });

  it('uses a 24-hour British clock whatever the device is set to', () => {
    // A venue iPad handed out with US regional settings would otherwise say
    // "06:30 PM" against a rota that says 18:30.
    expect(describeSession(session())).not.toMatch(/PM/i);
  });

  it('copes with a sitting the feed gave no time for', () => {
    expect(describeSession(session({ startsAt: null }))).toBe('24 guests');
  });

  it('copes with no guest count', () => {
    expect(describeSession(session({ covers: 0 }))).toBe('18:30');
  });

  it('says "1 guest", not "1 guests"', () => {
    expect(describeSession(session({ covers: 1 }))).toBe('18:30 · 1 guest');
  });

  it('falls back to the id rather than rendering an empty chip', () => {
    // A row with no label at all is not something a baker can choose between.
    expect(describeSession(session({ startsAt: null, covers: 0 }))).toBe('bb-abcdef-0123');
  });
});
