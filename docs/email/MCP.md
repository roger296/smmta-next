# Email MCP tools

The admin exposes the email system to Claude as MCP tools on its own MCP
server: **`POST https://admin.cleverdeals.net/api/mcp`** (Streamable HTTP,
stateless). Authenticate with an API key carrying the **`email:mcp`** scope,
sent as `Authorization: Bearer smmta_<prefix>_<secret>`. Issue one from the
admin's API-key route (`POST /api/v1/admin/api-keys` with
`{"name": "Claude email", "scopes": ["email:mcp"]}`).

Every call is written to `email_audit` (tool, actor, arguments with addresses
masked, outcome). The actor is `claude`; a key that also carries
**`email:approve`** belongs to a person (Roger), is recorded as
`mcp:<key prefix>`, and is the only kind that may approve campaigns.

The easiest way to issue the key is **Settings → Claude connector** in the
admin. The same endpoint also serves the `admin_` tools to a key with the
`admin:mcp` scope (docs/MCP-CONNECTOR.md).

Guard rails:

- Drafting, previewing and scheduling are free. A marketing campaign that
  Claude schedules for more than the approval threshold (50 contacts) becomes
  `pending_approval` and waits for a person.
- `email_approve_campaign` refuses unless the key has `email:approve`.
- `email_send_test` only reaches addresses on `EMAIL_TEST_ALLOWLIST`.
- `email_set_marketing_status`: `never`, and any upgrade to `all`, need
  `confirm: true` and a reason.
- `email_import_csv` is a dry run unless given the id of a dry run of the
  same file.

## Tools

| Tool | Arguments | Does |
| --- | --- | --- |
| `email_list_contacts` | `search?, status?, deliverability?, interest?, is_trade?, engaged_within_days?, last_order_within_days?, source?, page?, page_size?` | Lists contacts (read) |
| `email_get_contact` | `id?` or `email?` | Consent history, last 50 sends with events, interests, orders (read) |
| `email_set_marketing_status` | `contact_id, status, reason, confirm?` | Changes consent, logged |
| `email_import_csv` | `list_type, csv? or file_path?, dry_run? (true), dry_run_id?, default_interests?, consent_source?, list_name?` | Imports a list |
| `email_get_import` | `id?` | An import's report, or recent imports (read) |
| `email_preview_segment` | `segment, class?, kind?` | Audience count after the gate + 10 samples (read) |
| `email_create_campaign` | `name, kind?, class?, segment?, subject?, preheader?, template_key?, content?, scheduled_at?, send_window_minutes?, subject_b?` | Creates a draft (A/B with `subject_b`) |
| `email_update_campaign` | `id` + any create field | Edits; back to draft |
| `email_render_preview` | `id, html?` | Three previews: with interests, trade, new (read) |
| `email_send_test` | `id, emails` | Test send to allowlisted addresses |
| `email_schedule_campaign` | `id, scheduled_at?` | Draft → scheduled, or pending_approval over the threshold |
| `email_approve_campaign` | `id` | Approves (people only) |
| `email_cancel_campaign` | `id` | Cancels, with its queued sends |
| `email_pause_campaign` | `id` | Pauses a sending campaign |
| `email_resume_campaign` | `id` | Resumes it |
| `email_get_campaign_report` | `id?, status?` | Campaign + report, or the campaign list (read) |
| `email_list_automations` | — | Automations, settings, last 30 days (read) |
| `email_update_automation` | `key, settings` | Switch on/off, cadence, discount policy |
| `email_get_deliverability` | — | Rates, thresholds, mode, pause, last webhook event (read) |
| `email_pause_marketing` | `reason` | Global marketing kill switch |
| `email_resume_marketing` | — | Lifts it |
| `email_get_settings` | — | All settings (read) |
| `email_update_settings` | `settings` | Changes settings, logged |
| `email_record_consent` | `email, status?, source, evidence` | Records consent gathered elsewhere |
| `email_write_weekly_content` | `key, kind?, body, title?, url?, price_gbp?, saving_gbp?, week?` | The digest's featured paragraph or a deal |

## Example calls

1. "Draft this week's digest and show me three previews" →
   `email_get_campaign_report {"status": "scheduled"}`, then
   `email_render_preview {"id": "<digest id>"}`.
2. "Write the PETG paragraph for this week" →
   `email_write_weekly_content {"key": "material:petg", "body": "PETG strings less with a slower travel move…", "title": "PETG tip"}`.
3. "Who in PETG hasn't ordered in 90 days?" →
   `email_preview_segment {"segment": {"status": "all", "interests_any": ["material:petg"], "last_order_older_than_days": 90}}`.
4. "Draft a win-back to them" →
   `email_create_campaign {"name": "PETG win-back", "subject": "New in PETG since you last visited", "segment": {"status": "all", "interests_any": ["material:petg"], "last_order_older_than_days": 90}, "content": [{"type": "Text", "props": {"body": "…"}}]}`.
5. "Send me a test" → `email_send_test {"id": "<id>", "emails": ["roger@etailsupport.com"]}`.
6. "Schedule it for Thursday 10:00" →
   `email_schedule_campaign {"id": "<id>", "scheduled_at": "2026-11-12T10:00:00Z"}` (over 50 people: pending approval).
7. "Why did last Thursday's digest get four unsubscribes?" →
   `email_get_campaign_report {"id": "<id>"}`, then `email_list_contacts {"status": "transactional_only", "engaged_within_days": 7}`.
8. "Import this list as a dry run and tell me what conflicts" →
   `email_import_csv {"list_type": "unsubscribes", "csv": "email\n…"}`; then with `"dry_run": false, "dry_run_id": "<id>"`.
9. "This customer phoned to say never email them" →
   `email_set_marketing_status {"contact_id": "<id>", "status": "never", "reason": "Phoned 4 Nov, asked for no email", "confirm": true}`.
10. "Pause marketing until I say otherwise" → `email_pause_marketing {"reason": "Roger's request"}`.
