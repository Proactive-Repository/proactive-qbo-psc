import { BRAND } from "@/lib/brand";
/** RFC 9728 protected resource metadata for the MCP endpoint. Served at /.well-known/oauth-protected-resource[/api/mcp]. */
import { baseUrl } from "@/lib/auth";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const b = baseUrl(req);
  return Response.json(
    {
      resource: `${b}/api/mcp`,
      authorization_servers: [b],
      bearer_methods_supported: ["header"],
      scopes_supported: ["qbo"],
      resource_name: BRAND,
      resource_documentation: `${b}/launch`,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
