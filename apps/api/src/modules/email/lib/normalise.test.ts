import { describe, expect, it } from 'vitest';
import { isValidEmail, maskEmail, normaliseEmail } from './normalise.js';

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => expect(normaliseEmail(' Foo@Example.COM ')).toBe('foo@example.com'));
  it('strips angle brackets', () => expect(normaliseEmail('<a@b.co>')).toBe('a@b.co'));
  it('strips mailto:', () => expect(normaliseEmail('mailto:A@B.co')).toBe('a@b.co'));
  it('strips both', () => expect(normaliseEmail('<mailto:a@b.co>')).toBe('a@b.co'));
  it('does not fold Gmail dots or plus tags', () =>
    expect(normaliseEmail('First.Last+tag@gmail.com')).toBe('first.last+tag@gmail.com'));
});

describe('isValidEmail', () => {
  it.each(['a@b.co', 'first.last+tag@sub.example.com'])('accepts %s', (e) => expect(isValidEmail(e)).toBe(true));
  it.each(['', 'nope', 'a@b', 'a b@c.com', 'a@@b.com', 'a@b.c'])('refuses %s', (e) =>
    expect(isValidEmail(e)).toBe(false),
  );
});

describe('maskEmail', () => {
  it('keeps two characters and the domain', () => expect(maskEmail('roger@example.com')).toBe('ro***@example.com'));
});
