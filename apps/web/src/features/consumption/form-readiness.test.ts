/**
 * Item 8 (Sept-2026): "The submit consumption button at the end of bake form
 * it's not working at all."
 *
 * It was disabled, and it never said so. These pin down the two halves of the
 * fix: the setup screen now asks for everything the submit needs, and every
 * refusal names what it is waiting for.
 */
import { describe, expect, it } from 'vitest';
import { missingForLoad, missingForSubmit, refusalLabel, type SetupAnswers } from './form-readiness';

const complete: SetupAnswers = {
  siteId: 'site-1',
  bake: 'Battenburg',
  regularBenches: 5,
  totalBenches: 5,
  sessionId: 'BB-12345',
  bakerName: 'Sam',
};

describe('missingForLoad', () => {
  it('is empty when every setup question is answered', () => {
    expect(missingForLoad(complete)).toEqual([]);
  });

  it('REQUIRES the session id — the field the defect was actually about', () => {
    // Loading used not to need this while submitting did, so a baker reached
    // the ingredient list in a state that could never be filed.
    expect(missingForLoad({ ...complete, sessionId: '   ' })).toEqual(['the session']);
  });

  it('requires the baker name for the same reason', () => {
    expect(missingForLoad({ ...complete, bakerName: '' })).toEqual(['your name']);
  });

  it('treats zero regular benches as answered, but not an empty session', () => {
    // 0 regular is legitimate — an all-vegan evening. What must not pass is
    // *nothing entered*, which a bare `!regularBenches` check would allow.
    const allVegan = { ...complete, regularBenches: 0, totalBenches: 3 };
    expect(missingForLoad(allVegan)).toEqual([]);
    expect(missingForLoad({ ...allVegan, totalBenches: 0 })).toEqual(['at least one bench']);
  });

  it('distinguishes "not typed" from "typed zero"', () => {
    expect(missingForLoad({ ...complete, regularBenches: null, totalBenches: 0 })).toEqual([
      'how many regular benches',
    ]);
  });

  it('lists everything outstanding, in the order the fields appear', () => {
    expect(
      missingForLoad({
        siteId: null,
        bake: '',
        regularBenches: null,
        totalBenches: 0,
        sessionId: '',
        bakerName: '',
      }),
    ).toEqual([
      'a venue',
      'the cake that was baked',
      'how many regular benches',
      'the session',
      'your name',
    ]);
  });
});

describe('missingForSubmit', () => {
  it('passes once the lines are all counted', () => {
    expect(missingForSubmit(complete, { lines: 4, uncounted: 0 })).toEqual([]);
  });

  it('re-checks the setup fields rather than trusting the earlier screen', () => {
    // The whole defect was two screens disagreeing about what was required.
    expect(missingForSubmit({ ...complete, sessionId: '' }, { lines: 4, uncounted: 0 })).toEqual([
      'the session',
    ]);
  });

  it('names how many lines are still uncounted (F-8)', () => {
    expect(missingForSubmit(complete, { lines: 4, uncounted: 2 })).toEqual([
      'what is left of 2 ingredients',
    ]);
    expect(missingForSubmit(complete, { lines: 4, uncounted: 1 })).toEqual([
      'what is left of 1 ingredient',
    ]);
  });

  it('refuses an empty ingredient list', () => {
    expect(missingForSubmit(complete, { lines: 0, uncounted: 0 })).toEqual(['the ingredient list']);
  });
});

describe('refusalLabel', () => {
  it('reads as an instruction, not a fault', () => {
    expect(refusalLabel(['the session'], 'Submit consumption')).toBe(
      'Enter the session to continue',
    );
  });

  it('gives the ready label when nothing is missing', () => {
    expect(refusalLabel([], 'Submit consumption')).toBe('Submit consumption');
  });

  it('names only the first missing answer — the rest go beneath the button', () => {
    expect(refusalLabel(['a venue', 'your name'], 'Go')).toBe('Enter a venue to continue');
  });
});
