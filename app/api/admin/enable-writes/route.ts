/**
 * Turn the write path on or off for one company file.
 *
 * Deliberately an administrative endpoint and not a tool in Claude: enabling
 * writes to a live general ledger is a steering decision under charter QBO-02,
 * so it takes the admin key and it is logged with a stated reason.
 */
import { CFG, audit, db, getRealm } from "@/lib/core";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!CFG.adminKey || key !== CFG.adminKey) return new Response("Forbidden.", { status: 403 });

  const body = await req.json().catch(() => ({}));
  const { file, enabled, reason, authorised_by } = body ?? {};
  const VALID = ["set_invoice_number", "create_bill", "create_expense"];
  const scope: string[] = Array.isArray(body?.scope) ? body.scope.map(String) : [];
  if (enabled && (!scope.length || scope.some((s) => !VALID.includes(s))))
    return Response.json(
      { error: `scope required when enabling writes: an array from ${JSON.stringify(VALID)}` },
      { status: 400 },
    );

  if (!file) return Response.json({ error: "file required (e.g. PMX)" }, { status: 400 });
  if (typeof enabled !== "boolean")
    return Response.json({ error: "enabled must be true or false" }, { status: 400 });
  if (enabled && !reason)
    return Response.json(
      { error: "reason required when enabling writes — it goes in the audit log" },
      { status: 400 },
    );
  if (enabled && !authorised_by)
    return Response.json(
      { error: "authorised_by required when enabling writes — name the person who decided" },
      { status: 400 },
    );

  const realm = await getRealm(String(file));

  if (enabled && realm.status !== "authorised") {
    return Response.json(
      { error: `${realm.label} is not authorised (status: ${realm.status}). Connect it first.` },
      { status: 409 },
    );
  }

  await db.update("qbo_realm", `id=eq.${realm.id}`, {
    write_enabled: enabled,
    write_scope: enabled ? scope : [],
    updated_at: new Date().toISOString(),
  });

  await audit({
    realm: realm.id,
    kind: "auth",
    operator: authorised_by ? String(authorised_by) : "admin",
    tool: "enable_writes",
    entity: "realm",
    entity_id: realm.realm_id ?? undefined,
    outcome: enabled ? "writes_enabled" : "writes_disabled",
    detail: {
      file: realm.label,
      environment: realm.environment,
      reason: reason ?? "disabled",
      authorised_by: authorised_by ?? null,
      scope: enabled ? scope : [],
      scope_meaning: {
        set_invoice_number: "Bill.DocNumber and Bill.PrivateNote on an existing bill, sparse, one record at a time",
        create_bill: "Create one vendor bill from an approved invoice; duplicate-guarded, total-checked, human-confirmed",
      },
    },
  });

  return Response.json({
    file: realm.label,
    write_enabled: enabled,
    environment: realm.environment,
    scope: enabled ? scope : [],
    logged: true,
  });
}
