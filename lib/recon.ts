/**
 * MX carrier payables reconciliation — matching logic.
 *
 * Phase 1 produces PROPOSALS. Nothing here calls QuickBooks with anything
 * other than GET, and no proposal is ever applied.
 */
import { Realm, qboQueryAll, db } from "./core";

/* --------------------------------------------------------------- helpers */

export const norm = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .replace(/\b(usd|cdn|cad|us|inc|ltd|llc|corp|co|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();

export function currencyOfVendorName(name: string): "USD" | "CAD" | null {
  const n = ` ${name.toLowerCase()} `;
  if (/\b(usd|us\$|usfunds|us)\b/.test(n)) return "USD";
  if (/\b(cdn|cad|can)\b/.test(n)) return "CAD";
  return null;
}

/* --------------------------------------------------------------- vendors */

export type QVendor = {
  Id: string;
  DisplayName: string;
  CurrencyRef?: { value: string };
  Active?: boolean;
};

export async function loadVendors(realm: Realm, operator?: string): Promise<QVendor[]> {
  return qboQueryAll(realm, "select * from Vendor", "Vendor", operator, 5000);
}

/** Group vendors that are the same carrier billing in two currencies. */
export function pairVendors(vendors: QVendor[]) {
  const byBase = new Map<string, QVendor[]>();
  for (const v of vendors) {
    const base = norm(v.DisplayName);
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push(v);
  }
  const pairs: {
    base: string;
    members: { id: string; name: string; currency: string }[];
    currencies: string[];
  }[] = [];
  for (const [base, members] of byBase) {
    const m = members.map((v) => ({
      id: v.Id,
      name: v.DisplayName,
      currency: v.CurrencyRef?.value ?? currencyOfVendorName(v.DisplayName) ?? "?",
    }));
    const currencies = [...new Set(m.map((x) => x.currency))];
    if (members.length > 1 || currencies.some((c) => c !== "?")) {
      pairs.push({ base, members: m, currencies });
    }
  }
  return pairs.sort((a, b) => b.members.length - a.members.length || a.base.localeCompare(b.base));
}

/** Resolve a carrier name + currency to a single QuickBooks vendor. */
export function resolveVendor(
  vendors: QVendor[],
  carrier: string,
  currency: string,
): { vendor?: QVendor; candidates: QVendor[]; reason?: string } {
  const target = norm(carrier);
  if (!target) return { candidates: [], reason: "empty carrier name" };
  let candidates = vendors.filter((v) => {
    const n = norm(v.DisplayName);
    return n === target || n.startsWith(target) || target.startsWith(n);
  });
  if (!candidates.length) {
    candidates = vendors.filter((v) => norm(v.DisplayName).includes(target));
  }
  if (!candidates.length) return { candidates: [], reason: "no vendor matched that carrier name" };

  const cur = (v: QVendor) => v.CurrencyRef?.value ?? currencyOfVendorName(v.DisplayName) ?? "?";
  const exact = candidates.filter((v) => cur(v) === currency);
  if (exact.length === 1) return { vendor: exact[0], candidates };
  if (exact.length > 1) return { candidates: exact, reason: "several vendors share that name and currency" };
  return {
    candidates,
    reason: `matched ${candidates.length} vendor record(s) but none in ${currency}`,
  };
}

/* ----------------------------------------------------------------- bills */

export type QBill = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
  CurrencyRef?: { value: string };
  VendorRef?: { value: string; name?: string };
  Line?: any[];
};

export async function loadBillsForVendor(
  realm: Realm,
  vendorId: string,
  since?: string,
  operator?: string,
): Promise<QBill[]> {
  const where = [`VendorRef = '${vendorId}'`];
  if (since) where.push(`TxnDate >= '${since}'`);
  return qboQueryAll(
    realm,
    `select * from Bill where ${where.join(" and ")}`,
    "Bill",
    operator,
    3000,
  );
}

const refsOf = (b: QBill) =>
  [b.DocNumber ?? "", b.PrivateNote ?? "", ...(b.Line ?? []).map((l: any) => l?.Description ?? "")]
    .join(" ")
    .toLowerCase();

/** A load number may sit in DocNumber, the memo, or a line description. */
export function billMatchesLoad(bill: QBill, load: string) {
  if (!load) return false;
  const l = load.toLowerCase().trim();
  return refsOf(bill).includes(l);
}

/* ------------------------------------------------------------ the matcher */

export type InvoiceLine = {
  carrier: string;
  currency: "CAD" | "USD";
  invoice_number: string;
  amount: number;
  load_number?: string;
  invoice_date?: string;
};

export type MatchRow = {
  carrier: string;
  currency: string;
  invoice_number: string;
  load_number: string;
  invoice_amount: number | null;
  bill_id: string | null;
  bill_doc_number: string | null;
  bill_amount: number | null;
  variance: number | null;
  status: string;
  note: string;
  proposed_action: Record<string, unknown> | null;
};

const TOLERANCE = 0.01;

export async function reconcile(
  realm: Realm,
  lines: InvoiceLine[],
  since: string | undefined,
  operator: string,
): Promise<MatchRow[]> {
  const vendors = await loadVendors(realm, operator);
  const billCache = new Map<string, QBill[]>();
  const out: MatchRow[] = [];

  for (const line of lines) {
    const base: MatchRow = {
      carrier: line.carrier,
      currency: line.currency,
      invoice_number: line.invoice_number,
      load_number: line.load_number ?? "",
      invoice_amount: line.amount ?? null,
      bill_id: null,
      bill_doc_number: null,
      bill_amount: null,
      variance: null,
      status: "missing_in_qbo",
      note: "",
      proposed_action: null,
    };

    const { vendor, candidates, reason } = resolveVendor(vendors, line.carrier, line.currency);
    if (!vendor) {
      out.push({
        ...base,
        status: candidates.length ? "currency_mismatch" : "missing_in_qbo",
        note:
          `${reason}.` +
          (candidates.length
            ? ` Candidates: ${candidates
                .map((c) => `${c.DisplayName} (${c.CurrencyRef?.value ?? "?"})`)
                .join(", ")}`
            : ""),
      });
      continue;
    }

    if (!billCache.has(vendor.Id)) {
      billCache.set(vendor.Id, await loadBillsForVendor(realm, vendor.Id, since, operator));
    }
    const bills = billCache.get(vendor.Id)!;

    // 1. bill already carries the invoice number
    let hit = bills.filter(
      (b) => (b.DocNumber ?? "").trim().toLowerCase() === line.invoice_number.trim().toLowerCase(),
    );
    let how = "matched on invoice number";

    // 2. otherwise the load number, which is what MX books against first
    if (!hit.length && line.load_number) {
      hit = bills.filter((b) => billMatchesLoad(b, line.load_number!));
      how = "matched on load number";
    }

    // 3. last resort: a unique amount in the window
    if (!hit.length) {
      hit = bills.filter((b) => Math.abs((b.TotalAmt ?? 0) - line.amount) <= TOLERANCE);
      how = "matched on amount only — weak, verify before acting";
    }

    if (!hit.length) {
      out.push({ ...base, note: `No bill found for ${vendor.DisplayName}.` });
      continue;
    }
    if (hit.length > 1) {
      out.push({
        ...base,
        status: "duplicate_docnumber",
        note: `${hit.length} bills matched (${hit
          .map((b) => `#${b.Id}/${b.DocNumber ?? "no doc no."}`)
          .join(", ")}). Needs a human decision.`,
      });
      continue;
    }

    const bill = hit[0];
    const billCcy = bill.CurrencyRef?.value ?? "?";
    const amt = bill.TotalAmt ?? 0;
    const variance = Number((amt - line.amount).toFixed(2));

    if (billCcy !== line.currency) {
      out.push({
        ...base,
        bill_id: bill.Id,
        bill_doc_number: bill.DocNumber ?? null,
        bill_amount: amt,
        variance,
        status: "currency_mismatch",
        note: `Bill is in ${billCcy}, invoice is in ${line.currency}. Wrong vendor record was used.`,
      });
      continue;
    }

    if (Math.abs(variance) > TOLERANCE) {
      out.push({
        ...base,
        bill_id: bill.Id,
        bill_doc_number: bill.DocNumber ?? null,
        bill_amount: amt,
        variance,
        status: "variance",
        note: `${how}. Amounts differ — route to MX Ops to approve or short pay.`,
      });
      continue;
    }

    out.push({
      ...base,
      bill_id: bill.Id,
      bill_doc_number: bill.DocNumber ?? null,
      bill_amount: amt,
      variance: 0,
      status: "matched",
      note: how,
      proposed_action: {
        // Phase 1: recorded, never executed.
        operation: "Bill full update",
        bill_id: bill.Id,
        set_DocNumber: line.invoice_number,
        set_PrivateNote: `Load ${line.load_number ?? "—"}${
          bill.PrivateNote ? ` · ${bill.PrivateNote}` : ""
        }`,
        requires: "SyncToken read immediately before write; full object resent",
        authorised: false,
      },
    });
  }

  return out;
}

/* --------------------------------------------------------- persistence */

export async function saveRun(
  realm: Realm,
  kind: string,
  operator: string,
  params: unknown,
  rows: MatchRow[],
) {
  const counts = {
    matched: rows.filter((r) => r.status === "matched").length,
    variances: rows.filter((r) => r.status === "variance").length,
    unmatched: rows.filter((r) => !["matched", "variance"].includes(r.status)).length,
  };
  const run = await db.insert("recon_run", {
    realm: realm.id,
    kind,
    operator,
    params,
    finished_at: new Date().toISOString(),
    bills_scanned: rows.length,
    matched: counts.matched,
    variances: counts.variances,
    unmatched: counts.unmatched,
    summary: counts,
  });
  const runId = Array.isArray(run) ? run[0]?.id : run?.id;
  if (runId && rows.length) {
    await db.insert(
      "recon_match",
      rows.map((r) => ({
        run: runId,
        bill_id: r.bill_id,
        doc_number: r.bill_doc_number,
        load_number: r.load_number || null,
        vendor_name: r.carrier,
        currency: r.currency,
        bill_amount: r.bill_amount,
        invoice_amount: r.invoice_amount,
        variance: r.variance,
        status: r.status,
        proposed_action: r.proposed_action,
        notes: r.note,
      })),
    );
    const exceptions = rows.filter((r) => r.status !== "matched");
    if (exceptions.length) {
      await db.insert(
        "exception_item",
        exceptions.map((r) => ({
          realm: realm.id,
          kind: r.status,
          vendor_name: r.carrier,
          currency: r.currency,
          reference: r.invoice_number,
          amount_billed: r.bill_amount,
          amount_expected: r.invoice_amount,
          status: "open",
        })),
      );
    }
  }
  return { runId, counts };
}
