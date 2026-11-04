/**
 * NewsletterSignup — renders to static markup (no jsdom here) and checks
 * the parts the consent record depends on: a labelled email field, an
 * active opt-in button, the copy, and nothing pre-ticked.
 */
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewsletterSignup } from './newsletter-signup';
import { NEWSLETTER_INTERESTS, NEWSLETTER_SIGNUP_COPY } from '@/lib/email-copy';

const html = renderToStaticMarkup(React.createElement(NewsletterSignup));

describe('NewsletterSignup', () => {
  it('labels the email field', () => {
    expect(html).toContain('<label for="newsletter-email"');
    expect(html).toMatch(/<input[^>]*id="newsletter-email"[^>]*type="email"[^>]*required/);
  });

  it('shows the signup copy and an active opt-in button', () => {
    expect(html).toContain(NEWSLETTER_SIGNUP_COPY);
    expect(html).toMatch(/<button type="submit"[^>]*>Sign me up<\/button>/);
  });

  it('lists the material interests', () => {
    expect(NEWSLETTER_INTERESTS.map((i) => i.key)).toEqual([
      'material:pla',
      'material:petg',
      'material:abs',
      'material:asa',
      'material:tpu',
      'material:nylon',
      'material:carbon',
      'material:silk',
      'material:wood',
    ]);
  });

  it('offers one checkbox per interest, none of them ticked', () => {
    const boxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(NEWSLETTER_INTERESTS.length);
    for (const i of NEWSLETTER_INTERESTS) {
      expect(html).toContain(`value="${i.key}"`);
      expect(html).toContain(i.name);
    }
    expect(boxes.some((b) => b.includes('checked'))).toBe(false);
  });
});
