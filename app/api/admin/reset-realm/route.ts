/**
 * Clear a company file's mapping and tokens so it can be authorised against a
 * different QuickBooks company — for example moving PMX from the sandbox
 * company to the live company file.
 *
 * Deliberately separate from the OAuth callback and guarded by ADMIN_KEY, so
 * repointing a set of books is an explicit, logged administrative act.
 */
import { CFG, audit, db, getRealm } from "@/lib/core";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  if (!CFG.adminKey || key !== CFG.adminKey) return new Response("Forbidden.", { status: 403 });

  const body = await req.json().catch(() => ({}));
  const { file, confirm_existing_realm, environment } = body ?? {};
  if (!file) return Response.json({ error: "file required (e.g. PMX)" }, { status: 400 });

  const realm = await getRealm(String(file));

  // Require the caller to name the realm being replaced. Stops a mistyped
  // company file from wiping a working connection.
  if (realm.realm_id && confirm_existing_realm !== realm.realm_id) {
    return Response.json(
      {
        error: "confirm_existing_realm must match the realm currently mapped to this file",
        file: realm.label,
        current_realm_id: realm.realm_id,
      },
      { status: 409 },
    );
  }

  await db.update("qbo_token", `realm=eq.${realm.id}`, {
    access_token_enc: "",
    refresh_token_enc: "",
    access_expires_at: new Date(0).toISOString(),
    refresh_failures: 0,
    updated_at: new Date().toISOString(),
  }).catch(() => {});

  const patch: Record<string, unknown> = {
    realm_id: null,
    status: "pending",
    authorised_at: null,
    authorised_by: null,
    write_enabled: false,
    write_scope: [],
    updated_at: new Date().toISOString(),
  };
  if (environment === "production" || environment === "sandbox") patch.environment = environment;

  await db.update("qbo_realm", `id=eq.${realm.id}`, patch);

  await audit({
    realm: realm.id,
    kind: "auth",
    operator: "admin",
    tool: "reset_realm",
    entity: "realm",
    entity_id: realm.realm_id ?? undefined,
    outcome: "reset",
    detail: {
      file: realm.label,
      cleared_realm_id: realm.realm_id,
      environment: patch.environment ?? realm.environment,
      note: "Mapping and tokens cleared. Writes forced off. Re-authorisation required.",
    },
  });

  return Response.json({
    file: realm.label,
    status: "pending",
    environment: patch.environment ?? realm.environment,
    cleared_realm_id: realm.realm_id,
    next: `A QuickBooks admin must now authorise ${realm.label} again via /connect?file=${realm.label}&key=<ADMIN_KEY>`,
  });
}
