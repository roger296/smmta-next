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
