/**
 * What the end-of-bake form is still waiting for (Sept-2026 feedback, item 8).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * "The submit consumption button at the end of bake form it's not working at
 *  all."
 *
 * It was working exactly as written. `canSubmit` required a Session ID and a
 * baker name — but NEITHER was required to load the ingredients, so a baker
 * could reach the ingredient list with both blank, count out twenty
 * ingredients, press Submit and watch nothing happen. The button was
 * `disabled`, and its label still read "Submit consumption". There was no
 * message, no highlight, and nothing on screen connecting the dead button to
 * the two empty boxes on the page before it.
 *
 * "Session ID" is the likeliest one to be skipped: it was labelled "BumbleBee
 * session id", which is not a thing anyone in a venue knows by heart, and it
 * sits below the fold under the bench counts.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A control that refuses must say what it is waiting for, and it must refuse
 * at the earliest point the answer is knowable. So:
 *
 *   1. Everything needed to FILE the bake is now required to LOAD it. Asking
 *      for the session and the baker's name on the setup screen — where the
 *      other setup questions are — means the ingredients screen cannot be
 *      reached in a state that cannot be submitted.
 *   2. Both buttons render these strings. A disabled button that names the
 *      missing field is a instruction; one that doesn't is a fault report.
 *
 * Returned as an ordered list of human phrases rather than a boolean or a set
 * of flags, because the caller's job is to print the first one on the button
 * and the rest underneath it. Order follows the visual order of the fields, so
 * "the first thing missing" is also "the first thing missing as you scroll".
 */

export interface SetupAnswers {
  siteId: string | null;
  bake: string;
  /** NULL until the leader has actually typed a number — 0 is a real answer. */
  regularBenches: number | null;
  totalBenches: number;
  sessionId: string;
  bakerName: string;
}

/**
 * What is still unanswered on the setup screen.
 *
 * Empty ⇒ the ingredients can be loaded AND, once counted, filed. That
 * equivalence is the point: it is what stops a baker reaching a screen they
 * cannot submit from.
 */
export function missingForLoad(a: SetupAnswers): string[] {
  const missing: string[] = [];
  if (!a.siteId) missing.push('a venue');
  if (!a.bake.trim()) missing.push('the cake that was baked');
  if (a.regularBenches === null) missing.push('how many regular benches');
  else if (a.totalBenches <= 0) missing.push('at least one bench');
  if (!a.sessionId.trim()) missing.push('the session');
  if (!a.bakerName.trim()) missing.push('your name');
  return missing;
}

/**
 * What is still unanswered on the ingredients screen.
 *
 * `missingForLoad` should already have caught the setup fields, so in practice
 * only the uncounted lines remain. They are re-checked anyway: this is the
 * guard that actually gates the submit, and a guard that trusts an earlier
 * screen is a guard that fails the day someone adds a way round it.
 */
export function missingForSubmit(
  a: SetupAnswers,
  counts: { lines: number; uncounted: number },
): string[] {
  const missing = missingForLoad(a);
  if (counts.lines === 0) missing.push('the ingredient list');
  if (counts.uncounted > 0) {
    missing.push(
      `what is left of ${counts.uncounted} ingredient${counts.uncounted === 1 ? '' : 's'}`,
    );
  }
  return missing;
}

/**
 * The button's own label. Names the first missing answer; the caller prints
 * the remainder beneath.
 *
 * Deliberately phrased as an instruction ("Enter the session to continue")
 * rather than a complaint ("Session missing") — the baker is mid-task and
 * needs to know what to do, not what is wrong.
 */
export function refusalLabel(missing: string[], readyLabel: string): string {
  if (missing.length === 0) return readyLabel;
  return `Enter ${missing[0]} to continue`;
}
