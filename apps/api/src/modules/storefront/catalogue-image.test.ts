/**
 * Which image a group card shows.
 *
 * The bug this covers: an operator uploads a photograph to a product, sees it
 * on the product page, and the listing cards keep showing a placeholder. Group
 * and product artwork live in different columns, and an upload only writes the
 * product's. Pure function, no database.
 */
import { describe, expect, it } from 'vitest';
import { groupCardImage } from './catalogue.service.js';

const UPLOAD = 'https://api.cleverdeals.net/uploads/5632e72c.jpg';

describe('groupCardImage', () => {
  it('prefers the group artwork when it has some', () => {
    expect(
      groupCardImage('https://cdn.example.com/group.png', [{ heroImageUrl: UPLOAD }]),
    ).toBe('https://cdn.example.com/group.png');
  });

  it('falls back to a variant image when the group has none', () => {
    // The reported case: the photo is on the product, the group was never
    // given one, and the card rendered a placeholder.
    expect(groupCardImage(null, [{ heroImageUrl: UPLOAD }])).toBe(UPLOAD);
  });

  it('skips variants without an image and takes the first that has one', () => {
    expect(
      groupCardImage(null, [
        { heroImageUrl: null },
        { heroImageUrl: null },
        { heroImageUrl: UPLOAD },
      ]),
    ).toBe(UPLOAD);
  });

  it('returns null when nothing anywhere has an image', () => {
    expect(groupCardImage(null, [])).toBeNull();
    expect(groupCardImage(null, [{ heroImageUrl: null }])).toBeNull();
  });

  it('treats an empty string as no image, not as an image', () => {
    // An empty column would otherwise satisfy a truthiness check further up
    // and render a broken <img> rather than the placeholder.
    expect(groupCardImage('', [{ heroImageUrl: UPLOAD }])).toBe(UPLOAD);
    expect(groupCardImage(null, [{ heroImageUrl: '' }, { heroImageUrl: UPLOAD }])).toBe(UPLOAD);
  });
});
