/**
 * LEGACY: per-person URL tokens. Disabled unless ALLOW_LEGACY_TOKENS=true.
 * Replaced by sign-in at /api/mcp. Kept only for a controlled cutover.
 */
import { userFromToken } from "@/lib/core";
import { handleRpc, json } from "@/lib/mcp";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const enabled = () => process.env.ALLOW_LEGACY_TOKENS === "true";

export async function GET() {
  return new Response(enabled() ? "Method Not Allowed" : "Gone", { status: enabled() ? 405 : 410 });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!enabled())
    return json({ error: "gone", error_description: "URL credentials have been retired. Connect with sign-in instead." }, 410);
  const { token } = await ctx.params;
  const user = await userFromToken(token);
  if (!user) return json({ error: "unauthorised" }, 401);
  return handleRpc(req, user);
}
