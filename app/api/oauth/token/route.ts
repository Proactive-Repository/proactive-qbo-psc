/** Token endpoint: authorization_code (with PKCE) and refresh_token grants. */
import { getClient, issueTokens, redeemCode, refreshTokens } from "@/lib/auth";
import { audit, sha256 } from "@/lib/core";
export const dynamic = "force-dynamic";

const err = (error: string, error_description: string, status = 400) =>
  Response.json({ error, error_description }, { status, headers: { "cache-control": "no-store" } });

async function readBody(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = await req.json().catch(() => ({}));
    return new URLSearchParams(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(await req.text());
}

function clientAuth(req: Request, body: URLSearchParams) {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    return { client_id: decodeURIComponent(id ?? ""), client_secret: decodeURIComponent(secret ?? "") };
  }
  return { client_id: body.get("client_id") ?? "", client_secret: body.get("client_secret") ?? "" };
}

export async function POST(req: Request) {
  const body = await readBody(req);
  const { client_id, client_secret } = clientAuth(req, body);
  if (!client_id) return err("invalid_client", "client_id missing", 401);
  const client = await getClient(client_id);
  if (!client) return err("invalid_client", "unknown client", 401);
  if (client.client_secret_hash && sha256(client_secret) !== client.client_secret_hash)
    return err("invalid_client", "client authentication failed", 401);

  const grant = body.get("grant_type");

  if (grant === "authorization_code") {
    const code = body.get("code") ?? "";
    const verifier = body.get("code_verifier") ?? "";
    if (!code || !verifier) return err("invalid_request", "code and code_verifier are required");
    const r = await redeemCode(code, client_id, body.get("redirect_uri") ?? "", verifier);
    if ("error" in r) return err(r.error, r.description);
    const tokens = await issueTokens(r.user_id, client_id, r.scope);
    await audit({ kind: "auth", tool: "oauth_token", outcome: "issued", detail: { client_id, user_id: r.user_id } });
    return Response.json(tokens, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  }

  if (grant === "refresh_token") {
    const rt = body.get("refresh_token") ?? "";
    if (!rt) return err("invalid_request", "refresh_token is required");
    const r = await refreshTokens(rt, client_id);
    if ("error" in r) return err(r.error, r.description);
    const { ok, ...tokens } = r;
    return Response.json(tokens, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  }

  return err("unsupported_grant_type", "use authorization_code or refresh_token");
}
