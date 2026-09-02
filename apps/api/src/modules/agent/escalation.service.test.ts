/**
 * Escalation routing + notification tests.
 *
 * The property that matters most here: the customer-facing reply says
 * "someone will be in touch". These tests pin down the pieces that
 * decide whether that's true — priority routing, the legacy-reason
 * mapping the approvals inbox reads, and the email body an operator has
 * to act on with no other context.
 *
 * The DB write path is covered by the integration suite; these are the
 * pure functions, which is where the judgement calls live.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEscalationEmail,
  defaultPriorityFor,
  largestStatedValue,
  legacyReasonFor,
  type EscalateInput,
} from './escalation.service.js';

// ============================================================
// largestStatedValue
// ============================================================

describe('largestStatedValue', () => {
  it('reads a plain pound figure', () => {
    expect(largestStatedValue('we have a budget of £5000')).toBe(5000);
  });

  it('reads a comma-grouped figure', () => {
    expect(largestStatedValue('around £12,500 a year')).toBe(12500);
  });

  it('reads a bare quantity', () => {
    expect(largestStatedValue('we want 500 units')).toBe(500);
  });

  it('expands a k suffix', () => {
    expect(largestStatedValue('budget is about £10k')).toBe(10000);
  });

  it('takes the largest of several figures', () => {
    expect(largestStatedValue('between 50 and 800 units, maybe 1200')).toBe(1200);
  });

  it('returns 0 when nothing numeric is stated', () => {
    expect(largestStatedValue('do you do trade accounts?')).toBe(0);
  });

  it('handles decimals without inflating them', () => {
    expect(largestStatedValue('about £99.99 each')).toBe(99.99);
  });
});

// ============================================================
// defaultPriorityFor
// ============================================================

describe('defaultPriorityFor', () => {
  it('always escalates a complaint as high — someone is already unhappy', () => {
    expect(defaultPriorityFor('complaint', 'my spool arrived crushed')).toBe('high');
    expect(defaultPriorityFor('complaint', '')).toBe('high');
  });

  it('promotes a large commercial enquiry to high', () => {
    expect(defaultPriorityFor('commercial_offer', 'we want 500 units')).toBe('high');
    expect(defaultPriorityFor('commercial_offer', 'budget around £10k')).toBe('high');
  });

  it('leaves a small commercial enquiry at normal', () => {
    expect(defaultPriorityFor('commercial_offer', 'could we order 20 units?')).toBe('normal');
  });

  it('leaves a value-free commercial enquiry at normal', () => {
    expect(defaultPriorityFor('commercial_offer', 'do you offer trade accounts?')).toBe('normal');
  });

  it('defaults anything else to normal', () => {
    expect(defaultPriorityFor('pre_sales', 'anything')).toBe('normal');
    expect(defaultPriorityFor('order_status', '500 units')).toBe('normal');
  });
});

// ============================================================
// legacyReasonFor
// ============================================================

describe('legacyReasonFor', () => {
  it('maps the pipeline categories onto the approvals-inbox enum', () => {
    expect(legacyReasonFor('commercial_offer')).toBe('trade_account');
    expect(legacyReasonFor('complaint')).toBe('refund_dispute');
    expect(legacyReasonFor('delivery_returns')).toBe('delivery_issue');
    expect(legacyReasonFor('product_advice')).toBe('product_advice_complex');
  });

  it('falls back to other for anything unmapped', () => {
    expect(legacyReasonFor('pre_sales')).toBe('other');
    expect(legacyReasonFor('something_new')).toBe('other');
  });
});

// ============================================================
// buildEscalationEmail
// ============================================================

const baseInput: EscalateInput = {
  chatSessionId: 'sess-1',
  chatCategory: 'complaint',
  reason: 'refund_dispute',
  summary: 'Spool arrived crushed in transit',
  priority: 'high',
  to: 'sales@cleverdeals.net',
  storeName: 'Filament Store',
  recentTurns: [
    { role: 'user', content: 'Hi, I ordered last week' },
    { role: 'assistant', content: 'How can I help?' },
    { role: 'user', content: 'My spool arrived crushed' },
  ],
};

describe('buildEscalationEmail', () => {
  it('puts category and priority in the subject for mailbox filtering', () => {
    const { subject } = buildEscalationEmail(baseInput, 'esc-1');
    expect(subject).toContain('complaint');
    expect(subject).toContain('high');
    expect(subject).toContain('Spool arrived crushed');
  });

  it('truncates a long summary in the subject', () => {
    const { subject } = buildEscalationEmail(
      { ...baseInput, summary: 'x'.repeat(300) },
      'esc-1',
    );
    expect(subject.length).toBeLessThan(140);
  });

  it('includes the escalation id so the row can be found', () => {
    const { html } = buildEscalationEmail(baseInput, 'esc-abc-123');
    expect(html).toContain('esc-abc-123');
  });

  it('includes the transcript so the operator can act without opening anything', () => {
    const { html } = buildEscalationEmail(baseInput, 'esc-1');
    expect(html).toContain('My spool arrived crushed');
    expect(html).toContain('Customer');
    expect(html).toContain('Assistant');
  });

  it('says anonymous when there is no signed-in customer', () => {
    const { html } = buildEscalationEmail(baseInput, 'esc-1');
    expect(html).toContain('anonymous');
  });

  it('includes email and order reference when known', () => {
    const { html } = buildEscalationEmail(
      { ...baseInput, customerName: 'Pat Buyer', customerEmail: 'pat@example.com', orderRef: 'ORD-99' },
      'esc-1',
    );
    expect(html).toContain('Pat Buyer');
    expect(html).toContain('pat@example.com');
    expect(html).toContain('ORD-99');
  });

  it('escapes HTML in customer-supplied text', () => {
    // Customer messages reach an operator's mail client verbatim; an
    // unescaped <script> or broken tag would at best mangle the email.
    const { html } = buildEscalationEmail(
      {
        ...baseInput,
        summary: '<script>alert(1)</script>',
        recentTurns: [{ role: 'user', content: '<img src=x onerror=alert(1)>' }],
      },
      'esc-1',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles a turn-free escalation without breaking the layout', () => {
    const { html } = buildEscalationEmail({ ...baseInput, recentTurns: [] }, 'esc-1');
    expect(html).toContain('no prior turns');
  });

  it('quotes at most the last three turns', () => {
    const { html } = buildEscalationEmail(
      {
        ...baseInput,
        recentTurns: [
          { role: 'user', content: 'TURN-ONE' },
          { role: 'assistant', content: 'TURN-TWO' },
          { role: 'user', content: 'TURN-THREE' },
          { role: 'assistant', content: 'TURN-FOUR' },
          { role: 'user', content: 'TURN-FIVE' },
        ],
      },
      'esc-1',
    );
    expect(html).not.toContain('TURN-ONE');
    expect(html).not.toContain('TURN-TWO');
    expect(html).toContain('TURN-THREE');
    expect(html).toContain('TURN-FIVE');
  });

  it('names the store so a shared mailbox can tell deployments apart', () => {
    const { html } = buildEscalationEmail(
      { ...baseInput, storeName: 'CleverDeals Clothes' },
      'esc-1',
    );
    expect(html).toContain('CleverDeals Clothes');
  });
});
