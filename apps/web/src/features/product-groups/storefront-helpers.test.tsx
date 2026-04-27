/**
 * Unit + DOM tests for the storefront-content helpers.
 *
 *   makeSlug                — pure
 *   buildChecklist          — pure (covers required-vs-optional split)
 *   canPublishFromChecklist — pure
 *   ChecklistSummary        — render shape + missing-required hint
 *   TagsInput               — Enter to add, comma to add, Backspace to remove
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import {
  buildChecklist,
  canPublishFromChecklist,
  ChecklistSummary,
  makeSlug,
  TagsInput,
} from './storefront-helpers';

describe('makeSlug', () => {
  it('lower-cases, kebab-cases, strips diacritics, trims dashes', () => {
    expect(makeSlug('Aurora Filament Lamp', 'Smoke')).toBe('aurora-filament-lamp-smoke');
    expect(makeSlug('Café — édition spéciale')).toBe('cafe-edition-speciale');
    expect(makeSlug('  hello  world  ')).toBe('hello-world');
  });

  it('skips null / undefined / empty parts', () => {
    expect(makeSlug('Lamp', null, undefined, '')).toBe('lamp');
    expect(makeSlug(null, undefined)).toBe('');
  });

  it('caps at 200 characters', () => {
    const long = 'x'.repeat(500);
    expect(makeSlug(long).length).toBeLessThanOrEqual(200);
  });
});

describe('buildChecklist + canPublishFromChecklist', () => {
  it('flags the 3 publish-required fields when missing', () => {
    const items = buildChecklist({
      slug: '',
      shortDescription: '',
      heroImageUrl: '',
    });
    const required = items.filter((i) => i.requiredToPublish);
    expect(required.map((i) => i.id).sort()).toEqual([
      'hero_image_url',
      'short_description',
      'slug',
    ]);
    expect(required.every((i) => !i.complete)).toBe(true);
    expect(canPublishFromChecklist(items)).toBe(false);
  });

  it('allows publish when only the 3 required fields are filled', () => {
    const items = buildChecklist({
      slug: 'a',
      shortDescription: 'b',
      heroImageUrl: 'https://example.com/h.jpg',
    });
    expect(canPublishFromChecklist(items)).toBe(true);
    // 4 of 7 still incomplete (the optional ones).
    expect(items.filter((i) => i.complete)).toHaveLength(3);
  });

  it('counts gallery, long description, SEO title/desc as optional checklist items', () => {
    const items = buildChecklist({
      slug: 'a',
      shortDescription: 'b',
      heroImageUrl: 'https://example.com/h.jpg',
      longDescription: 'long',
      galleryImageUrls: ['https://example.com/1.jpg'],
      seoTitle: 't',
      seoDescription: 'd',
    });
    expect(items).toHaveLength(7);
    expect(items.every((i) => i.complete)).toBe(true);
    expect(canPublishFromChecklist(items)).toBe(true);
  });

  it('treats whitespace-only slug as incomplete', () => {
    const items = buildChecklist({
      slug: '   ',
      shortDescription: 'b',
      heroImageUrl: 'https://example.com/h.jpg',
    });
    expect(canPublishFromChecklist(items)).toBe(false);
  });
});

describe('<ChecklistSummary />', () => {
  it('renders the X of Y header and a missing-required hint', () => {
    const items = buildChecklist({
      slug: '',
      shortDescription: 'present',
      heroImageUrl: 'https://example.com/h.jpg',
    });
    render(<ChecklistSummary items={items} />);
    expect(screen.getByText(/2 of 7 storefront fields complete/i)).toBeInTheDocument();
    expect(screen.getByText(/Missing required:/i)).toHaveTextContent(/URL slug/i);
  });

  it('omits the missing-required hint when nothing is missing', () => {
    const items = buildChecklist({
      slug: 'a',
      shortDescription: 'b',
      heroImageUrl: 'https://example.com/h.jpg',
    });
    render(<ChecklistSummary items={items} />);
    expect(screen.queryByText(/Missing required:/i)).not.toBeInTheDocument();
  });
});

describe('<TagsInput />', () => {
  function ControlledTagsInput() {
    const [value, setValue] = React.useState<string[]>([]);
    return <TagsInput id="t" value={value} onChange={setValue} />;
  }

  it('adds a tag on Enter and clears the input', async () => {
    const user = userEvent.setup();
    render(<ControlledTagsInput />);
    const input = screen.getByPlaceholderText(/Type a keyword/i);
    await user.type(input, 'lamp{Enter}');
    expect(screen.getByText('lamp')).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('adds a tag on comma', async () => {
    const user = userEvent.setup();
    render(<ControlledTagsInput />);
    const input = screen.getByPlaceholderText(/Type a keyword/i);
    await user.type(input, 'designer,');
    expect(screen.getByText('designer')).toBeInTheDocument();
  });

  it('does not add an empty or duplicate tag', async () => {
    const user = userEvent.setup();
    render(<ControlledTagsInput />);
    const input = screen.getByPlaceholderText(/Type a keyword/i);
    await user.type(input, 'lamp{Enter}');
    await user.type(input, '   {Enter}');
    await user.type(input, 'lamp{Enter}');
    // Still exactly one badge for "lamp"
    expect(screen.getAllByText('lamp')).toHaveLength(1);
  });

  it('removes the last tag on Backspace from an empty input', async () => {
    const user = userEvent.setup();
    render(<ControlledTagsInput />);
    const input = screen.getByPlaceholderText(/Type a keyword/i);
    await user.type(input, 'lamp{Enter}designer{Enter}');
    expect(screen.getByText('designer')).toBeInTheDocument();
    await user.type(input, '{Backspace}');
    expect(screen.queryByText('designer')).not.toBeInTheDocument();
    expect(screen.getByText('lamp')).toBeInTheDocument();
  });

  it('removes a tag when the X button is clicked', async () => {
    const user = userEvent.setup();
    render(<ControlledTagsInput />);
    const input = screen.getByPlaceholderText(/Type a keyword/i);
    await user.type(input, 'lamp{Enter}');
    await user.click(screen.getByLabelText('Remove lamp'));
    expect(screen.queryByText('lamp')).not.toBeInTheDocument();
  });
});
