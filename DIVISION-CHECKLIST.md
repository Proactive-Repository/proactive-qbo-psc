# Adding a division (one repo, one deployment per division)

Code is division-agnostic; `proactive-qbo-psc` on GitHub serves every division. Each division
gets its own Intuit app, Vercel project, Supabase project and users. ~45 minutes.

1. **Intuit** → Create app `<LABEL> Oauth`, scope com.intuit.quickbooks.accounting. Fill App
   details with `https://proactive-qbo-<label>-proactive-supply-chain-group.vercel.app` +
   /eula /privacy /launch /disconnect /reconnect. Redirect URI (production):
   `https://proactive-qbo-<label>-…vercel.app/api/qbo/callback`. Compliance answers = PSC's.
2. **Supabase** → New project `proactive-qbo-<label>` (ca-central-1). SQL editor: run
   `supabase/schema.sql`, then `supabase/migration_002_login.sql`, then `supabase/new_division.sql`
   (edited for the label, legal name, home currency).
3. **Vercel** → Add New Project → import `Proactive-Repository/proactive-qbo-psc` again → name
   `proactive-qbo-<label>`. Settings → Deployment Protection → Vercel Authentication OFF.
4. **Env vars** (Production): QBO_CLIENT_ID, QBO_CLIENT_SECRET (from the new Intuit app's
   Production keys), QBO_ENV=production, QBO_REDIRECT_URI, SUPABASE_URL,
   SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY (new), ADMIN_KEY (new), and
   APP_LABEL=<LABEL>, APP_DIVISION_NAME=<legal name>, APP_PROJECT_CODE=QBO-0N. Redeploy.
5. **Check** `https://…/connect?file=<LABEL>` → "Forbidden" (configured). `/.well-known/oauth-authorization-server` → JSON.
6. **Consent**: QBO admin opens `https://…/connect?file=<LABEL>&key=<ADMIN_KEY>`.
7. **Users**: `POST /api/admin/user?key=<ADMIN_KEY>` per person → one-time set-password link.
8. **Claude** Admin → Connectors → Add custom connector `<LABEL> QuickBooks`, URL `https://…/api/mcp`.
9. **Writes**: after a verified dry run, `POST /api/admin/enable-writes` with scope
   (`create_bill` and/or `set_invoice_number`), reason, named authoriser.
10. QBO file: "Warn if duplicate bill number is used" OFF if the division runs carrier recon.
