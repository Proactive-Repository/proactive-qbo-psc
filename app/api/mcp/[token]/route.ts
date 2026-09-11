/**
 * MCP endpoint. One URL per person: /api/mcp/<personal-token>
 * The token identifies the operator, which is what makes the audit log meaningful.
 */
import { TOOLS, TOOL_MAP } from "@/lib/tools";
import { audit, userFromToken } from "@/lib/core";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROTOCOL = "2025-06-18";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const rpcError = (id: any, code: number, message: string) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function GET() {
  // Streamable HTTP: no server-initiated stream on this server.
  return new Response("Method Not Allowed", { status: 405 });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const user = await userFromToken(token);
  if (!user) return json({ error: "unauthorised" }, 401);

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const { id, method, params } = msg ?? {};

  // notifications carry no id and expect no body
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  try {
    switch (method) {
      case "initialize":
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "proactive-qbo-psc", version: "0.2.0" },
            instructions:
              "Proactive's QuickBooks Online connector for PSC (project QBO-02). Reads vendors, bills, " +
              "chart of accounts and tax codes. Exactly two tools change QuickBooks: set_invoice_number " +
              "(document number + memo on one existing bill) and create_bill (one new vendor bill from an " +
              "approved invoice). Both default to a dry run and need apply:true. For create_bill: always " +
              "run the dry run first and show the user the exact bill; every line's GL account must be " +
              "confirmed by the user; apply only after the user types 'post to qbo'; never override a " +
              "possible-duplicate flag without the user confirming it is a different invoice. Nothing " +
              "here can void or delete a record, edit an existing bill's amount or vendor, or pay anything. " +
              "Start with company_files to see which company files are authorised. " +
              "Remember that a QuickBooks vendor's currency is fixed at creation, so a carrier " +
              "billing in both CAD and USD has two vendor records; always match on carrier AND " +
              "currency together.",
          },
        });

      case "ping":
        return json({ jsonrpc: "2.0", id, result: {} });

      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });

      case "tools/call": {
        const tool = TOOL_MAP.get(params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const text = await tool.handler(params?.arguments ?? {}, { user });
          return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
        } catch (e: any) {
          const message = String(e?.message ?? e);
          await audit({
            kind: "error",
            operator: user.email,
            tool: params?.name,
            outcome: "tool_error",
            detail: { message: message.slice(0, 500) },
          });
          return json({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `**Could not complete that.** ${message}` }], isError: true },
          });
        }
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return rpcError(id, -32603, String(e?.message ?? e));
  }
}
