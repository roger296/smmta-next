import { describe, expect, it } from 'vitest';
import { pageTitle, socialTitle } from './title';

describe('pageTitle', () => {
  it('goes absolute when the SEO title already carries the brand', () => {
    // The seeder writes "<group> | Filament Store"; without `absolute` the root
    // layout template appended the brand again → "… | Filament Store | Filament Store".
    expect(pageTitle('Landau PLA Basic 1.75mm 1kg | Filament Store', 'Landau PLA Basic')).toEqual({
      absolute: 'Landau PLA Basic 1.75mm 1kg | Filament Store',
    });
  });

  it('returns a plain string so the template appends the brand once', () => {
    expect(pageTitle('Landau PLA Basic 1.75mm 1kg — Brown', 'Landau PLA Basic')).toBe(
      'Landau PLA Basic 1.75mm 1kg — Brown',
    );
  });

  it('falls back to the product name when there is no SEO title', () => {
    expect(pageTitle(null, 'Landau PLA Basic')).toBe('Landau PLA Basic');
    expect(pageTitle('   ', 'Landau PLA Basic')).toBe('Landau PLA Basic');
  });

  it('uses absolute when the fallback name itself carries the brand', () => {
    expect(pageTitle(null, 'Filament Store')).toEqual({ absolute: 'Filament Store' });
  });
});

describe('socialTitle', () => {
  it('appends the brand for OG/Twitter, which have no template', () => {
    expect(socialTitle('Landau PLA — Brown', 'x')).toBe('Landau PLA — Brown | Filament Store');
  });

  it('does not double the brand', () => {
    expect(socialTitle('Landau PLA | Filament Store', 'x')).toBe('Landau PLA | Filament Store');
  });
});
