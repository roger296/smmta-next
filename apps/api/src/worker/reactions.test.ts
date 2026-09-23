import { afterEach, describe, expect, it } from 'vitest';
import { clearReactions, extensionQueues, handlersFor, registerReaction } from './registry.js';

afterEach(() => clearReactions());

describe('extension reactions', () => {
  it('adds an extension queue to an event after the core handlers, and lists it once', () => {
    expect(handlersFor('order.lines_changed')).toEqual(['create-pick-note']);
    registerReaction('order.lines_changed', 'my_ext-lines-changed');
    registerReaction('order.lines_changed', 'my_ext-lines-changed');
    registerReaction('order.released', 'my_ext-lines-changed');
    expect(handlersFor('order.lines_changed')).toEqual(['create-pick-note', 'my_ext-lines-changed']);
    expect(extensionQueues()).toEqual(['my_ext-lines-changed']);
  });

  it('refuses a queue that is not <key>-<name>, or that belongs to the core', () => {
    expect(() => registerReaction('order.created', 'create-pick-note')).toThrow(/core queue/);
    expect(() => registerReaction('order.created', 'NoDash')).toThrow(/<extension key>-<name>/);
    expect(() => registerReaction('order.created', 'my_ext-Upper')).toThrow(/lower case/);
  });
});
