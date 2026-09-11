/**
 * Start the Intuit authorisation flow for one company file.
 * Only a QuickBooks administrator can complete it. Guarded by ADMIN_KEY so the
 * link cannot be triggered by anyone who stumbles on the URL.
 */
import crypto from "node:crypto";
import { CFG, configProblems, db, getRealm } from "@/lib/core";

export const dynamic = "force-dynamic";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const file = (url.searchParams.get("file") ?? "").toUpperCase();
  const key = url.searchParams.get("key") ?? "";

  const problems = configProblems();
  if (problems.length) {
    return new Response(`Not configured. Missing: ${problems.join(", ")}`, { status: 503 });
  }
  if (!CFG.adminKey || key !== CFG.adminKey) {
    return new Response("Forbidden.", { status: 403 });
  }
  if (!file) return new Response("Specify ?file=PMX", { status: 400 });

  try {
    await getRealm(file);
  } catch {
    return new Response(`Unknown company file "${file}".`, { status: 404 });
  }

  const state = crypto.randomBytes(24).toString("hex");
  await db.insert("oauth_state", { state, realm_label: file });

  const authorize = new URL(AUTH_URL);
  authorize.searchParams.set("client_id", CFG.clientId);
  authorize.searchParams.set("response_type", "code");
  // QuickBooks grants one accounting permission covering read and write.
  // There is no read-only scope. The read-only limit is enforced in this codebase.
  authorize.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  authorize.searchParams.set("redirect_uri", CFG.redirectUri);
  authorize.searchParams.set("state", state);

  return Response.redirect(authorize.toString(), 302);
}
