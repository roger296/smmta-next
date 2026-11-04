# Email build — ideas and tracked follow-ups

Improvements noticed during the build that are outside the section being built. Nothing here
is half-done in the code unless the entry says so.

## Tracked items

- **Section 3 → 9: back-in-stock deep link.** `TODO(section 9)`: the back-in-stock email links to the product page; section 9 (the signed add-to-cart route, built in section 7 step 4) should switch it to the exact-variant add-to-cart link. *Status: open until section 7/9 resolves it.*
- **Retire the storefront's `POST /api/internal/send-back-in-stock` route** (`apps/store`, `apps/store-clothes`). The API no longer calls it after section 3. Leave it until the new pipeline has run live for a while, then delete it and its template.
- **Storefront order emails** (confirmation, dispatch, refund) still go through each storefront's own `email_outbox` and SendGrid call, not this module's gate. They are order-required mail, which the gate always allows, so nothing is sent that should not be; moving them would put their delivery events in `email_sends` too. A separate piece of work.
