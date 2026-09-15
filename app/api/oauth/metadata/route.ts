/** RFC 8414 authorization server metadata. Served at /.well-known/oauth-authorization-server via rewrite. */
import { baseUrl } from "@/lib/auth";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const b = baseUrl(req);
  return Response.json(
    {
      issuer: b,
      authorization_endpoint: `${b}/api/oauth/authorize`,
      token_endpoint: `${b}/api/oauth/token`,
      registration_endpoint: `${b}/api/oauth/register`,
      revocation_endpoint: `${b}/api/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["qbo"],
      service_documentation: `${b}/launch`,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
