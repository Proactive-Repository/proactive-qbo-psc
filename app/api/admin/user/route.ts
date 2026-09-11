/**
 * Mint or revoke a personal connector credential. ADMIN_KEY required.
 * The raw token is shown once and never stored — only its SHA-256 hash is kept.
 */
import crypto from "node:crypto";
import { CFG, audit, db, sha256 } from "@/lib/core";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!CFG.adminKey || key !== CFG.adminKey) return new Response("Forbidden.", { status: 403 });

  const body = await req.json().catch(() => ({}));
  const { full_name, email, role = "reader", revoke = false } = body ?? {};
  if (!email) return Response.json({ error: "email required" }, { status: 400 });

  if (revoke) {
    await db.update("connector_user", `email=eq.${encodeURIComponent(email)}`, {
      active: false,
      revoked_at: new Date().toISOString(),
    });
    await audit({ kind: "auth", operator: "admin", tool: "revoke_user", detail: { email } });
    return Response.json({ revoked: email });
  }

  if (!full_name) return Response.json({ error: "full_name required" }, { status: 400 });

  const token = crypto.randomBytes(32).toString("base64url");
  await db.insert("connector_user", {
    full_name,
    email,
    role,
    token_hash: sha256(token),
  });
  await audit({ kind: "auth", operator: "admin", tool: "create_user", detail: { email, role } });

  const base = new URL(req.url).origin;
  return Response.json({
    full_name,
    email,
    role,
    connector_url: `${base}/api/mcp/${token}`,
    note: "Shown once. Add this URL as a custom connector in the person's Claude account.",
  });
}
