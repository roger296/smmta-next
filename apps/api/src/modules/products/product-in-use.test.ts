/**
 * The message a user gets when a product cannot be deleted.
 *
 * Roger's requirement was specifically that the refusal be COMPLETE and
 * HELPFUL — a bare "product is in use" makes someone check five sites and
 * every recipe by hand to find out why. These assert the message actually
 * names the sites, the quantities and the recipes, and says what to do.
 */
import { describe, expect, it } from 'vitest';
import { ProductInUseError } from './product.service.js';

const stock = (siteName: string, onHand: string, stockUom = 'kg') => ({
  siteName,
  onHand,
  stockUom,
});
const use = (bake: string, siteName = 'Global', version = 1) => ({
  recipeId: '00000000-0000-0000-0000-000000000001',
  bake,
  siteName,
  version,
});

describe('ProductInUseError', () => {
  it('names the site and the quantity when stock is the blocker', () => {
    const err = new ProductInUseError('Caster Sugar', [stock('Manchester', '12.5')], []);
    expect(err.message).toContain('Caster Sugar');
    expect(err.message).toContain('Manchester');
    expect(err.message).toContain('12.5 kg');
    expect(err.message).toContain('adjust the stock to zero');
  });

  it('lists every site holding stock, not just the first', () => {
    const err = new ProductInUseError(
      'Butter',
      [stock('Manchester', '4'), stock('Liverpool', '2.25'), stock('Birmingham', '9')],
      [],
    );
    expect(err.message).toContain('3 sites');
    for (const site of ['Manchester', 'Liverpool', 'Birmingham']) {
      expect(err.message).toContain(site);
    }
  });

  it('names the recipes when a recipe is the blocker', () => {
    const err = new ProductInUseError('Ground Almonds', [], [use('Battenburg'), use('Bakewell')]);
    expect(err.message).toContain('Battenburg');
    expect(err.message).toContain('Bakewell');
    expect(err.message).toContain('remove it from those recipes');
  });

  it('reports BOTH reasons when both apply, and both fixes', () => {
    const err = new ProductInUseError(
      'Vanilla Extract',
      [stock('London East', '3', 'l')],
      [use('Victoria Sponge', 'London East', 2)],
    );
    expect(err.message).toContain('London East');
    expect(err.message).toContain('3 l');
    expect(err.message).toContain('Victoria Sponge');
    // The user needs to know the deletion is blocked twice over, or they will
    // clear the stock and be refused again.
    expect(err.message).toContain('and');
    expect(err.message).toContain('adjust the stock to zero');
    expect(err.message).toContain('remove it from those recipes');
  });

  it('carries the structured detail, not just prose', () => {
    const err = new ProductInUseError('Flour', [stock('Manchester', '1')], [use('Battenburg')]);
    expect(err.stock).toHaveLength(1);
    expect(err.recipeUses[0]?.bake).toBe('Battenburg');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProductInUseError');
  });
});
