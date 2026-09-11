# Proactive PSC QuickBooks Connector (QBO-02)

Internal remote MCP server for **Proactive Supply Chain Solutions (PSC)**. Forked from
`proactive-qbo-connector` (QBO-01, PMX) on 2026-09-11. Separate Intuit app (**PSC Oauth**),
separate deployment, separate database, separate credentials. PMX's connector never gains the
bill-creation code in this repo; that boundary is the reason for the fork.

There is no user interface. Claude is the interface.

## Write scope

Reads are unrestricted across vendors, bills, accounts, tax codes and exchange rates. There is
exactly one write path — `qboPost` in `lib/core.ts` — and it accepts two operations, each gated
by a **named scope** granted per company file by an administrator:

| Scope | Tool | What it does |
| --- | --- | --- |
| `set_invoice_number` | `set_invoice_number` (`lib/write.ts`) | Sparse update of `DocNumber` + `PrivateNote` on one existing bill |
| `create_bill` | `create_bill` (`lib/bills.ts`) | Create one vendor bill from an approved supplier invoice |

`qboPost` enforces: `write_enabled = true` on the file; the operation's scope present in
`write_scope`; entity allow-list (Bill only); updates must be sparse with the `SyncToken` just
read; creates must carry no `Id`/`SyncToken` and at least one line.

`create_bill` additionally enforces, before anything is sent: vendor exists and its currency
matches the invoice; every line names an active, postable account (no header, bank, AR, AP,
equity or income accounts) and a tax code; lines + tax at the code's purchase rate equal the
stated invoice total to the cent; no existing bill with the same vendor + document number
(checked in QuickBooks and in `posted_bill`); a same-vendor same-amount bill within 7 days is
refused unless the caller overrides after the user confirms; foreign-currency bills carry an
exchange rate read from QuickBooks for the bill date. Dry run by default; `apply: true`
required. After the create, the returned bill is compared to what was sent and any difference is
logged as `unexpected_drift` and reported.

Nothing in this repository can void or delete a record, change an existing bill's amount,
vendor or account, or initiate a payment.

## Enabling writes

```
POST /api/admin/enable-writes?key=ADMIN_KEY
{ "file": "PSC", "enabled": true, "scope": ["create_bill"],
  "reason": "...", "authorised_by": "Ken ..." }
```

`scope` is an array; grant only what the file needs. Disabling clears the scope.

## Layout

```
app/                   public pages Intuit requires + OAuth + MCP endpoint
  connect/             GET /connect?file=PSC&key=ADMIN_KEY — starts Intuit consent (admin only)
  api/qbo/callback/    Intuit redirect target
  api/mcp/[token]/     the MCP endpoint — one URL per person
  api/admin/user/      mint/revoke a person's connector credential (ADMIN_KEY)
  api/admin/enable-writes/   grant/revoke write scopes per file (ADMIN_KEY)
  api/admin/reset-realm/     clear a company-file mapping (ADMIN_KEY)
lib/core.ts            config, AES-256-GCM token crypto, Supabase, audit, QBO client, qboPost
lib/bills.ts           PSC AP: accounts, tax codes, vendor history, create_bill
lib/write.ts           set_invoice_number (carrier recon)
lib/recon.ts           MX carrier payables matching logic
lib/tools.ts           the tools Claude sees
supabase/schema.sql    schema for the new Supabase project (run once)
SETUP.md               deployment runbook
```

## Dependency pins — do not downgrade

| Package | Version | Why |
| --- | --- | --- |
| next | 15.5.7 | CVE-2025-66478 (React2Shell). Vulnerable: 15.0.0–16.0.6 |
| react / react-dom | 19.1.4 | CVE-2025-55182, CVE-2025-55183, CVE-2025-55184 |

## Notes for whoever maintains this

- A QuickBooks vendor's currency is fixed at creation. Match vendor **and** currency; never infer.
- Canadian company files use `GlobalTaxCalculation: "TaxExcluded"` plus a `TaxCodeRef` per
  line. QuickBooks computes `TxnTaxDetail`; we predict it from the code's purchase rate and
  refuse if the prediction does not match the invoice total, then verify the returned total.
- A CAD home currency makes every USD bill a foreign-currency transaction; `ExchangeRate` is
  required. `create_bill` reads it from `GET exchangerate?sourcecurrencycode=USD&asofdate=...`.
- QuickBooks has no partial update on bills. `set_invoice_number` reads the bill and re-sends it
  whole with two fields changed.
- Rate limits: 500 requests/min per company file, 10/sec.
