/** RFC 7009 token revocation. Always 200 per spec. */
import { revokeToken } from "@/lib/auth";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = new URLSearchParams(await req.text());
  const t = body.get("token");
  if (t) await revokeToken(t);
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
