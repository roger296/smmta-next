/**
 * Grouping the cake picker (Sept-2026 user testing, item 2).
 *
 * "separate bakes into three groups 'Corporate', 'Regular' and 'Other' with
 *  headers."
 *
 * The order is FIXED rather than derived from the data. A baker reads this
 * list at the start of every session and learns where their heading sits; a
 * group that moves because tonight happens to have no corporate bake is a
 * group they have to find again.
 */
import { describe, expect, it } from 'vitest';
import { groupBakes, type MenuBake } from './use-recipes';

const bake = (b: string, bakeType: MenuBake['bakeType']): MenuBake => ({
  bake: b,
  bakeType,
  isActive: true,
});

describe('groupBakes', () => {
  it('orders the groups Corporate, Regular, Other regardless of input order', () => {
    const groups = groupBakes([
      bake('Staff Experiment', 'OTHER'),
      bake('Victoria Sponge', 'REGULAR'),
      bake('Away Day Bake', 'CORPORATE'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Corporate', 'Regular', 'Other']);
  });

  it('drops an empty group rather than leaving a heading with nothing under it', () => {
    const groups = groupBakes([bake('Victoria Sponge', 'REGULAR')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Regular');
  });

  it('keeps every cake within its group, in the order the server sent them', () => {
    // The server sorts by name; re-sorting here would fight it and make the
    // list order depend on which screen you are looking at.
    const groups = groupBakes([
      bake('Battenburg', 'REGULAR'),
      bake('Away Day Bake', 'CORPORATE'),
      bake('Victoria Sponge', 'REGULAR'),
    ]);
    expect(groups[1]!.bakes.map((b) => b.bake)).toEqual(['Battenburg', 'Victoria Sponge']);
  });

  it('is empty for an empty or absent menu', () => {
    // A venue with nothing active must render the "ask head office" notice,
    // not an unexplained blank — the same failure mode as F-6.
    expect(groupBakes([])).toEqual([]);
    expect(groupBakes(undefined)).toEqual([]);
  });
});
