# Changelog

## 11 September 2026 — fork for PSC (QBO-02)

Forked from proactive-qbo-connector (QBO-01) at its 10 September state.

- **Separate Intuit app, deployment and database.** PSC uses the Intuit app "PSC Oauth" with
  its own client credentials, its own Vercel project and its own Supabase project. Nothing in
  the PMX deployment can reach PSC's books or run this repo's create path.
- **Write scopes.** `qbo_realm.write_scope text[]` added. `qboPost` now requires the operation's
  scope (`set_invoice_number` or `create_bill`) in addition to `write_enabled`.
  `/api/admin/enable-writes` takes a `scope` array; disabling clears it; `reset-realm` clears it.
- **Bill creation** (`lib/bills.ts`, tool `create_bill`): one vendor bill per call from an
  approved supplier invoice. Guards: vendor exists/active/currency matches; every line has an
  active postable GL account and a tax code; lines + predicted tax = stated total to the cent;
  vendor + doc number duplicate refused (QuickBooks and `posted_bill`); same-vendor same-amount
  within 7 days refused without explicit override; exchange rate read from QuickBooks for
  foreign-currency bills; dry run default; post-create drift check against what was sent.
- **New read tools**: `list_accounts` (postable accounts only), `list_tax_codes` (with purchase
  rate), `vendor_bill_history` (accounts ranked by frequency — evidence for the recommended GL),
  `posted_bills` (what was created through the connector).
- **New table** `posted_bill`.
- **Public pages, EULA, privacy, callback text and MCP instructions** rewritten to state plainly
  that the app creates bills. These are what Intuit and the consenting admin read.
- Home currency is read from company preferences at write time, not assumed.

## Inherited from QBO-01 (10 September 2026)

OAuth callback refuses to repoint a company file; admin reset endpoint; `intuit_tid` captured on
every response; OAuth endpoints from Intuit discovery; company preferences read directly;
`set_invoice_number` echoes the whole bill back with two fields changed and verifies no drift.
