/**
 * PSC accounts payable: create a vendor bill from an approved supplier invoice.
 *
 * This is the second write path under charter QBO-02 and the reason the PSC
 * connector is a separate Intuit app from PMX. It creates ONE bill per call,
 * from fields a person has read off the invoice and confirmed in chat, with a
 * GL account per line that the person chose.
 *
 * The failure mode here is different from set_invoice_number. A wrong memo is
 * cosmetic; a duplicate bill is a double payment and a mis-coded bill is a
 * wrong P&L. So before anything is sent:
 *
 *   - the vendor must exist and its currency must match the invoice;
 *   - every line must name an active, postable account (expense / COGS /
 *     other expense / asset), never a header, bank, AR, AP, equity or income;
 *   - a bill for the same vendor with the same document number is refused;
 *   - a bill for the same vendor, same total, within 7 days is flagged as a
 *     possible duplicate and refused unless the caller explicitly overrides;
 *   - lines + tax must equal the invoice total the person stated, computed
 *     from the tax code's purchase rate, to the cent;
 *   - a foreign-currency bill needs an exchange rate — read from QuickBooks
 *     for the bill date, or supplied by the caller;
 *   - the tool defaults to a dry run and requires apply: true.
 *
 * After the create, the bill QuickBooks returns is compared to what was sent —
 * vendor, doc number, total, line count, account per line. Any difference is
 * logged as unexpected_drift and reported loudly, because at that point the
 * bill exists and a person must look at it.
 *
 * Nothing here can void, delete or pay a bill, or touch an existing one.
 */
import { Realm, audit, db, getPreferences, money, qboGet, qboPost, qboQuery, qboQueryAll } from "./core";

/* ------------------------------------------------------------- accounts */

export type QAccount = {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AcctNum?: string;
  AccountType: string;
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
  SubAccount?: boolean;
  ParentRef?: { value: string };
  CurrencyRef?: { value: string };
};

/** Account types a vendor bill line may post to. */
const POSTABLE_TYPES = new Set([
  "Expense",
  "Cost of Goods Sold",
  "Other Expense",
  "Fixed Asset",
  "Other Current Asset",
  "Other Asset",
]);

let accountCache: { realm: string; at: number; rows: QAccount[] } | null = null;

export async function loadAccounts(realm: Realm, operator?: string): Promise<QAccount[]> {
  if (accountCache && accountCache.realm === realm.id && Date.now() - accountCache.at < 15 * 60_000)
    return accountCache.rows;
  const rows = await qboQueryAll(realm, "select * from Account", "Account", operator, 3000);
  accountCache = { realm: realm.id, at: Date.now(), rows };
  return rows;
}

export function postableAccounts(all: QAccount[]) {
  const parents = new Set(all.filter((a) => a.ParentRef?.value).map((a) => a.ParentRef!.value));
  return all.filter(
    (a) => a.Active !== false && POSTABLE_TYPES.has(a.AccountType) && !parents.has(a.Id),
  );
}

/** Resolve an account by id, number, or exact/unique full name. */
export function resolveAccount(
  all: QAccount[],
  ref: string,
): { account?: QAccount; candidates: QAccount[] } {
  const r = ref.trim();
  const postable = postableAccounts(all);
  let hit = postable.find((a) => a.Id === r);
  if (hit) return { account: hit, candidates: [hit] };
  hit = postable.find((a) => a.AcctNum && a.AcctNum === r);
  if (hit) return { account: hit, candidates: [hit] };
  const lower = r.toLowerCase();
  const exact = postable.filter(
    (a) => a.FullyQualifiedName.toLowerCase() === lower || a.Name.toLowerCase() === lower,
  );
  if (exact.length === 1) return { account: exact[0], candidates: exact };
  if (exact.length > 1) return { candidates: exact };
  const partial = postable.filter((a) => a.FullyQualifiedName.toLowerCase().includes(lower));
  return { account: partial.length === 1 ? partial[0] : undefined, candidates: partial.slice(0, 10) };
}

/* -------------------------------------------------------------- tax codes */

export type QTaxCode = {
  Id: string;
  Name: string;
  Description?: string;
  Active?: boolean;
  Taxable?: boolean;
  PurchaseTaxRateList?: { TaxRateDetail?: { TaxRateRef: { value: string; name?: string } }[] };
};
export type QTaxRate = { Id: string; Name: string; RateValue?: number; Active?: boolean };

export async function loadTaxCodes(realm: Realm, operator?: string) {
  const codes: QTaxCode[] = await qboQueryAll(realm, "select * from TaxCode", "TaxCode", operator, 500);
  const rates: QTaxRate[] = await qboQueryAll(realm, "select * from TaxRate", "TaxRate", operator, 500);
  const rateById = new Map(rates.map((r) => [r.Id, r]));
  return codes
    .filter((c) => c.Active !== false)
    .map((c) => {
      const details = c.PurchaseTaxRateList?.TaxRateDetail ?? [];
      const pct = details.reduce((a, d) => a + (rateById.get(d.TaxRateRef.value)?.RateValue ?? 0), 0);
      return {
        id: c.Id,
        name: c.Name,
        description: c.Description ?? "",
        purchase_rate_pct: Number(pct.toFixed(4)),
        rates: details.map((d) => rateById.get(d.TaxRateRef.value)?.Name ?? d.TaxRateRef.value),
      };
    });
}

/* -------------------------------------------------------- vendor history */

export async function vendorBillHistory(realm: Realm, vendorId: string, limit: number, operator: string) {
  const bills: any[] = await qboQueryAll(
    realm,
    `select * from Bill where VendorRef = '${vendorId.replace(/'/g, "")}' orderby TxnDate desc`,
    "Bill",
    operator,
    Math.min(limit, 200),
  );
  const freq = new Map<string, { name: string; count: number; last: string; total: number }>();
  const rows = bills.slice(0, limit).map((b) => {
    const accts = (b.Line ?? [])
      .filter((l: any) => l.DetailType === "AccountBasedExpenseLineDetail")
      .map((l: any) => {
        const ref = l.AccountBasedExpenseLineDetail?.AccountRef ?? {};
        const f = freq.get(ref.value) ?? { name: ref.name ?? ref.value, count: 0, last: "", total: 0 };
        f.count += 1;
        f.total += Number(l.Amount ?? 0);
        if (!f.last || b.TxnDate > f.last) f.last = b.TxnDate;
        freq.set(ref.value, f);
        return `${ref.name ?? ref.value}`;
      });
    return {
      bill_id: b.Id,
      date: b.TxnDate,
      doc_number: b.DocNumber ?? "",
      total: b.TotalAmt,
      currency: b.CurrencyRef?.value ?? "",
      accounts: [...new Set(accts)].join(" · "),
      tax_codes: [
        ...new Set(
          (b.Line ?? [])
            .map((l: any) => l.AccountBasedExpenseLineDetail?.TaxCodeRef?.value)
            .filter(Boolean),
        ),
      ].join(","),
    };
  });
  const ranked = [...freq.entries()]
    .map(([id, f]) => ({ account_id: id, ...f }))
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  return { bills: rows, accounts: ranked, scanned: bills.length };
}

/* ------------------------------------------------------------ create bill */

export type BillLineIn = {
  description: string;
  amount: number;
  account: string; // id, number, or full name
  tax_code?: string; // TaxCode id or name — REQUIRED on Canadian/UK/AU files, ignored on US files
};

export type CreateBillArgs = {
  vendor_id: string;
  doc_number: string;
  txn_date: string; // YYYY-MM-DD
  due_date?: string;
  currency?: string;
  exchange_rate?: number;
  lines: BillLineIn[];
  memo?: string;
  expected_total: number;
  source_doc?: string;
  override_possible_duplicate?: boolean;
  dry_run: boolean;
};

export type CreateBillResult = {
  status: "ready" | "refused" | "possible_duplicate" | "created" | "created_with_drift";
  message: string;
  preview: Record<string, unknown>;
  duplicates?: any[];
  bill_id?: string;
  qbo_total?: number;
  drift?: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function createBill(
  realm: Realm,
  a: CreateBillArgs,
  operator: string,
): Promise<CreateBillResult> {
  /* --- inputs --- */
  if (!Array.isArray(a.lines) || !a.lines.length) return refused(a, "At least one line is required.");
  if (!Number.isFinite(a.expected_total) || a.expected_total <= 0)
    return refused(a, "expected_total (the invoice total as printed) is required and must be positive.");
  const validDate = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x) && !isNaN(new Date(x + "T00:00:00Z").getTime());
  if (!validDate(a.txn_date)) return refused(a, "txn_date must be a valid date, YYYY-MM-DD.");
  if (a.due_date && !validDate(a.due_date)) return refused(a, "due_date must be a valid date, YYYY-MM-DD.");
  const docRaw = String(a.doc_number ?? "").trim();
  if (!docRaw) return refused(a, "A document (invoice) number is required.");
  if (docRaw.length > 21)
    return refused(a, `Document number "${docRaw}" is ${docRaw.length} characters; QuickBooks allows 21. Ask the user how to shorten it.`);
  const doc = docRaw.replace(/'/g, "");

  /* --- vendor --- */
  const vq = await qboQuery(realm, `select * from Vendor where Id = '${a.vendor_id.replace(/'/g, "")}'`, operator);
  const vendor = vq?.Vendor?.[0];
  if (!vendor) return refused(a, `Vendor id ${a.vendor_id} does not exist on ${realm.label}.`);
  if (vendor.Active === false) return refused(a, `Vendor "${vendor.DisplayName}" is inactive.`);
  const vendorCcy: string | undefined = vendor.CurrencyRef?.value;
  const currency = (a.currency ?? vendorCcy ?? realm.home_currency ?? "CAD").toUpperCase();
  if (vendorCcy && vendorCcy !== currency)
    return refused(
      a,
      `Vendor "${vendor.DisplayName}" is a ${vendorCcy} vendor but the invoice is ${currency}. A QuickBooks vendor's currency is fixed; use the ${currency} vendor record or say the invoice currency is ${vendorCcy}.`,
    );

  /* --- tax model: US files have no per-line tax code; the invoice's sales tax is part of the line amount --- */
  let usTaxModel = false;
  let home = realm.home_currency ?? "";
  try {
    const prefs = await getPreferences(realm, operator);
    if (prefs.home_currency) home = prefs.home_currency;
    usTaxModel = (prefs as any).country === "US" || realm.country === "US";
  } catch {
    usTaxModel = realm.country === "US";
  }
  if (!home) return refused(a, "Could not determine the company file's home currency.");

  /* --- accounts + tax --- */
  const accounts = await loadAccounts(realm, operator);
  const taxCodes = usTaxModel ? [] : await loadTaxCodes(realm, operator);
  const lineOut: any[] = [];
  const problems: string[] = [];
  let subtotal = 0;
  let tax = 0;
  const preview_lines: any[] = [];

  for (const [i, l] of a.lines.entries()) {
    if (!(Number(l.amount) > 0)) problems.push(`Line ${i + 1}: amount must be positive.`);
    const { account, candidates } = resolveAccount(accounts, String(l.account ?? ""));
    if (!account) {
      problems.push(
        `Line ${i + 1}: account "${l.account}" ${
          candidates.length
            ? `is ambiguous — candidates: ${candidates.map((c) => `${c.AcctNum ? c.AcctNum + " " : ""}${c.FullyQualifiedName}`).join("; ")}`
            : "is not an active, postable account on this file"
        }.`,
      );
    }
    const tcRef = String(l.tax_code ?? "").trim().toLowerCase();
    const tc = usTaxModel ? null : taxCodes.find((t) => t.id === tcRef || t.name.toLowerCase() === tcRef);
    if (!usTaxModel && !tc) problems.push(`Line ${i + 1}: tax code "${l.tax_code}" not found. Use list_tax_codes.`);
    if (account && (usTaxModel || tc)) {
      const amt = round2(Number(l.amount));
      subtotal += amt;
      if (tc) tax += amt * (tc.purchase_rate_pct / 100);
      const detail: Record<string, unknown> = { AccountRef: { value: account.Id, name: account.FullyQualifiedName } };
      if (tc) detail.TaxCodeRef = { value: tc.id };
      lineOut.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: amt,
        Description: String(l.description ?? "").slice(0, 4000),
        AccountBasedExpenseLineDetail: detail,
      });
      preview_lines.push({
        line: i + 1,
        description: l.description,
        account: `${account.AcctNum ? account.AcctNum + " " : ""}${account.FullyQualifiedName}`,
        tax_code: tc ? `${tc.name} (${tc.purchase_rate_pct}%)` : "n/a (US file — tax included in line amounts)",
        amount: money(amt),
      });
    }
  }
  subtotal = round2(subtotal);
  tax = round2(tax);
  const computedTotal = round2(subtotal + tax);

  const preview: Record<string, unknown> = {
    file: realm.label,
    vendor: `${vendor.DisplayName} (${vendorCcy ?? "?"}) id ${vendor.Id}`,
    doc_number: a.doc_number,
    bill_date: a.txn_date,
    due_date: a.due_date ?? "(from vendor terms)",
    currency,
    memo: a.memo ?? "",
    lines: preview_lines,
    subtotal: money(subtotal),
    tax: money(tax),
    computed_total: money(computedTotal),
    invoice_total: money(a.expected_total),
    source_doc: a.source_doc ?? "",
  };

  if (problems.length) return { status: "refused", message: problems.join("\n"), preview };

  if (Math.abs(computedTotal - round2(a.expected_total)) > 0.02)
    return {
      status: "refused",
      message: `Lines plus tax come to ${money(computedTotal)} but the invoice total is ${money(a.expected_total)} (difference ${money(round2(computedTotal - a.expected_total))}). Check the line amounts and tax codes against the invoice. Nothing was written.`,
      preview,
    };

  /* --- duplicate guards --- */
  const exact = await qboQuery(
    realm,
    `select * from Bill where VendorRef = '${vendor.Id}' and DocNumber = '${doc}'`,
    operator,
  );
  const exactBills: any[] = exact?.Bill ?? [];
  const alsoPosted = (await db.select(
    "posted_bill",
    `realm=eq.${realm.id}&vendor_id=eq.${encodeURIComponent(vendor.Id)}&doc_number=eq.${encodeURIComponent(doc)}&select=qbo_bill_id,created_at,operator`,
  )) ?? [];
  if (exactBills.length || alsoPosted.length) {
    return {
      status: "refused",
      message: `DUPLICATE. ${vendor.DisplayName} already has bill no. "${doc}" in QuickBooks${
        exactBills.length
          ? `: ${exactBills.map((b) => `id ${b.Id}, ${b.TxnDate}, ${money(b.TotalAmt)}, balance ${money(b.Balance)}`).join("; ")}`
          : ` (posted through this connector: ${alsoPosted.map((p: any) => `bill ${p.qbo_bill_id} by ${p.operator} on ${String(p.created_at).slice(0, 10)}`).join("; ")})`
      }. Not posted.`,
      preview,
      duplicates: exactBills,
    };
  }
  const d = new Date(a.txn_date + "T00:00:00Z");
  const lo = new Date(d.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const hi = new Date(d.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const near = await qboQuery(
    realm,
    `select * from Bill where VendorRef = '${vendor.Id}' and TxnDate >= '${lo}' and TxnDate <= '${hi}'`,
    operator,
  );
  const nearBills: any[] = (near?.Bill ?? []).filter(
    (b: any) => Math.abs(Number(b.TotalAmt) - round2(a.expected_total)) <= 0.01,
  );
  if (nearBills.length && !a.override_possible_duplicate) {
    return {
      status: "possible_duplicate",
      message: `POSSIBLE DUPLICATE. ${vendor.DisplayName} has ${nearBills.length} bill(s) for ${money(a.expected_total)} within 7 days of ${a.txn_date} under a different number: ${nearBills
        .map((b) => `id ${b.Id}, no. ${b.DocNumber ?? "—"}, ${b.TxnDate}`)
        .join("; ")}. Confirm with the user that this is a different invoice; if so, re-run with override_possible_duplicate: true. Not posted.`,
      preview,
      duplicates: nearBills,
    };
  }

  /* --- exchange rate --- */
  let exchangeRate: number | undefined;
  if (currency !== home) {
    exchangeRate = a.exchange_rate;
    if (!exchangeRate) {
      try {
        const er = await qboGet(
          realm,
          `exchangerate?sourcecurrencycode=${currency}&asofdate=${a.txn_date}`,
          operator,
        );
        exchangeRate = Number(er?.ExchangeRate?.Rate);
      } catch {
        /* handled below */
      }
    }
    if (!exchangeRate || !(exchangeRate > 0))
      return {
        status: "refused",
        message: `This is a ${currency} bill on a ${home} company file and QuickBooks requires an exchange rate. None could be read for ${a.txn_date}; pass exchange_rate explicitly.`,
        preview,
      };
    preview.exchange_rate = exchangeRate;
  }

  if (a.dry_run) {
    return {
      status: "ready",
      message: "Dry run. Nothing was written to QuickBooks. All checks passed; this bill is ready to post.",
      preview,
    };
  }

  /* --- create --- */
  const payload: Record<string, unknown> = {
    VendorRef: { value: vendor.Id },
    TxnDate: a.txn_date,
    DocNumber: doc,
    Line: lineOut,
  };
  if (!usTaxModel) payload.GlobalTaxCalculation = "TaxExcluded";
  if (a.due_date) payload.DueDate = a.due_date;
  if (a.memo) payload.PrivateNote = String(a.memo).slice(0, 4000);
  if (currency !== home) {
    payload.CurrencyRef = { value: currency };
    payload.ExchangeRate = exchangeRate;
  }
  const written = await qboPost(realm, "bill", payload, operator, { scope: "create_bill", mode: "create" });
  const w = written?.Bill ?? {};

  /* --- verify --- */
  const drift: string[] = [];
  if (w.VendorRef?.value !== vendor.Id) drift.push(`VendorRef ${vendor.Id} -> ${w.VendorRef?.value}`);
  if ((w.DocNumber ?? "") !== doc) drift.push(`DocNumber "${doc}" -> "${w.DocNumber}"`);
  if (Math.abs(Number(w.TotalAmt) - computedTotal) > 0.02) drift.push(`TotalAmt ${computedTotal} -> ${w.TotalAmt}`);
  if ((w.Line?.filter((l: any) => l.DetailType === "AccountBasedExpenseLineDetail").length ?? 0) !== lineOut.length)
    drift.push(`Line count ${lineOut.length} -> ${w.Line?.length}`);
  for (const [i, l] of lineOut.entries()) {
    const got = (w.Line ?? []).filter((x: any) => x.DetailType === "AccountBasedExpenseLineDetail")[i];
    const want = l.AccountBasedExpenseLineDetail.AccountRef.value;
    if (got && got.AccountBasedExpenseLineDetail?.AccountRef?.value !== want)
      drift.push(`Line ${i + 1} account ${want} -> ${got.AccountBasedExpenseLineDetail?.AccountRef?.value}`);
  }

  await db
    .insert("posted_bill", {
      realm: realm.id,
      qbo_bill_id: w.Id ?? null,
      vendor_id: vendor.Id,
      vendor_name: vendor.DisplayName,
      doc_number: doc,
      txn_date: a.txn_date,
      currency,
      total: Number(w.TotalAmt ?? computedTotal),
      lines: preview_lines,
      source_doc: a.source_doc ?? null,
      operator,
      drift: drift.length ? drift : null,
    })
    .catch(() => {});

  await audit({
    realm: realm.id,
    kind: drift.length ? "error" : "write",
    operator,
    tool: "create_bill",
    entity: "Bill",
    entity_id: w.Id,
    outcome: drift.length ? "unexpected_drift" : "created",
    detail: {
      intuit_tid: written?.__intuit_tid ?? null,
      value_before: null,
      value_after: { vendor: vendor.DisplayName, doc_number: doc, txn_date: a.txn_date, currency, total: w.TotalAmt, lines: preview_lines },
      source_doc: a.source_doc ?? null,
      drift: drift.length ? drift : undefined,
    },
  });

  if (drift.length)
    return {
      status: "created_with_drift",
      message: `Bill ${w.Id} WAS CREATED but differs from what was sent: ${drift.join("; ")}. This is logged. Open bill ${w.Id} in QuickBooks and check it before posting anything else.`,
      preview,
      bill_id: w.Id,
      qbo_total: w.TotalAmt,
      drift,
    };

  return {
    status: "created",
    message: `Created bill ${w.Id} on ${realm.label}: ${vendor.DisplayName}, no. ${doc}, ${money(Number(w.TotalAmt), currency)}.`,
    preview,
    bill_id: w.Id,
    qbo_total: w.TotalAmt,
  };
}

function refused(a: CreateBillArgs, message: string): CreateBillResult {
  return { status: "refused", message, preview: { doc_number: a.doc_number, vendor_id: a.vendor_id } };
}
