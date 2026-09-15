/**
 * Manage connector users. ADMIN_KEY required.
 *
 *  create : { full_name, email, role, mfa_required? }  -> one-time set-password link (24h)
 *  reset  : { email, reset: true }                     -> new set-password link; existing password keeps working until it is used
 *  revoke : { email, revoke: true }                    -> deactivates the account and every token it holds
 *  mfa    : { email, mfa_required: true|false }        -> require an authenticator code at sign-in
 *
 * The link is shown once and never stored — only a hash is kept.
 */
import { CFG, audit, db } from "@/lib/core";
import { baseUrl, issueSetupLink, userByEmail } from "@/lib/auth";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!CFG.adminKey || key !== CFG.adminKey) return new Response("Forbidden.", { status: 403 });

  const body = await req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!email) return Response.json({ error: "email required" }, { status: 400 });
  const base = baseUrl(req);
  const existing = await userByEmail(email);

  if (body?.revoke) {
    if (!existing) return Response.json({ error: "no such user" }, { status: 404 });
    await db.update("connector_user", `id=eq.${existing.id}`, { active: false, revoked_at: new Date().toISOString() });
    await db.update("oauth_token", `user_id=eq.${existing.id}&revoked_at=is.null`, { revoked_at: new Date().toISOString() }).catch(() => {});
    await audit({ kind: "auth", operator: "admin", tool: "revoke_user", detail: { email } });
    return Response.json({ revoked: email, tokens_revoked: true });
  }

  if (typeof body?.mfa_required === "boolean" && existing && !body?.reset) {
    await db.update("connector_user", `id=eq.${existing.id}`, { mfa_required: body.mfa_required });
    await audit({ kind: "auth", operator: "admin", tool: "set_mfa_required", detail: { email, mfa_required: body.mfa_required } });
    return Response.json({ email, mfa_required: body.mfa_required });
  }

  if (body?.reset) {
    if (!existing) return Response.json({ error: "no such user" }, { status: 404 });
    if (!existing.active) return Response.json({ error: "user is revoked; create again to reinstate" }, { status: 409 });
    const link = await issueSetupLink(existing.id, base, "reset");
    await audit({ kind: "auth", operator: "admin", tool: "reset_link", detail: { email } });
    return Response.json({ email, setup_link: link, expires_in_hours: 24, note: "Shown once. Send it to the person directly." });
  }

  const { full_name, role = "reader", mfa_required = false } = body ?? {};
  if (!full_name) return Response.json({ error: "full_name required" }, { status: 400 });
  if (!["reader", "approver", "admin"].includes(role)) return Response.json({ error: "role must be reader, approver or admin" }, { status: 400 });

  let userId: string;
  if (existing) {
    await db.update("connector_user", `id=eq.${existing.id}`, {
      full_name, role, mfa_required, active: true, revoked_at: null, must_set_password: true,
    });
    userId = existing.id;
  } else {
    const rows = await db.insert("connector_user", {
      full_name, email, role, mfa_required, must_set_password: true,
      token_hash: `disabled:${Math.random().toString(36).slice(2)}${Date.now()}`,
    });
    userId = rows[0].id;
  }
  const link = await issueSetupLink(userId, base, "setup");
  await audit({ kind: "auth", operator: "admin", tool: "create_user", detail: { email, role, mfa_required, reinstated: Boolean(existing) } });
  return Response.json({ full_name, email, role, mfa_required, setup_link: link, expires_in_hours: 24,
    note: "Shown once. Send it to the person directly. They set their own password; then they click Connect on the connector in Claude." });
}
