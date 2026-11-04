import { describe, expect, it } from 'vitest';
import {
  addInterestPoints,
  decayAll,
  effectiveScore,
  interestKeysForProduct,
  interestedKeys,
  isInterested,
  materialKeysInText,
} from './interests.js';

const T0 = new Date('2026-01-01T00:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

describe('interest keys', () => {
  it('derives materials from the product and group names', () => {
    expect(interestKeysForProduct({ name: 'Galaxy Black', groupName: 'Landu PETG Pro 1.75mm 1kg' })).toEqual([
      'material:petg',
    ]);
    expect(interestKeysForProduct({ name: 'PLA+ Silk Gold' })).toEqual(['material:pla', 'material:silk']);
    expect(interestKeysForProduct({ name: 'Plastic tray' })).toEqual([]);
  });
  it('adds the category when the product has one', () => {
    expect(interestKeysForProduct({ name: 'Polo', categoryId: 'c1' })).toEqual(['category:c1']);
  });
  it('reads material names out of list names', () => {
    expect(materialKeysInText('Newsletter - PETG fans; ABS & ASA')).toEqual([
      'material:petg',
      'material:abs',
      'material:asa',
    ]);
  });
});

describe('scores', () => {
  it('halve every 180 days', () => {
    const map = addInterestPoints({}, ['material:pla'], 10, T0);
    expect(effectiveScore(map['material:pla'], days(180))).toBeCloseTo(5);
    expect(effectiveScore(map['material:pla'], days(360))).toBeCloseTo(2.5);
  });
  it('add to the decayed value', () => {
    let map = addInterestPoints({}, ['material:pla'], 10, T0);
    map = addInterestPoints(map, ['material:pla'], 2, days(180));
    expect(map['material:pla']!.score).toBeCloseTo(7);
  });
  it('treat 3 and over as interested', () => {
    const map = addInterestPoints({}, ['material:pla', 'material:abs'], 10, T0);
    expect(isInterested(map, 'material:pla', days(300))).toBe(true); // 10 × 0.5^(300/180) ≈ 3.15
    expect(isInterested(map, 'material:pla', days(400))).toBe(false); // ≈ 2.1
    expect(interestedKeys(map, days(10))).toEqual(['material:pla', 'material:abs']);
  });
  it('decay rewrites scores as of now and drops the dust', () => {
    const map = { 'material:pla': { score: 10, at: T0.toISOString() }, 'material:abs': { score: 0.06, at: T0.toISOString() } };
    const out = decayAll(map, days(180));
    expect(out['material:pla']!.score).toBeCloseTo(5);
    expect(out['material:abs']).toBeUndefined();
    expect(effectiveScore(out['material:pla'], days(360))).toBeCloseTo(2.5);
  });
});
