# Email build — blockers

One entry per item the build could not resolve on its own: what was tried, what was done
instead, and what Roger needs to do.

## B1 — SendGrid export files not in the repository (section 0, 4)

- **Attempted:** looked for `imports/sendgrid/{bounces,spam_reports,unsubscribes,contacts}.csv`.
- **Done instead:** `imports/` is git-ignored; the importer is built and tested against synthetic
  fixtures in `apps/api/test/fixtures/email/`. The dry-run and live runs against real exports
  (runbook section 4 step 7) were not possible.
- **Roger:** export the four lists from SendGrid, put them in `imports/sendgrid/` on the
  production host (never in git) and follow HANDOVER.md "Production go-live steps".

## B2 — No SendGrid key in the build environment (section 6)

- **Attempted:** the runbook's section 6 "done when" asks for a sandbox-mode run of 50 sends against SendGrid and a webhook replay.
- **Done instead:** the build has no SendGrid key (and must not use a real one), so the sender was run against a fake transport for 120 sends (pacing, retries, allowlist, window) and the webhook was exercised with SendGrid-style signed payloads for every event type. The payload sent to SendGrid is pinned by an inline snapshot.
- **Roger:** during go-live (HANDOVER.md), with `EMAIL_SEND_MODE=sandbox` and the new API key in production, send one test from the admin and confirm a `processed` event reaches the webhook (the Deliverability page shows the last event time).
