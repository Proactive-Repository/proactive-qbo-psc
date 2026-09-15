/**
 * RFC 7591 dynamic client registration. Claude registers itself here the first
 * time it sees this connector. Only redirect URIs on Anthropic's domains are
 * accepted, so a registration cannot redirect a person's code anywhere else.
 */
import { registerClient } from "@/lib/auth";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let meta: any;
  try {
    meta = await req.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  try {
    const c = await registerClient(meta);
    return Response.json(
      {
        client_id: c.client_id,
        ...(c.client_secret ? { client_secret: c.client_secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: c.redirect_uris,
        client_name: c.client_name ?? undefined,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: c.client_secret ? "client_secret_post" : "none",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (e: any) {
    return Response.json({ error: e?.oauth ?? "invalid_client_metadata", error_description: String(e?.message ?? e) }, { status: 400 });
  }
}
