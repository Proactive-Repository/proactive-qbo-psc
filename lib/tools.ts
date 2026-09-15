import { LABEL } from "./brand";
/**
 * MCP tools exposed to Claude (QBO-02, PSC).
 *
 * Every tool here reads, except two:
 *   set_invoice_number — document number + memo on one existing bill
 *   create_bill        — one new vendor bill from an approved invoice
 * Both default to a dry run, both require apply: true, and each is refused
 * outright unless an administrator has enabled that specific scope for the
 * company file. Nothing can void, delete or pay.
 *
 * record_decision and capture_baseline write only to Proactive's own tables.
 */
import {
  ConnectorUser,
  Realm,
  audit,
  configProblems,
  db,
  getPreferences,
  getRealm,
  hasScope,
  listRealms,
  money,
  qboQueryAll,
  scopeError,
  table,
} from "./core";
import {
  createBill,
  loadAccounts,
  loadTaxCodes,
  postableAccounts,
  vendorBillHistory,
} from "./bills";
import {
  InvoiceLine,
  loadVendors,
  pairVendors,
  reconcile,
  resolveVendor,
  saveRun,
} from "./recon";
import { setInvoiceNumber } from "./write";

type Ctx = { user: ConnectorUser };
type Handler = (args: any, ctx: Ctx) => Promise<string>;

const READ_ONLY_BANNER =
  "\n\n_Read call. Nothing was changed in QuickBooks._";

async function realmOf(label: string): Promise<Realm> {
  const r = await getRealm(label);
  if (r.status !== "authorised" || !r.realm_id) {
    throw new Error(
      `${r.label} is not connected yet (status: ${r.status}). A QuickBooks admin must authorise it first.`,
    );
  }
  return r;
}

/* ------------------------------------------------------------------ tools */

export const TOOLS: {
  name: string;
  description: string;
  inputSchema: any;
  handler: Handler;
}[] = [
  {
    name: "company_files",
    description:
      "List the QuickBooks company files this connector knows about and whether each is authorised. Start here.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, { user }) => {
      const problems = configProblems();
      const realms = await listRealms();
      await audit({ kind: "read", operator: user.email, tool: "company_files" });
      const rows = realms.map((r) => ({
        File: r.label,
        Status: r.status,
        Environment: r.environment,
        "Realm id": r.realm_id ?? "—",
        Writes: r.write_enabled ? `ENABLED: ${(r.write_scope ?? []).join(", ") || "no scope"}` : "disabled",
        Authorised: r.authorised_at ? `${r.authorised_by ?? "?"} · ${r.authorised_at.slice(0, 10)}` : "—",
      }));
      return (
        (problems.length
          ? `**Not configured yet.** Missing environment variables: ${problems.join(", ")}.\n\n`
          : "") + table(rows)
      );
    },
  },

  {
    name: "connection_status",
    description:
      "Health of a company file's connection: token freshness, refresh failures, and whether it can be queried right now.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string", description: "Company file label, e.g. PMX" } },
      required: ["file"],
    },
    handler: async ({ file }, { user }) => {
      const r = await getRealm(file);
      const tok = await db.select("qbo_token", `realm=eq.${r.id}&select=*`);
      await audit({ realm: r.id, kind: "read", operator: user.email, tool: "connection_status" });
      if (!tok?.length || !tok[0].access_token_enc)
        return `**${r.label}** — status *${r.status}*. No usable tokens stored; not connected.`;
      const t = tok[0];
      const mins = Math.round((new Date(t.access_expires_at).getTime() - Date.now()) / 60000);
      const lines = [
        `**${r.label}** — status *${r.status}*, environment *${r.environment}*`,
        `- Realm id: ${r.realm_id ?? "—"}`,
        `- Access token expires in ${mins} minute(s) (auto-refreshed)`,
        `- Refresh token expires ${t.refresh_expires_at?.slice(0, 10) ?? "unknown"}`,
        `- Consecutive refresh failures: ${t.refresh_failures}`,
        `- Writes to QuickBooks: ${r.write_enabled ? `ENABLED — ${(r.write_scope ?? []).join(", ")}` : "disabled"}`,
        `- Home currency (stored): ${r.home_currency ?? "not recorded"}`,
      ];
      // Read the company's own preferences rather than inferring capability.
      if (r.status === "authorised" && r.realm_id) {
        try {
          const p = await getPreferences(r, user.email);
          lines.push(
            `- Multicurrency: ${p.multicurrency ? `on (home ${p.home_currency ?? "?"})` : "OFF"}`,
            `- Location tracking: ${p.location_tracking ? "on" : "off"}`,
            `- Class tracking: ${p.class_tracking ? "on" : "off"}`,
          );
          if (!p.multicurrency)
            lines.push(
              "",
              "**Multicurrency is off on this company file.** Carrier currency cannot be read from QuickBooks, so the reconciliation will fall back to inferring it from vendor names and will raise exceptions rather than guess.",
            );
        } catch (e: any) {
          lines.push(`- Preferences: could not be read (${String(e?.message ?? e).slice(0, 120)})`);
        }
      }
      return lines.join("\n");
    },
  },

  {
    name: "list_vendors",
    description:
      "List carriers/vendors on a company file with their fixed currency. Use to see which carriers have paired CAD and USD records.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        search: { type: "string", description: "Optional name filter" },
      },
      required: ["file"],
    },
    handler: async ({ file, search }, { user }) => {
      const r = await realmOf(file);
      const vendors = await loadVendors(r, user.email);
      await audit({
        realm: r.id,
        kind: "read",
        operator: user.email,
        tool: "list_vendors",
        detail: { count: vendors.length },
      });
      const filtered = search
        ? vendors.filter((v) => v.DisplayName.toLowerCase().includes(String(search).toLowerCase()))
        : vendors;
      const rows = filtered
        .slice(0, 200)
        .map((v) => ({
          Id: v.Id,
          Vendor: v.DisplayName,
          Currency: v.CurrencyRef?.value ?? "—",
          Active: v.Active === false ? "no" : "yes",
        }));
      return `${filtered.length} vendor(s)${filtered.length > 200 ? " (showing 200)" : ""}\n\n${table(
        rows,
      )}${READ_ONLY_BANNER}`;
    },
  },

  {
    name: "currency_pairs",
    description:
      "Find carriers that exist twice — once for CAD and once for USD — because a QuickBooks vendor's currency is fixed at creation. Shows which pairs are incomplete or ambiguous.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, save: { type: "boolean" } },
      required: ["file"],
    },
    handler: async ({ file, save }, { user }) => {
      const r = await realmOf(file);
      const vendors = await loadVendors(r, user.email);
      const pairs = pairVendors(vendors).filter((p) => p.members.length > 1);
      await audit({
        realm: r.id,
        kind: "read",
        operator: user.email,
        tool: "currency_pairs",
        detail: { pairs: pairs.length },
      });
      if (save) {
        await db.insert(
          "vendor_currency_pair",
          pairs.flatMap((p) =>
            p.members
              .filter((m) => m.currency === "CAD" || m.currency === "USD")
              .map((m) => ({
                realm: r.id,
                base_name: p.base,
                vendor_id: m.id,
                vendor_name: m.name,
                currency: m.currency,
              })),
          ),
        ).catch(() => {});
      }
      const rows = pairs.map((p) => ({
        Carrier: p.members[0].name.replace(/\s+(usd|cdn|cad)\s*$/i, ""),
        Records: p.members.map((m) => `${m.name} [${m.currency}]`).join(" · "),
        Currencies: p.currencies.join(", "),
        Complete: p.currencies.includes("CAD") && p.currencies.includes("USD") ? "yes" : "NO",
      }));
      return `${pairs.length} carrier(s) with more than one vendor record.\n\n${table(rows)}${
        save ? "\n\n_Pair map saved._" : ""
      }${READ_ONLY_BANNER}`;
    },
  },

  {
    name: "find_bills",
    description:
      "Look up bills on a company file by vendor, date range, document number or amount. Read only; changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        vendor: { type: "string", description: "Carrier name (partial is fine)" },
        currency: { type: "string", enum: ["CAD", "USD"] },
        since: { type: "string", description: "YYYY-MM-DD" },
        doc_number: { type: "string" },
        limit: { type: "number" },
      },
      required: ["file"],
    },
    handler: async ({ file, vendor, currency, since, doc_number, limit }, { user }) => {
      const r = await realmOf(file);
      const clauses: string[] = [];
      if (since) clauses.push(`TxnDate >= '${since}'`);
      if (doc_number) clauses.push(`DocNumber = '${String(doc_number).replace(/'/g, "")}'`);
      if (vendor) {
        const vendors = await loadVendors(r, user.email);
        const { vendor: v, candidates } = resolveVendor(vendors, vendor, currency ?? "CAD");
        const ids = v ? [v.Id] : candidates.map((c) => c.Id);
        if (!ids.length) return `No vendor matched "${vendor}".`;
        clauses.push(`VendorRef in (${ids.map((i) => `'${i}'`).join(",")})`);
      }
      const sql = `select * from Bill${clauses.length ? " where " + clauses.join(" and ") : ""}`;
      const bills = await qboQueryAll(r, sql, "Bill", user.email, limit ?? 200);
      await audit({
        realm: r.id,
        kind: "read",
        operator: user.email,
        tool: "find_bills",
        detail: { sql, returned: bills.length },
      });
      const rows = bills.slice(0, limit ?? 100).map((b: any) => ({
        Id: b.Id,
        Date: b.TxnDate,
        Vendor: b.VendorRef?.name ?? b.VendorRef?.value,
        "Doc no.": b.DocNumber ?? "—",
        Ccy: b.CurrencyRef?.value ?? "—",
        Total: money(b.TotalAmt),
        Balance: money(b.Balance),
        Memo: (b.PrivateNote ?? "").slice(0, 40),
      }));
      return `${bills.length} bill(s).\n\n${table(rows)}${READ_ONLY_BANNER}`;
    },
  },

  {
    name: "reconcile_invoices",
    description:
      "The MX carrier payables reconciliation. Give it the carrier invoices you are holding and it matches each to a bill in QuickBooks on the correct vendor and currency, flags variances for MX Ops, and records the run. Produces proposals only — it never changes QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        since: { type: "string", description: "Only consider bills on or after this date (YYYY-MM-DD)" },
        invoices: {
          type: "array",
          description: "The carrier invoices being reconciled",
          items: {
            type: "object",
            properties: {
              carrier: { type: "string" },
              currency: { type: "string", enum: ["CAD", "USD"] },
              invoice_number: { type: "string" },
              amount: { type: "number" },
              load_number: { type: "string" },
              invoice_date: { type: "string" },
            },
            required: ["carrier", "currency", "invoice_number", "amount"],
          },
        },
      },
      required: ["file", "invoices"],
    },
    handler: async ({ file, invoices, since }, { user }) => {
      const r = await realmOf(file);
      const lines = invoices as InvoiceLine[];
      if (!lines?.length) return "No invoices supplied.";
      const rows = await reconcile(r, lines, since, user.email);
      const { counts } = await saveRun(r, "carrier_invoice", user.email, { since, count: lines.length }, rows);
      await audit({
        realm: r.id,
        kind: "read",
        operator: user.email,
        tool: "reconcile_invoices",
        detail: counts,
      });

      const disp = rows.map((m) => ({
        Carrier: m.carrier,
        Ccy: m.currency,
        Invoice: m.invoice_number,
        Load: m.load_number || "—",
        "Invoice amt": money(m.invoice_amount),
        "Bill amt": money(m.bill_amount),
        Var: m.variance === null ? "—" : money(m.variance),
        Status: m.status,
        Note: m.note,
      }));

      const acts = rows.filter((r2) => r2.proposed_action);
      return [
        `**${counts.matched} matched · ${counts.variances} variance(s) · ${counts.unmatched} unresolved**`,
        "",
        table(disp),
        "",
        acts.length
          ? `**${acts.length} bill(s) would have their document number set to the invoice number, with the load number moved to the memo.** These are recorded as proposals against this run. Nothing has been written to QuickBooks and nothing can be until the pilot is verified and the write path is authorised under the charter.`
          : "No proposals generated.",
        counts.variances
          ? `\n**${counts.variances} variance(s) raised as open exceptions** for MX Ops to approve or short pay. Use \`exceptions\` to see them.`
          : "",
      ].join("\n");
    },
  },

  {
    name: "breakdown_consolidation",
    description:
      "Break a weekly MX office consolidation (one invoice covering many loads, e.g. from XOCHITL) down to load level and match each load to a bill, then check the loads sum to the invoice total.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        carrier: { type: "string" },
        currency: { type: "string", enum: ["CAD", "USD"] },
        consolidation_number: { type: "string" },
        consolidation_total: { type: "number" },
        since: { type: "string" },
        loads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              load_number: { type: "string" },
              amount: { type: "number" },
            },
            required: ["load_number", "amount"],
          },
        },
      },
      required: ["file", "carrier", "currency", "consolidation_number", "consolidation_total", "loads"],
    },
    handler: async (
      { file, carrier, currency, consolidation_number, consolidation_total, loads, since },
      { user },
    ) => {
      const r = await realmOf(file);
      const lines: InvoiceLine[] = loads.map((l: any) => ({
        carrier,
        currency,
        invoice_number: consolidation_number,
        amount: l.amount,
        load_number: l.load_number,
      }));
      const rows = await reconcile(r, lines, since, user.email);
      const { counts } = await saveRun(
        r,
        "xochitl_consolidation",
        user.email,
        { consolidation_number, consolidation_total, loads: loads.length },
        rows,
      );
      const sum = Number(loads.reduce((a: number, l: any) => a + (l.amount ?? 0), 0).toFixed(2));
      const diff = Number((sum - consolidation_total).toFixed(2));
      await audit({
        realm: r.id,
        kind: "read",
        operator: user.email,
        tool: "breakdown_consolidation",
        detail: { consolidation_number, diff, ...counts },
      });
      const disp = rows.map((m) => ({
        Load: m.load_number,
        Amount: money(m.invoice_amount, currency),
        "Bill id": m.bill_id ?? "—",
        "Bill amt": money(m.bill_amount),
        Var: m.variance === null ? "—" : money(m.variance),
        Status: m.status,
      }));
      return [
        `**Consolidation ${consolidation_number}** — ${loads.length} load(s), ${currency}`,
        `- Loads total: ${money(sum, currency)}`,
        `- Invoice total: ${money(consolidation_total, currency)}`,
        Math.abs(diff) <= 0.01
          ? "- **Loads reconcile to the invoice total.**"
          : `- **Out by ${money(diff, currency)}** — the breakdown does not agree with the invoice. Resolve before any payment is prepared.`,
        "",
        table(disp),
        "",
        `${counts.matched} matched · ${counts.variances} variance(s) · ${counts.unmatched} unresolved`,
      ].join("\n");
    },
  },

  {
    name: "exceptions",
    description:
      "List open reconciliation exceptions awaiting an MX Ops decision (approve the amount, or state the reason for a short pay).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        status: { type: "string", enum: ["open", "approved", "short_pay", "resolved", "withdrawn"] },
      },
      required: ["file"],
    },
    handler: async ({ file, status }, { user }) => {
      const r = await getRealm(file);
      const q = `realm=eq.${r.id}&status=eq.${status ?? "open"}&select=*&order=raised_at.desc&limit=200`;
      const rows = (await db.select("exception_item", q)) ?? [];
      await audit({ realm: r.id, kind: "read", operator: user.email, tool: "exceptions" });
      if (!rows.length) return `No ${status ?? "open"} exceptions on ${r.label}.`;
      const disp = rows.map((e: any) => ({
        Ref: e.id.slice(0, 8),
        Raised: e.raised_at?.slice(0, 10),
        Carrier: e.vendor_name,
        Ccy: e.currency,
        Invoice: e.reference,
        Billed: money(e.amount_billed),
        Expected: money(e.amount_expected),
        Kind: e.kind,
        Status: e.status,
      }));
      return `${rows.length} exception(s).\n\n${table(disp)}`;
    },
  },

  {
    name: "record_decision",
    description:
      "Record the MX Ops decision on an exception — approve the invoice amount, or short pay with a stated reason. Records the decision in Proactive's own log; it does not touch QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        exception_ref: { type: "string", description: "The Ref shown by the exceptions tool" },
        decision: { type: "string", enum: ["approved", "short_pay", "withdrawn"] },
        reason: { type: "string" },
      },
      required: ["exception_ref", "decision"],
    },
    handler: async ({ exception_ref, decision, reason }, { user }) => {
      if (decision === "short_pay" && !reason)
        return "A short pay needs a stated reason. Nothing recorded.";
      const rows = await db.select(
        "exception_item",
        `id=like.${exception_ref}*&select=id,realm,vendor_name,reference,status`,
      );
      if (!rows?.length) return `No exception found matching "${exception_ref}".`;
      if (rows.length > 1) return `"${exception_ref}" matches ${rows.length} exceptions. Use more characters.`;
      const ex = rows[0];
      await db.update("exception_item", `id=eq.${ex.id}`, {
        status: decision,
        decision: reason ?? null,
        decided_by: user.email,
        decided_at: new Date().toISOString(),
      });
      await audit({
        realm: ex.realm,
        kind: "write",
        operator: user.email,
        tool: "record_decision",
        entity: "exception_item",
        entity_id: ex.id,
        detail: { decision, reason, note: "Proactive record only — QuickBooks unchanged" },
      });
      return `Recorded: ${ex.vendor_name} / ${ex.reference} → **${decision}**${
        reason ? ` (${reason})` : ""
      }, by ${user.full_name}.`;
    },
  },

  {
    name: "set_invoice_number",
    description:
      "Put a carrier's invoice number onto a matched bill in QuickBooks, keeping the load number in the memo. One of the two tools that change QuickBooks. It changes two fields on one bill at a time and nothing else: it cannot create, delete or void a bill, change an amount, change a vendor, or move money. Defaults to a dry run — you must pass apply: true to actually write. Always show the user the before and after and get their agreement first.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Company file label, e.g. PMX" },
        bill_id: { type: "string", description: "The QuickBooks bill Id from the reconciliation" },
        invoice_number: { type: "string", description: "The carrier's invoice number" },
        load_number: { type: "string", description: "The load number, kept in the memo" },
        expected_amount: {
          type: "number",
          description:
            "The bill amount as matched. If the bill no longer matches this, the write is refused.",
        },
        apply: {
          type: "boolean",
          description:
            "false or omitted = dry run, shows what would change. true = write it to QuickBooks.",
        },
      },
      required: ["file", "bill_id", "invoice_number"],
    },
    handler: async (a, { user }) => {
      const r = await realmOf(a.file);
      const wantsApply = a.apply === true;

      if (wantsApply && !hasScope(r, "set_invoice_number")) {
        return `**Not written.** ${scopeError(r, "set_invoice_number")}`;
      }

      const res = await setInvoiceNumber(
        r,
        {
          bill_id: String(a.bill_id),
          invoice_number: String(a.invoice_number),
          load_number: a.load_number ? String(a.load_number) : undefined,
          expected_amount: typeof a.expected_amount === "number" ? a.expected_amount : undefined,
          dry_run: !wantsApply,
        },
        user.email,
      );

      const rows = [
        {
          Field: "Document number",
          Before: res.before.DocNumber ?? "—",
          After: res.after.DocNumber ?? "—",
        },
        {
          Field: "Memo",
          Before: res.before.PrivateNote ?? "—",
          After: res.after.PrivateNote ?? "—",
        },
      ];

      const head = `**Bill ${res.bill_id}** — ${res.vendor ?? "?"} · ${money(res.amount, res.currency ?? "")}`;

      if (res.applied) {
        await audit({
          realm: r.id,
          kind: "write",
          operator: user.email,
          tool: "set_invoice_number",
          entity_id: res.bill_id,
          outcome: "applied",
        });
        return [head, "", table(rows), "", `**Written to QuickBooks.** ${res.note}`].join("\n");
      }

      if (res.note.startsWith("Refused")) {
        return [head, "", table(rows), "", `**Not written.** ${res.note}`].join("\n");
      }

      return [
        head,
        "",
        table(rows),
        "",
        "**Nothing has been written yet.** This is what the change would be. If that is correct, say so and I will apply it.",
      ].join("\n");
    },
  },


  /* ------------------------------------------------- PSC accounts payable */

  {
    name: "list_accounts",
    description:
      "Chart of accounts a vendor bill can post to on a company file: active expense, cost of goods sold, other expense and asset accounts, with number, full name (parent:child) and type. Header/parent-only, bank, AR, AP, equity, income and inactive accounts are excluded. Use it to validate a GL the user types in, and to build the four options for the GL question.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        search: { type: "string", description: "Optional filter on number or name, e.g. 'Gibraltar' or 'Utilities'" },
      },
      required: ["file"],
    },
    handler: async ({ file, search }, { user }) => {
      const r = await realmOf(file);
      const all = postableAccounts(await loadAccounts(r, user.email));
      const q = String(search ?? "").toLowerCase();
      const rows = (q ? all.filter((a) => `${a.AcctNum ?? ""} ${a.FullyQualifiedName}`.toLowerCase().includes(q)) : all)
        .sort((a, b) => a.FullyQualifiedName.localeCompare(b.FullyQualifiedName))
        .slice(0, 300)
        .map((a) => ({
          Id: a.Id,
          "No.": a.AcctNum ?? "",
          Account: a.FullyQualifiedName,
          Type: a.AccountType,
        }));
      await audit({ realm: r.id, kind: "read", operator: user.email, tool: "list_accounts", detail: { search, returned: rows.length } });
      return `${rows.length} postable account(s)${rows.length === 300 ? " (showing 300 — narrow the search)" : ""}.\n\n${table(rows)}${READ_ONLY_BANNER}`;
    },
  },

  {
    name: "list_tax_codes",
    description:
      "Active sales tax codes on a company file with their purchase-side rate (e.g. HST ON 13%, GST 5%, Zero-rated 0%, Exempt). Every bill line needs one on a Canadian file.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    handler: async ({ file }, { user }) => {
      const r = await realmOf(file);
      const codes = await loadTaxCodes(r, user.email);
      await audit({ realm: r.id, kind: "read", operator: user.email, tool: "list_tax_codes" });
      return `${codes.length} tax code(s).\n\n${table(
        codes.map((c) => ({ Id: c.id, Code: c.name, "Purchase rate %": c.purchase_rate_pct, Rates: c.rates.join(" + "), Description: c.description })),
      )}${READ_ONLY_BANNER}`;
    },
  },

  {
    name: "vendor_bill_history",
    description:
      "A vendor's recent bills with the GL account and tax code used on each line, plus a ranked list of accounts by how often this vendor has posted to them. This is the evidence for the recommended GL. Read only.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        vendor_id: { type: "string", description: "QuickBooks vendor Id (from list_vendors)" },
        limit: { type: "number", description: "Bills to show, default 10" },
      },
      required: ["file", "vendor_id"],
    },
    handler: async ({ file, vendor_id, limit }, { user }) => {
      const r = await realmOf(file);
      const h = await vendorBillHistory(r, String(vendor_id), Number(limit ?? 10), user.email);
      await audit({ realm: r.id, kind: "read", operator: user.email, tool: "vendor_bill_history", detail: { vendor_id, scanned: h.scanned } });
      if (!h.scanned) return `No bills found for vendor ${vendor_id} on ${r.label}. There is no posting history to recommend from — build the options from the invoice description and the chart of accounts.${READ_ONLY_BANNER}`;
      return [
        `**${h.scanned} bill(s) scanned for vendor ${vendor_id}.**`,
        "",
        "Accounts used, most frequent first:",
        table(h.accounts.map((a) => ({ "Account id": a.account_id, Account: a.name, Bills: a.count, "Last used": a.last, Total: money(a.total) }))),
        "",
        `Last ${h.bills.length} bill(s):`,
        table(h.bills.map((b) => ({ "Bill id": b.bill_id, Date: b.date, "Doc no.": b.doc_number, Total: money(b.total, b.currency), Accounts: b.accounts, Tax: b.tax_codes }))),
        READ_ONLY_BANNER,
      ].join("\n");
    },
  },

  {
    name: "create_bill",
    description:
      "Create ONE vendor bill in QuickBooks from an approved supplier invoice. Defaults to a dry run that runs every check (vendor exists and currency matches; every line has an active postable GL account and a tax code; lines + tax equal the invoice total to the cent; no bill with the same vendor + document number; no same-vendor same-amount bill within 7 days; exchange rate available if foreign currency) and returns the exact bill as it would be created. Pass apply: true only after the user has typed 'post to qbo'. Refused unless an administrator has granted the create_bill scope for the company file. Cannot edit, void, delete or pay anything.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: `Company file label, e.g. ${LABEL}` },
        vendor_id: { type: "string", description: "QuickBooks vendor Id (from list_vendors)" },
        doc_number: { type: "string", description: "The supplier's invoice number, exactly as printed" },
        txn_date: { type: "string", description: "Invoice date YYYY-MM-DD" },
        due_date: { type: "string", description: "YYYY-MM-DD; omit to let QuickBooks apply the vendor's terms" },
        currency: { type: "string", description: "Invoice currency, e.g. CAD or USD. Must match the vendor's currency." },
        exchange_rate: { type: "number", description: "Only for foreign-currency bills when QuickBooks has no rate for the date" },
        memo: { type: "string", description: "PO / job / site / reference from the invoice" },
        expected_total: { type: "number", description: "The invoice total including tax, as printed" },
        source_doc: { type: "string", description: "PDF filename and page, for the audit log" },
        override_possible_duplicate: {
          type: "boolean",
          description: "Only after the user has confirmed a flagged possible duplicate is a different invoice",
        },
        lines: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number", description: "Line amount before tax" },
              account: { type: "string", description: "GL account id, number, or exact full name as confirmed by the user" },
              tax_code: { type: "string", description: "Tax code id or name from list_tax_codes" },
            },
            required: ["description", "amount", "account", "tax_code"],
          },
        },
        apply: { type: "boolean", description: "false or omitted = dry run. true = create the bill in QuickBooks." },
      },
      required: ["file", "vendor_id", "doc_number", "txn_date", "lines", "expected_total"],
    },
    handler: async (a, { user }) => {
      const r = await realmOf(a.file);
      const wantsApply = a.apply === true;
      if (wantsApply && !hasScope(r, "create_bill")) {
        return `**Not created.** ${scopeError(r, "create_bill")}`;
      }
      const res = await createBill(
        r,
        {
          vendor_id: String(a.vendor_id),
          doc_number: String(a.doc_number),
          txn_date: String(a.txn_date),
          due_date: a.due_date ? String(a.due_date) : undefined,
          currency: a.currency ? String(a.currency) : undefined,
          exchange_rate: typeof a.exchange_rate === "number" ? a.exchange_rate : undefined,
          lines: a.lines,
          memo: a.memo ? String(a.memo) : undefined,
          expected_total: Number(a.expected_total),
          source_doc: a.source_doc ? String(a.source_doc) : undefined,
          override_possible_duplicate: a.override_possible_duplicate === true,
          dry_run: !wantsApply,
        },
        user.email,
      );
      const p = res.preview as any;
      const block = [
        `**${p.vendor ?? a.vendor_id}** — bill no. ${p.doc_number ?? a.doc_number} · ${p.bill_date ?? ""} · ${p.currency ?? ""}`,
        p.due_date ? `Due: ${p.due_date}` : "",
        p.memo ? `Memo: ${p.memo}` : "",
        p.exchange_rate ? `Exchange rate: ${p.exchange_rate}` : "",
        "",
        Array.isArray(p.lines) && p.lines.length
          ? table(p.lines.map((l: any) => ({ Line: l.line, Description: l.description, "GL account": l.account, Tax: l.tax_code, Amount: l.amount })))
          : "",
        "",
        p.subtotal ? `Subtotal ${p.subtotal} · Tax ${p.tax} · **Total ${p.computed_total}** (invoice says ${p.invoice_total})` : "",
      ]
        .filter((x) => x !== "")
        .join("\n");

      const label =
        res.status === "created"
          ? `**CREATED in QuickBooks — bill id ${res.bill_id}.** ${res.message}`
          : res.status === "created_with_drift"
            ? `**CREATED, BUT CHECK IT.** ${res.message}`
            : res.status === "ready"
              ? `**READY — not yet posted.** ${res.message}`
              : `**NOT POSTED.** ${res.message}`;
      return `${block}\n\n${label}`;
    },
  },

  {
    name: "posted_bills",
    description:
      "Bills created through this connector on a company file — who posted what, when, from which document. Read only; from Proactive's own log, not QuickBooks.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, since: { type: "string", description: "YYYY-MM-DD" }, limit: { type: "number" } },
      required: ["file"],
    },
    handler: async ({ file, since, limit }, { user }) => {
      const r = await getRealm(file);
      let q = `realm=eq.${r.id}&select=*&order=created_at.desc&limit=${Math.min(Number(limit ?? 100), 500)}`;
      if (since) q += `&created_at=gte.${since}`;
      const rows = (await db.select("posted_bill", q)) ?? [];
      await audit({ realm: r.id, kind: "read", operator: user.email, tool: "posted_bills" });
      if (!rows.length) return `No bills have been posted through the connector on ${r.label}${since ? ` since ${since}` : ""}.`;
      const total = rows.reduce((a: number, b: any) => a + Number(b.total ?? 0), 0);
      return `${rows.length} bill(s), ${money(total)}.\n\n${table(
        rows.map((b: any) => ({
          Posted: String(b.created_at).slice(0, 16).replace("T", " "),
          By: b.operator,
          Vendor: b.vendor_name,
          "Doc no.": b.doc_number,
          Date: b.txn_date,
          Total: money(b.total, b.currency),
          "QBO bill": b.qbo_bill_id ?? "—",
          Source: b.source_doc ?? "",
          Drift: b.drift ? "YES — check" : "",
        })),
      )}`;
    },
  },

  {
    name: "capture_baseline",
    description:
      "Record a week-1 baseline measurement for a workflow, so the saving can be measured later rather than asserted.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: { type: "string" },
        person: { type: "string" },
        measure: { type: "string", description: "e.g. minutes per invoice, invoices per week, backlog count" },
        value: { type: "number" },
        unit: { type: "string" },
        method: { type: "string", description: "How it was measured" },
        notes: { type: "string" },
      },
      required: ["workflow", "measure", "value", "unit"],
    },
    handler: async (a, { user }) => {
      await db.insert("baseline_measure", { ...a, captured_by: user.email });
      await audit({ kind: "write", operator: user.email, tool: "capture_baseline", detail: a });
      return `Baseline recorded: ${a.workflow} — ${a.measure} = ${a.value} ${a.unit}.`;
    },
  },

  {
    name: "audit_trail",
    description:
      "Show the connector's audit log — who ran what, against which company file, and when.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, limit: { type: "number" } },
    },
    handler: async ({ file, limit }, { user }) => {
      let q = `select=*&order=created_at.desc&limit=${Math.min(limit ?? 50, 200)}`;
      if (file) {
        const r = await getRealm(file);
        q += `&realm=eq.${r.id}`;
      }
      const rows = (await db.select("audit_event", q)) ?? [];
      const disp = rows.map((e: any) => ({
        When: e.created_at?.slice(0, 19).replace("T", " "),
        Who: e.operator ?? "—",
        Kind: e.kind,
        Tool: e.tool ?? "—",
        Outcome: e.outcome,
      }));
      return `Last ${rows.length} event(s), requested by ${user.full_name}.\n\n${table(disp)}`;
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
