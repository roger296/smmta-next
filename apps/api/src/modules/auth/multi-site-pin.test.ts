/**
 * Head bakers who work at more than one venue (Sept-2026 user testing, item 1).
 *
 * "We set a PIN per user which locks the user to a single location - some head
 *  bakers work at two locations … a system that defaults to a single location
 *  but has the option to add extra locations where the head baker could work.
 *  I would like to add this as a feature that the user (head baker) can add him
 *  or herself."
 *
 * Self-service was the owner's call, on the condition that it is logged and
 * reversible. What these hold down is the authorisation boundary either side of
 * that: a PIN can only ever act on venues the SERVER granted it, and a client
 * cannot widen its own scope.
 */
import { describe, expect, it } from 'vitest';
import { canAccessSite, type JwtPayload } from '../../shared/middleware/auth.js';

const LONDON_EAST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LONDON_SOUTH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BIRMINGHAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const pin = (over: Partial<JwtPayload> = {}): JwtPayload => ({
  userId: 'pin:1',
  companyId: 'co',
  email: 'baker@pin.local',
  roles: ['head_baker'],
  siteId: LONDON_EAST,
  siteIds: [LONDON_EAST],
  ...over,
});

describe('a single-venue PIN is unchanged', () => {
  it('may act on its own venue', () => {
    expect(canAccessSite(pin(), LONDON_EAST)).toBe(true);
  });

  it('may not act on another', () => {
    expect(canAccessSite(pin(), BIRMINGHAM)).toBe(false);
  });

  it('still works for a token issued before multi-venue existed', () => {
    // Those tokens carry no `siteIds` at all and stay valid for 12 hours.
    // Treating a missing list as "no venues" would have locked every baker out
    // of their own site at the moment this deployed.
    const legacy = pin({ siteIds: undefined });
    expect(canAccessSite(legacy, LONDON_EAST)).toBe(true);
    expect(canAccessSite(legacy, BIRMINGHAM)).toBe(false);
  });
});

describe('a two-venue PIN', () => {
  const both = pin({ siteIds: [LONDON_EAST, LONDON_SOUTH] });

  it('may act on either venue it was granted', () => {
    expect(canAccessSite(both, LONDON_EAST)).toBe(true);
    expect(canAccessSite(both, LONDON_SOUTH)).toBe(true);
  });

  it('may not act on one it was not', () => {
    expect(canAccessSite(both, BIRMINGHAM)).toBe(false);
  });

  it('may act on its second venue even while the token says it chose the first', () => {
    // The baker switches venue mid-shift. The token is not reissued, so the
    // chosen `siteId` still reads London East — the list is what authorises.
    expect(both.siteId).toBe(LONDON_EAST);
    expect(canAccessSite(both, LONDON_SOUTH)).toBe(true);
  });
});

describe('the scope cannot be widened from the client', () => {
  it('ignores a venue that is not in the signed list', () => {
    // `siteIds` is signed into the JWT at login from `device_pin_sites`. A
    // client that posts a different siteId is refused; a client that could put
    // one INTO the token would be a privilege escalation, which is why the
    // add-venue endpoint deliberately does not reissue the token.
    const forged = pin({ siteIds: [LONDON_EAST] });
    expect(canAccessSite(forged, BIRMINGHAM)).toBe(false);
  });

  it('an empty list still allows the token\'s own chosen venue', () => {
    expect(canAccessSite(pin({ siteIds: [] }), LONDON_EAST)).toBe(true);
    expect(canAccessSite(pin({ siteIds: [] }), LONDON_SOUTH)).toBe(false);
  });
});

describe('the people who may cross venues anyway', () => {
  it('admins are site-agnostic', () => {
    expect(canAccessSite(pin({ roles: ['admin'] }), BIRMINGHAM)).toBe(true);
  });

  it('a full user login carries no site scope', () => {
    expect(canAccessSite(pin({ siteId: null, siteIds: null }), BIRMINGHAM)).toBe(true);
  });
});
