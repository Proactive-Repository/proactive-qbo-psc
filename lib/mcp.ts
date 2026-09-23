import { LABEL, PROJECT_CODE, SERVER_NAME } from "@/lib/brand";
/** JSON-RPC handling for the MCP endpoint, shared by the bearer route and the legacy token route. */
import { TOOLS, TOOL_MAP } from "@/lib/tools";
import { ConnectorUser, audit } from "@/lib/core";

const PROTOCOL = "2025-06-18";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const rpcError = (id: any, code: number, message: string) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export const INSTRUCTIONS =
  `Proactive's QuickBooks Online connector for ${LABEL} (project ${PROJECT_CODE}). Reads vendors, bills, ` +
  "chart of accounts and tax codes. Three tools change QuickBooks: set_invoice_number (document " +
  "number + memo on one existing bill), create_bill (one new vendor bill) and create_expense (one " +
  "credit-card Purchase for a statement line). All default to a dry run and need apply:true. For create_bill: always " +
  "run the dry run first and show the user the exact bill; every line's GL account must be " +
  "confirmed by the user; apply only after the user types 'post to qbo'; never override a " +
  "possible-duplicate flag without the user confirming it is a different invoice. Nothing " +
  "here can void or delete a record, edit an existing bill's amount or vendor, or pay anything. " +
  "Reporting: run_report (any QuickBooks report), financial_package (normalised P&L/BS/CF for consolidation), query_records (filtered raw records), fx_rate, company_info — all read only. Start with company_files to see which company files are authorised. " +
  "Remember that a QuickBooks vendor's currency is fixed at creation, so a carrier " +
  "billing in both CAD and USD has two vendor records; always match on carrier AND " +
  "currency together.";

export async function handleRpc(req: Request, user: ConnectorUser): Promise<Response> {
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  const { id, method, params } = msg ?? {};
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
            serverInfo: { name: SERVER_NAME, version: "0.5.1" },
            instructions: INSTRUCTIONS + ` You are signed in as ${user.full_name} (${user.email}), role ${user.role}.`,
          },
        });
      case "ping":
        return json({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
        });
      case "tools/call": {
        const tool = TOOL_MAP.get(params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const text = await tool.handler(params?.arguments ?? {}, { user });
          return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
        } catch (e: any) {
          const message = String(e?.message ?? e);
          await audit({ kind: "error", operator: user.email, tool: params?.name, outcome: "tool_error", detail: { message: message.slice(0, 500) } });
          return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `**Could not complete that.** ${message}` }], isError: true } });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return rpcError(id, -32603, String(e?.message ?? e));
  }
}
