# Changelog

## 22 September 2026 — credit-card expenses (v0.5.0)

New write scope `create_expense`: creates a QuickBooks Purchase (PaymentType CreditCard) on a
Credit Card account for a statement line with no matching entry. Guards as create_bill (postable
GL, tax code on Canadian files, lines + tax = statement amount, exact-duplicate refusal on card +
date + amount, 3-day possible-duplicate flag, dry run default, post-write drift check). New read
tools `list_card_accounts`, `card_transactions`. New table `posted_expense`. Bank accounts are not
writable; nothing can pay, void or delete.


## 21 September 2026 — US tax model for create_bill (v0.4.1)

`create_bill` detects a US company file (CompanyInfo.Country = US) and omits per-line
`TaxCodeRef` and `GlobalTaxCalculation`, which QuickBooks US rejects. `tax_code` is now optional
on a line and ignored on US files; still required on Canadian files. Needed for PGU and PLX.


## 16 September 2026 — financial reporting (v0.4.0)

Read-only tools for management reporting and consolidation: `run_report` (any QuickBooks
report, flattened to a table), `financial_package` (P&L, balance sheet, cash flow for a period as
normalised lines + totals + company facts + intercompany-looking accounts flagged for review),
`query_records` (guarded SELECT over common entities), `fx_rate` (QuickBooks' rate table),
`company_info`. No new write paths; no Intuit declaration change (reads were always declared).


## 15 September 2026 — connector sign-in (v0.3.0)

- **People sign in; URLs are no longer credentials.** The connector is now an OAuth 2.1
  authorization server (RFC 8414 metadata, RFC 9728 resource metadata, RFC 7591 dynamic client
  registration, PKCE S256 mandatory). Claude connects to `/api/mcp`, is redirected to the
  connector's own sign-in page, and the person enters the email and password Proactive issued.
  Every MCP call carries a bearer token that resolves to that person.
- **Passwords** are scrypt-hashed with a per-user salt; set by the person through a one-time
  24-hour link issued by an administrator (`/api/admin/user`). No self-service reset.
- **MFA** (RFC 6238 TOTP) can be enrolled at set-up and required per user (`mfa_required`).
- **Lockout** after 8 failed attempts for 15 minutes. Failed and successful sign-ins are audited.
- **Tokens**: 1-hour access, 30-day refresh with rotation; deactivating a user kills all tokens.
- **Legacy `/api/mcp/<token>` route** returns 410 unless `ALLOW_LEGACY_TOKENS=true`.
- One connector per division in Claude's org list; visibility groups are optional convenience,
  authorisation is enforced by the connector.
- Schema: `supabase/migration_002_login.sql`.


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
