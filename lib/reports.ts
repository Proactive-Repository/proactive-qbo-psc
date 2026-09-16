/**
 * Read-only financial reporting for one company file.
 *
 *  - runReport:        any QuickBooks report (P&L, balance sheet, cash flow, trial balance,
 *                      GL, agings, transaction lists), flattened to rows.
 *  - financialPackage: P&L, balance sheet and cash flow for a period in ONE normalised shape
 *                      (statement / section / account type / account / amount / currency), plus
 *                      company facts, so a Group Finance session can add six files together.
 *  - queryRecords:     a guarded QuickBooks query (SELECT only) for "show me the bills over
 *                      $10k for vendor X" style questions.
 *  - fxRate:           QuickBooks' own rate table for a currency on a date.
 *
 * Nothing here writes. Every call is audited under the signed-in person.
 */
import { Realm, qboGet, qboQuery, qboQueryAll } from "./core";

/* --------------------------------------------------------------- reports */

export const REPORTS = [
  "ProfitAndLoss",
  "ProfitAndLossDetail",
  "BalanceSheet",
  "CashFlow",
  "TrialBalance",
  "GeneralLedger",
  "AgedPayables",
  "AgedPayablesDetail",
  "AgedReceivables",
  "AgedReceivablesDetail",
  "TransactionList",
  "VendorExpenses",
  "CustomerIncome",
  "CustomerBalance",
  "VendorBalance",
  "AccountList",
  "TaxSummary",
] as const;
export type ReportName = (typeof REPORTS)[number];

export type ReportParams = {
  start_date?: string;
  end_date?: string;
  date_macro?: string;
  accounting_method?: "Accrual" | "Cash";
  summarize_column_by?: "Total" | "Month" | "Quarter" | "Year" | "Customers" | "Vendors" | "Classes" | "Departments";
  columns?: string;
  customer?: string;
  vendor?: string;
  item?: string;
  classid?: string;
  department?: string;
  account?: string;
  sort_by?: string;
  minorversion?: never;
  [k: string]: string | undefined;
};

export type FlatRow = { level: number; kind: "data" | "section" | "summary"; label: string; values: (number | string | null)[]; account_id?: string };

export async function runReport(realm: Realm, name: ReportName, params: ReportParams, operator: string) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const data = await qboGet(realm, `reports/${name}?${qs.toString()}`, operator);
  return { raw: data, ...flatten(data) };
}

function num(s: any): number | string | null {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : String(s);
}

/** Flatten QuickBooks' nested report JSON into rows with a level and a values array matching the column headers. */
export function flatten(rep: any): { header: Record<string, string>; columns: string[]; rows: FlatRow[]; currency: string | null } {
  const columns: string[] = (rep?.Columns?.Column ?? []).map((c: any) => c.ColTitle ?? c.ColType ?? "");
  const rows: FlatRow[] = [];
  const walk = (node: any, level: number) => {
    for (const r of node?.Row ?? []) {
      if (r.Header?.ColData) {
        const cd = r.Header.ColData;
        rows.push({ level, kind: "section", label: cd[0]?.value ?? "", values: cd.slice(1).map((c: any) => num(c.value)), account_id: cd[0]?.id });
      }
      if (r.ColData) {
        rows.push({ level, kind: "data", label: r.ColData[0]?.value ?? "", values: r.ColData.slice(1).map((c: any) => num(c.value)), account_id: r.ColData[0]?.id });
      }
      if (r.Rows) walk(r.Rows, level + 1);
      if (r.Summary?.ColData) {
        const cd = r.Summary.ColData;
        rows.push({ level, kind: "summary", label: cd[0]?.value ?? "", values: cd.slice(1).map((c: any) => num(c.value)) });
      }
    }
  };
  walk(rep?.Rows, 0);
  return { header: rep?.Header ?? {}, columns, rows, currency: rep?.Header?.Currency ?? null };
}

export function rowsToMarkdown(columns: string[], rows: FlatRow[], cap = 250): string {
  const head = `| ${columns.map((c) => c || " ").join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const fmt = (v: number | string | null) => (v === null ? "" : typeof v === "number" ? v.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v);
  const body = rows.slice(0, cap).map((r) => {
    const indent = "  ".repeat(Math.min(r.level, 6));
    const label = r.kind === "summary" ? `**${r.label}**` : r.kind === "section" ? `**${r.label}**` : r.label;
    return `| ${indent}${label} | ${r.values.map(fmt).join(" | ")} |`;
  });
  return [head, rule, ...body, rows.length > cap ? `| _… ${rows.length - cap} more rows_ | |` : ""].filter(Boolean).join("\n");
}

/* --------------------------------------------------------- company facts */

export async function companyInfo(realm: Realm, operator: string) {
  const ci = await qboQuery(realm, "select * from CompanyInfo", operator);
  const c = ci?.CompanyInfo?.[0] ?? {};
  const pref = await qboQuery(realm, "select * from Preferences", operator);
  const p = pref?.Preferences?.[0] ?? {};
  return {
    file: realm.label,
    legal_name: c.LegalName ?? c.CompanyName ?? null,
    country: c.Country ?? null,
    fiscal_year_start_month: c.FiscalYearStartMonth ?? null,
    home_currency: p?.CurrencyPrefs?.HomeCurrency?.value ?? null,
    multicurrency: Boolean(p?.CurrencyPrefs?.MultiCurrencyEnabled),
    accounting_method_default: p?.ReportPrefs?.ReportBasis ?? null,
    realm_id: realm.realm_id,
  };
}

/* ------------------------------------------------------------------ FX */

/** QuickBooks' own rate: how many home-currency units one unit of `currency` buys on `date`. */
export async function fxRate(realm: Realm, currency: string, date: string, operator: string): Promise<number | null> {
  try {
    const r = await qboGet(realm, `exchangerate?sourcecurrencycode=${encodeURIComponent(currency)}&asofdate=${date}`, operator);
    const rate = Number(r?.ExchangeRate?.Rate);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------- financial package */

export type PackageLine = {
  file: string;
  statement: "P&L" | "BalanceSheet" | "CashFlow";
  section: string; // top-level section, e.g. Income, Cost of Goods Sold, Expenses, Assets, Liabilities, Equity
  account: string;
  account_id: string | null;
  amount: number;
  currency: string;
  column?: string; // for month-by-month P&L
};

export async function financialPackage(
  realm: Realm,
  a: { start_date: string; end_date: string; accounting_method?: "Accrual" | "Cash"; by_month?: boolean },
  operator: string,
) {
  const method = a.accounting_method ?? "Accrual";
  const info = await companyInfo(realm, operator);
  const ccy = info.home_currency ?? "CAD";

  const pl = await runReport(realm, "ProfitAndLoss", { start_date: a.start_date, end_date: a.end_date, accounting_method: method, summarize_column_by: a.by_month ? "Month" : "Total" }, operator);
  const bs = await runReport(realm, "BalanceSheet", { start_date: a.start_date, end_date: a.end_date, accounting_method: method }, operator);
  const cf = await runReport(realm, "CashFlow", { start_date: a.start_date, end_date: a.end_date }, operator);

  const lines: PackageLine[] = [];
  const toLines = (statement: PackageLine["statement"], flat: { columns: string[]; rows: FlatRow[] }) => {
    const stack: string[] = [];
    for (const r of flat.rows) {
      if (r.kind === "section") {
        stack[r.level] = r.label;
        stack.length = r.level + 1;
        continue;
      }
      if (r.kind === "summary") continue;
      const section = stack[0] ?? r.label;
      const cols = flat.columns.slice(1); // first column is the label column
      r.values.forEach((v, i) => {
        if (typeof v !== "number") return;
        const colName = cols[i] ?? "";
        if (/^total$/i.test(colName) && cols.length > 1) return; // skip the Total column when monthly columns exist
        lines.push({ file: realm.label, statement, section, account: r.label, account_id: r.account_id ?? null, amount: v, currency: ccy, column: cols.length > 1 ? colName : undefined });
      });
    }
  };
  toLines("P&L", pl);
  toLines("BalanceSheet", bs);
  toLines("CashFlow", cf);

  const summaryOf = (flat: { rows: FlatRow[] }, label: RegExp) => {
    const r = [...flat.rows].reverse().find((x) => x.kind === "summary" && label.test(x.label));
    const v = r?.values.filter((x) => typeof x === "number") as number[] | undefined;
    return v?.length ? v[v.length - 1] : null;
  };
  const totals = {
    total_income: summaryOf(pl, /^total income$/i),
    total_cogs: summaryOf(pl, /^total cost of (goods sold|sales)$/i),
    gross_profit: summaryOf(pl, /^gross profit$/i),
    total_expenses: summaryOf(pl, /^total expenses$/i),
    net_income: summaryOf(pl, /^net income$/i),
    total_assets: summaryOf(bs, /^total assets$/i),
    total_liabilities: summaryOf(bs, /^total liabilities$/i),
    total_equity: summaryOf(bs, /^total equity$/i),
    net_cash_change: summaryOf(cf, /^net cash increase for period$/i),
  };

  // Candidate intercompany / related-party accounts — flagged, never eliminated automatically.
  const ic = /(inter[- ]?co|intercompany|due (to|from)|shared exp|suspense|related part|loan (to|from) (proactive|shareholder)|proactive (supply|specialized|group|logistics|mexico|quebec|usa)|PMX|PSC|PSL|PGU|PLX|PMQ|SUQ)/i;
  const intercompany_candidates = [...new Set(lines.filter((l) => ic.test(l.account) && l.account !== realm.label).map((l) => `${l.statement}: ${l.section} › ${l.account}`))];

  return { company: info, period: { start: a.start_date, end: a.end_date, basis: method }, totals, lines, intercompany_candidates, reports: { pl, bs, cf } };
}

/* -------------------------------------------------------- guarded query */

export const QUERYABLE = [
  "Account", "Bill", "BillPayment", "Class", "CreditMemo", "Customer", "Department", "Deposit", "Estimate", "Invoice",
  "Item", "JournalEntry", "Payment", "Purchase", "PurchaseOrder", "RefundReceipt", "SalesReceipt", "Term", "Transfer",
  "Vendor", "VendorCredit", "TaxCode", "TaxRate", "Employee", "TimeActivity", "Budget", "CompanyCurrency", "ExchangeRate",
] as const;

/** Only letters, digits, spaces, quotes, dots, commas, hyphens, colons, parentheses and comparison operators are allowed in a WHERE clause. */
export function safeWhere(where: string): string {
  const w = (where ?? "").trim();
  if (!w) return "";
  if (w.length > 500) throw new Error("where clause too long");
  if (!/^[\w\s'".,:()<>=!%\-\/]+$/.test(w)) throw new Error("where clause contains characters that are not allowed");
  if (/\b(delete|update|insert|drop|create|alter)\b/i.test(w)) throw new Error("only SELECT queries are permitted");
  return w;
}

export async function queryRecords(realm: Realm, entity: string, where: string, limit: number, operator: string) {
  if (!(QUERYABLE as readonly string[]).includes(entity)) throw new Error(`entity must be one of: ${QUERYABLE.join(", ")}`);
  const w = safeWhere(where);
  const sql = `select * from ${entity}${w ? " where " + w : ""}`;
  const rows = await qboQueryAll(realm, sql, entity, operator, Math.min(Math.max(limit, 1), 1000));
  return { sql, rows };
}

/** Compact, human-readable projection of common entities for chat tables. */
export function projectRecord(entity: string, r: any): Record<string, unknown> {
  const money = (n: any) => (typeof n === "number" ? n : n ? Number(n) : null);
  switch (entity) {
    case "Bill":
    case "Invoice":
    case "CreditMemo":
    case "VendorCredit":
    case "Estimate":
    case "SalesReceipt":
    case "RefundReceipt":
    case "PurchaseOrder":
      return { Id: r.Id, Date: r.TxnDate, "Doc no.": r.DocNumber ?? "", Party: r.VendorRef?.name ?? r.CustomerRef?.name ?? "", Ccy: r.CurrencyRef?.value ?? "", Total: money(r.TotalAmt), Balance: money(r.Balance), Due: r.DueDate ?? "", Memo: (r.PrivateNote ?? "").slice(0, 40) };
    case "Payment":
    case "BillPayment":
      return { Id: r.Id, Date: r.TxnDate, Party: r.CustomerRef?.name ?? r.VendorRef?.name ?? "", Ccy: r.CurrencyRef?.value ?? "", Total: money(r.TotalAmt), Ref: r.PaymentRefNum ?? r.DocNumber ?? "", Applied: (r.Line ?? []).length };
    case "JournalEntry":
      return { Id: r.Id, Date: r.TxnDate, "Doc no.": r.DocNumber ?? "", Lines: (r.Line ?? []).length, Total: money(r.TotalAmt), Memo: (r.PrivateNote ?? "").slice(0, 60) };
    case "Deposit":
    case "Purchase":
    case "Transfer":
      return { Id: r.Id, Date: r.TxnDate, Account: r.DepositToAccountRef?.name ?? r.AccountRef?.name ?? r.FromAccountRef?.name ?? "", Total: money(r.TotalAmt ?? r.Amount), Memo: (r.PrivateNote ?? "").slice(0, 60) };
    case "Customer":
    case "Vendor":
      return { Id: r.Id, Name: r.DisplayName, Ccy: r.CurrencyRef?.value ?? "", Balance: money(r.Balance), Active: r.Active === false ? "no" : "yes", Email: r.PrimaryEmailAddr?.Address ?? "" };
    case "Account":
      return { Id: r.Id, "No.": r.AcctNum ?? "", Account: r.FullyQualifiedName, Type: r.AccountType, Balance: money(r.CurrentBalance), Active: r.Active === false ? "no" : "yes" };
    default: {
      const out: Record<string, unknown> = { Id: r.Id };
      for (const k of ["Name", "DisplayName", "TxnDate", "DocNumber", "TotalAmt", "Amount", "Active"]) if (r[k] !== undefined) out[k] = r[k];
      return out;
    }
  }
}
