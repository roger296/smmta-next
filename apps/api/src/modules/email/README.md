# Email module

Every email the store sends — order-required, requested service, service and
marketing — goes through this module: one gate (`lib/gate.ts`, `canSend`), one
sender (`jobs/send.job.ts` → `lib/sendgrid.ts`) and one event log
(`email_sends`, `email_events`).

The specification is `docs/email/SPEC.md`; the build runbook is
`docs/email/EMAIL_MARKETING_BUILD_PROMPTS.md`; what was built, and the choices
made where the runbook left room, is in `docs/email/BUILD_LOG.md`.

| Folder | Holds |
| --- | --- |
| `lib/` | Pure helpers: normalisation, the gate policy, tokens, headers, rate limiter, SendGrid and Bouncer clients, interests. |
| `services/` | Contacts and consent, sends, imports, audiences, campaigns, digest, reports. |
| `jobs/` | pg-boss handlers and the schedule they run on. |
| `templates/` | Email layout, blocks and the template registry. |
| `public/` | The unsubscribe and preferences pages (no login). |
| `mcp/` | The `email_` MCP tools. |
