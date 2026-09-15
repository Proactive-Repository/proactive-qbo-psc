import { PROJECT_CODE } from "@/lib/brand";
/**
 * Intuit redirects here after a QuickBooks administrator authorises a company file.
 */
import { audit, db, exchangeCode, getRealm, saveTokens } from "@/lib/core";

export const dynamic = "force-dynamic";

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <body style="font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:640px;margin:64px auto;padding:0 24px;color:#222">
     <h1 style="color:#1F3557;font-size:24px">${title}</h1>${body}
     <p style="margin-top:40px;color:#5A6472;font-size:13px">Proactive Supply Chain Group · ${PROJECT_CODE}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const error = url.searchParams.get("error");

  if (error) return page("Authorisation cancelled", `<p>Intuit reported: <code>${error}</code></p>`, 400);
  if (!code || !state || !realmId) return page("Missing parameters", "<p>Incomplete callback.</p>", 400);

  const rows = await db.select("oauth_state", `state=eq.${state}&select=*`);
  if (!rows?.length || rows[0].consumed_at) {
    return page("Invalid state", "<p>This authorisation link has expired or was already used.</p>", 400);
  }
  await db.update("oauth_state", `state=eq.${state}`, { consumed_at: new Date().toISOString() });

  const label = rows[0].realm_label;
  const realm = await getRealm(label);

  /**
   * A company file mapping is never silently repointed.
   *
   * Without this, anyone who reached /connect could authorise their own
   * QuickBooks company and PMX would start reading a different set of books.
   * Re-authorising the SAME company file is fine (that is reconnect).
   * Pointing a label at a DIFFERENT realm requires an explicit admin reset,
   * which is logged.
   */
  if (realm.realm_id && realm.realm_id !== realmId) {
    await audit({
      realm: realm.id,
      kind: "error",
      tool: "oauth_callback",
      entity: "realm",
      entity_id: realmId,
      outcome: "realm_mismatch_refused",
      detail: { label, existing_realm: realm.realm_id, attempted_realm: realmId },
    });
    return page(
      "Authorisation refused",
      `<p><strong>${label}</strong> is already mapped to a different QuickBooks company
       (existing <code>${realm.realm_id}</code>, attempted <code>${realmId}</code>).</p>
       <p style="background:#FBF3E4;border-left:4px solid #1F3557;padding:14px 18px">
       This has been refused and logged. Repointing a company file is a deliberate
       administrative act, not something an authorisation link can do.</p>
       <p>If this is intended — for example moving from a sandbox company to the live
       company file — an administrator must reset the mapping first.</p>`,
      409,
    );
  }

  try {
    const tok = await exchangeCode(code);
    await saveTokens(realm.id, tok);
    await db.update("qbo_realm", `id=eq.${realm.id}`, {
      realm_id: realmId,
      status: "authorised",
      authorised_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await audit({
      realm: realm.id,
      kind: "auth",
      tool: "oauth_callback",
      entity: "realm",
      entity_id: realmId,
      detail: { label },
    });
    return page(
      `${label} connected`,
      `<p>QuickBooks company file <strong>${label}</strong> (realm <code>${realmId}</code>) is now authorised.</p>
       <p style="background:#FBF3E4;border-left:4px solid #1F3557;padding:14px 18px">
       This connection reads vendor, bill, account and tax-code data. Writes are <strong>disabled</strong> for this company file until an administrator explicitly enables them. When enabled, the application can (a) set the document number and memo on an existing bill and (b) create a vendor bill from an approved supplier invoice &mdash; one record at a time, confirmed by a person, logged. It cannot void, delete or pay anything.</p>
       <p>You can close this window. Revoke at any time from QuickBooks Online under Settings → Apps.</p>`,
    );
  } catch (e: any) {
    await audit({ realm: realm.id, kind: "error", tool: "oauth_callback", outcome: "exchange_failed",
      detail: { message: String(e?.message ?? e).slice(0, 500) } });
    return page("Could not complete authorisation", `<p><code>${String(e?.message ?? e)}</code></p>`, 500);
  }
}
