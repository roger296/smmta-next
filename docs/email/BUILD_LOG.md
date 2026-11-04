# Email build log

One entry per runbook section, in the format of runbook D8.

## Section 0 — Discovery and preparation — DONE 2026-11-04T12:30:00Z
Built:
- `docs/email/SPEC.md`, `docs/email/EMAIL_MARKETING_BUILD_PROMPTS.md` (copied in), `docs/email/CONTEXT.md` (survey + mapping of the runbook onto this repo).
- `.gitignore`: `imports/`, `var/email-evidence/`, `apps/api/var/`.
- Env (`apps/api/src/config/env.ts`, `.env.example`): `EMAIL_SEND_MODE`, `EMAIL_TEST_ALLOWLIST`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`, `EMAIL_UNSUBSCRIBE_MAILTO`, `EMAIL_TOKEN_SECRET`, `SENDGRID_WEBHOOK_PUBLIC_KEY`, `BOUNCER_API_KEY`, `BOUNCER_API_BASE_URL`, `STOREFRONT_BASE_URL`, `ADMIN_BASE_URL`.
- Module skeleton `apps/api/src/modules/email/{lib,services,jobs,templates,public,mcp}` + README; `lib/config.ts`.
- `npm run test:email -w @smmta/api`; harness test `src/modules/email/harness.test.ts`.
Decisions taken:
- Branch is `claude/inspiring-feynman-e88jdq`, not `feature/email-marketing`: the session is required to develop on that branch.
- Test interception uses the repo's convention (injected fakes + `vi.stubGlobal('fetch')`) rather than adding msw/nock.
- Test database: a local Postgres 16 (`smmta_test`), the same arrangement CI uses; no extra compose service.
- `EMAIL_SEND_MODE` has no default in the schema: unset means "the sender refuses to run" (D3), and the UI shows it as sandbox. Unknown values fail validation. `.env.example` carries `sandbox`.
- `SENDGRID_WEBHOOK_PUBLIC_KEY` is accepted as an alias of the existing `SENDGRID_WEBHOOK_VERIFICATION_KEY`; `EMAIL_TOKEN_SECRET` falls back to `UNSUBSCRIBE_SECRET`.
- Interests are keyed on material/category keys, not category ids (CONTEXT.md "Interests").
- No linter exists in the API; "lint" in each section's checks = `tsc --noEmit` (api and web), as CI does.
Tests: 5 unit/integration (harness), repo API suite 1029 green before the build; all green
Commit: (this commit)
