# SETUP — proactive-qbo-psc (QBO-02)

Do these in order. Steps marked **(you)** involve credentials or approvals and must be done by
Michael, not by Claude.

## 1. GitHub (you)

1. Create a new **private** repo `Proactive-Repository/proactive-qbo-psc`.
2. Upload the contents of this zip to the repo root (drag all folders and files in, commit).

## 2. Supabase — new project (you, then Claude)

1. supabase.com → New project → name `proactive-qbo-psc`, region **ca-central-1**.
2. SQL editor → paste `supabase/schema.sql` → Run. Creates all tables and seeds the `PSC` realm.
3. Project Settings → API: note the **Project URL** and the **service_role** key for step 4.
   Do not paste keys into chat.

## 3. Vercel — new project (you)

1. vercel.com → Add New → Project → import `proactive-qbo-psc`. Framework: Next.js. Deploy.
2. Note the production URL. Expected: `https://proactive-qbo-psc-proactive-supply-chain-group.vercel.app`
   (if Vercel gives a different one, use that everywhere below).

## 4. Environment variables (you) — Vercel → Project → Settings → Environment Variables

| Name | Value |
| --- | --- |
| `QBO_CLIENT_ID` | from Intuit app **PSC Oauth** → Keys & credentials → **Production** |
| `QBO_CLIENT_SECRET` | same page |
| `QBO_ENV` | `production` |
| `QBO_REDIRECT_URI` | `https://<vercel-url>/api/qbo/callback` |
| `SUPABASE_URL` | new project's URL |
| `SUPABASE_SERVICE_ROLE_KEY` | new project's service_role key |
| `TOKEN_ENC_KEY` | **new** 32-byte base64 key — generate: `openssl rand -base64 32`. Do NOT reuse PMX's. |
| `ADMIN_KEY` | **new** long random string — `openssl rand -base64 32`. Do NOT reuse PMX's. |

Then **Redeploy** so the variables take effect.

## 5. Intuit app "PSC Oauth" (you) — developer.intuit.com → PSC Oauth

1. **Settings → Redirect URIs** (Production): add `https://<vercel-url>/api/qbo/callback`.
2. **Settings → App URLs**: Launch `https://<vercel-url>/launch`, Disconnect `https://<vercel-url>/disconnect`,
   Privacy `https://<vercel-url>/privacy`, EULA `https://<vercel-url>/eula`.
3. **Description**: reads vendors, bills, chart of accounts and tax codes; creates vendor bills
   from approved supplier invoices, one at a time, human-confirmed, duplicate-checked, logged;
   can set document number and memo on an existing bill; cannot void, delete or pay. Internal use,
   Proactive Supply Chain Solutions only.
4. **Get production keys** → complete the security questionnaire (same as QBO-01, but answer the
   "does the app write" questions honestly: yes, creates Bills and updates two fields on Bills).
5. Production keys appear under Keys & credentials → Production. Put them in step 4.

## 6. Consent (Bill)

Send Bill this link; he opens it signed into QuickBooks as admin of the **PSC** company file:

```
https://<vercel-url>/connect?file=PSC&key=<ADMIN_KEY>
```

The callback records the realm id and marks PSC `authorised`. Writes stay off.

## 7. Credentials (Claude, via admin endpoint)

```
POST https://<vercel-url>/api/admin/user?key=<ADMIN_KEY>
{ "full_name": "Michael Mancuso", "email": "michael@proactivegroup.ca", "role": "admin" }
{ "full_name": "Manpreet Kaur",   "email": "mkaur@proactivegroup.ca",   "role": "approver" }
```

Each returns a one-time `connector_url`. Send Manpreet hers directly — it is her credential.
She adds it in Claude → Settings → Connectors → Add custom connector.

## 8. Verify read-only first

In Claude with the PSC connector: `company_files`, `connection_status PSC` (confirms home
currency CAD, multicurrency, sales tax on), `list_accounts PSC`, `list_tax_codes PSC`,
`list_vendors PSC`. Capture Manpreet's baseline (`capture_baseline`): invoices/week, minutes
each, backlog.

## 9. Test create_bill (dry runs, then one real)

1. Dry-run `create_bill` on a real approved invoice. Check the preview against the PDF.
2. `apply: true` on **one** bill. Open it in QuickBooks: vendor, number, date, lines, accounts,
   tax, total. Only then normal use.

## 10. Enable the scope (Claude, with named authoriser)

```
POST https://<vercel-url>/api/admin/enable-writes?key=<ADMIN_KEY>
{ "file": "PSC", "enabled": true, "scope": ["create_bill"],
  "reason": "PSC AP bill posting from approved supplier invoices (QBO-02)",
  "authorised_by": "Ken <surname>" }
```

Add `"set_invoice_number"` to the scope array only if PSC also runs carrier reconciliation.

## Clean-up in the PMX database (Claude)

Delete the `PSC` row from the **PMX** project's `qbo_realm` (`e0cb0397-…`). PMX's connector must
never point at PSC's books.
