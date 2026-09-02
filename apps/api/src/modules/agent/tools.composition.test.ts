/**
 * Specialist tool-set composition.
 *
 * These assertions are a security boundary, not a tidiness check. A
 * model only has the capabilities its tool list grants, so what a
 * misrouted or jailbroken turn can DO is decided entirely here. If the
 * delivery-returns specialist ever gains `add_to_basket`, a customer
 * asking about a refund acquires a way to change their order — and the
 * only thing standing between them and that is the prompt, which is
 * exactly the thing an injection attacks.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, TOOL_SCHEMAS, toolsForCategory } from './tools.js';

const MUTATING_TOOLS = [
  'add_to_basket',
  'update_basket_line',
  'remove_basket_line',
  'check_discount_code',
  'create_interest_flag',
];

const names = (category: string) => toolsForCategory(category).map((t) => t.name);

describe('toolsForCategory', () => {
  it('gives pre_sales the full commerce set', () => {
    const set = names('pre_sales');
    for (const t of MUTATING_TOOLS) expect(set, t).toContain(t);
    expect(set).toContain('quote_price');
    expect(set).toContain('search_catalogue');
  });

  it('gives delivery_returns NO mutating tools', () => {
    const set = names('delivery_returns');
    for (const t of MUTATING_TOOLS) expect(set, t).not.toContain(t);
    expect(set).toEqual(expect.arrayContaining(['lookup_kb', 'escalate_to_human']));
  });

  it('gives product_advice NO mutating tools', () => {
    const set = names('product_advice');
    for (const t of MUTATING_TOOLS) expect(set, t).not.toContain(t);
  });

  it('gives order_status NO mutating tools', () => {
    // Someone chasing an order must not be able to talk the assistant
    // into changing what they bought.
    const set = names('order_status');
    for (const t of MUTATING_TOOLS) expect(set, t).not.toContain(t);
  });

  it('gives order_status both lookup paths', () => {
    const set = names('order_status');
    expect(set).toContain('lookup_order_by_account');
    expect(set).toContain('lookup_order_by_ref_and_email');
  });

  it('keeps the order-lookup tools OFF every other specialist', () => {
    // Order data is the most sensitive thing these tools reach. Only
    // the specialist whose prompt carries the identity rules gets them.
    for (const category of ['pre_sales', 'delivery_returns', 'product_advice']) {
      const set = names(category);
      expect(set, category).not.toContain('lookup_order_by_account');
      expect(set, category).not.toContain('lookup_order_by_ref_and_email');
    }
  });

  it('lets every specialist escalate', () => {
    for (const category of ['pre_sales', 'delivery_returns', 'product_advice', 'order_status']) {
      expect(names(category), category).toContain('escalate_to_human');
    }
  });

  it('falls back to the pre_sales set for an unknown category', () => {
    expect(names('not_a_category')).toEqual(names('pre_sales'));
  });

  it('only ever returns tools that actually exist', () => {
    for (const category of [
      'pre_sales',
      'delivery_returns',
      'product_advice',
      'order_status',
      'unknown',
    ]) {
      for (const name of names(category)) {
        expect(TOOL_NAMES, `${category} → ${name}`).toContain(name);
      }
    }
  });
});

describe('TOOL_SCHEMAS', () => {
  it('has unique tool names', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('never exposes an identity parameter to the model', () => {
    // Identity is server-injected from the session. A tool that ACCEPTS
    // a user/basket/session id would make cross-customer access a
    // prompt-injection away.
    const forbidden = ['user_id', 'userId', 'basket_id', 'basketId', 'session_id', 'sessionId'];
    for (const tool of TOOL_SCHEMAS) {
      const params = tool.parameters as { properties?: Record<string, unknown> };
      const keys = Object.keys(params.properties ?? {});
      for (const bad of forbidden) {
        expect(keys, `${tool.name} exposes ${bad}`).not.toContain(bad);
      }
    }
  });

  it('gives every tool a description the model can route on', () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });
});
