/**
 * NewsletterSignup — renders to static markup (no jsdom here) and checks
 * the parts the consent record depends on: a labelled email field, an
 * active opt-in button, the copy, and nothing pre-ticked. The Clothes Shop
 * offers no interests, so there are no checkboxes at all.
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

  it('asks for the email address only — no interest checkboxes', () => {
    expect(NEWSLETTER_INTERESTS).toHaveLength(0);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('<fieldset');
  });
});
