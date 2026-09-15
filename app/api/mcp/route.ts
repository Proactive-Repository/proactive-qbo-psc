/**
 * MCP endpoint: POST /api/mcp with a bearer access token obtained by signing in.
 * A missing or invalid token gets 401 plus the RFC 9728 pointer so Claude knows
 * where to send the person to sign in.
 */
import { baseUrl, userFromBearer } from "@/lib/auth";
import { handleRpc, json } from "@/lib/mcp";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorised(req: Request) {
  const b = baseUrl(req);
  return json({ error: "unauthorised", error_description: "sign in required" }, 401, {
    "www-authenticate": `Bearer resource_metadata="${b}/.well-known/oauth-protected-resource", scope="qbo"`,
  });
}

export async function GET(req: Request) {
  const user = await userFromBearer(req.headers.get("authorization"));
  if (!user) return unauthorised(req);
  return new Response("Method Not Allowed", { status: 405 });
}

export async function POST(req: Request) {
  const user = await userFromBearer(req.headers.get("authorization"));
  if (!user) return unauthorised(req);
  return handleRpc(req, user);
}
