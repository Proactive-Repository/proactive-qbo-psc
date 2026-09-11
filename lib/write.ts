/**
 * The MX write: put the carrier's invoice number onto the bill, and keep the
 * load number in the memo.
 *
 * This is the MX carrier reconciliation write, shared with QBO-01. It is deliberately
 * the smallest possible change to a bill: two fields, sparse, one record at a
 * time, with the before and after values recorded.
 *
 * What this never does: create a bill, delete a bill, void anything, change an
 * amount, change a vendor, change an account, or move money.
 */
import { Realm, audit, db, qboGet, qboPost } from "./core";

export type WriteResult = {
  bill_id: string;
  vendor: string | null;
  currency: string | null;
  amount: number | null;
  before: { DocNumber: string | null; PrivateNote: string | null };
  after: { DocNumber: string | null; PrivateNote: string | null };
  applied: boolean;
  note: string;
};

/** Read the bill fresh. Never write from a cached or proposed copy. */
async function readBill(realm: Realm, billId: string, operator: string) {
  const data = await qboGet(realm, `bill/${encodeURIComponent(billId)}`, operator);
  const b = data?.Bill;
  if (!b) throw new Error(`Bill ${billId} was not found on ${realm.label}.`);
  return b;
}

export async function setInvoiceNumber(
  realm: Realm,
  args: {
    bill_id: string;
    invoice_number: string;
    load_number?: string;
    expected_amount?: number;
    dry_run?: boolean;
  },
  operator: string,
): Promise<WriteResult> {
  const { bill_id, invoice_number, load_number, expected_amount } = args;
  const dry = args.dry_run !== false && args.dry_run !== undefined ? args.dry_run : false;

  const bill = await readBill(realm, bill_id, operator);

  const before = {
    DocNumber: bill.DocNumber ?? null,
    PrivateNote: bill.PrivateNote ?? null,
  };
  const vendor = bill.VendorRef?.name ?? bill.VendorRef?.value ?? null;
  const currency = bill.CurrencyRef?.value ?? null;
  const amount = typeof bill.TotalAmt === "number" ? bill.TotalAmt : null;

  const base: WriteResult = {
    bill_id,
    vendor,
    currency,
    amount,
    before,
    after: before,
    applied: false,
    note: "",
  };

  // Safety: if the caller stated an amount, it must still match the ledger.
  // Protects against writing to a bill that changed since it was matched.
  if (
    typeof expected_amount === "number" &&
    amount !== null &&
    Math.abs(amount - expected_amount) > 0.01
  ) {
    return {
      ...base,
      note: `Refused. The bill is ${amount} but the match said ${expected_amount}. It has changed since it was reconciled — re-run the match.`,
    };
  }

  // Refuse to overwrite a document number that already looks like a real
  // invoice reference rather than a load number, unless it is the same value.
  if (
    before.DocNumber &&
    before.DocNumber.trim() !== invoice_number.trim() &&
    load_number &&
    !before.DocNumber.toLowerCase().includes(load_number.toLowerCase())
  ) {
    return {
      ...base,
      note: `Refused. The bill already carries document number "${before.DocNumber}", which is not the load number "${load_number}". Someone may have already actioned this. A person should look before it is changed.`,
    };
  }

  // Keep the load number visible in the memo, and never discard what was there.
  const loadTag = load_number ? `Load ${load_number}` : null;
  const memoParts = [loadTag, before.PrivateNote].filter(Boolean) as string[];
  const memo = memoParts.length ? memoParts.join(" · ").slice(0, 4000) : null;

  const after = { DocNumber: invoice_number.trim().slice(0, 21), PrivateNote: memo };

  if (dry) {
    return {
      ...base,
      after,
      note: "Dry run. Nothing was written to QuickBooks.",
    };
  }

  /**
   * Echo the whole bill back, with only the two fields changed.
   *
   * QuickBooks requires an entity's required attributes on update even when
   * sparse is true — sparse exempts optional fields, not required ones. Building
   * a minimal payload and adding fields as Intuit names them is whack-a-mole:
   * it cost two failed runs, first VendorRef (fault 2020), then ExchangeRate on
   * foreign-currency bills (fault 2410). A CAD home currency means every USD
   * carrier bill is a foreign-currency transaction, so that second one would
   * have hit every bill in the MX file.
   *
   * Sending the object back whole makes every required field present by
   * construction, whatever Intuit decides those are. Re-sending an identical
   * value cannot change anything; the null-out risk comes from OMITTING fields.
   *
   * Derived and server-owned fields are stripped — QuickBooks recalculates
   * those and will reject or ignore them.
   */
  if (!bill.VendorRef?.value) {
    throw new Error(
      `Bill ${bill.Id} has no VendorRef, which QuickBooks requires on update. Nothing was written.`,
    );
  }

  const DERIVED = new Set([
    "domain",
    "sparse",
    "MetaData",
    "Balance",
    "HomeBalance",
    "HomeTotalAmt",
    "LinkedTxn",
    "RecurDataRef",
  ]);

  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bill)) {
    if (!DERIVED.has(k) && !k.startsWith("__")) payload[k] = v;
  }
  payload.sparse = true;
  payload.Id = bill.Id;
  payload.SyncToken = bill.SyncToken;
  payload.DocNumber = after.DocNumber;
  if (after.PrivateNote !== null) payload.PrivateNote = after.PrivateNote;

  const written = await qboPost(realm, "bill", payload, operator, {
    scope: "set_invoice_number",
    mode: "update",
  });

  /**
   * Verify nothing except the two intended fields moved. Belt and braces after
   * two wrong assumptions about this call — the ledger is not the place to
   * trust an assumption.
   */
  const w = written?.Bill ?? {};
  const drift: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!same(w.TotalAmt, bill.TotalAmt)) drift.push(`TotalAmt ${bill.TotalAmt} -> ${w.TotalAmt}`);
  if (!same(w.VendorRef?.value, bill.VendorRef?.value)) drift.push("VendorRef changed");
  if (!same(w.CurrencyRef?.value, bill.CurrencyRef?.value)) drift.push("CurrencyRef changed");
  if (!same(w.ExchangeRate, bill.ExchangeRate))
    drift.push(`ExchangeRate ${bill.ExchangeRate} -> ${w.ExchangeRate}`);
  if (!same(w.TxnDate, bill.TxnDate)) drift.push(`TxnDate ${bill.TxnDate} -> ${w.TxnDate}`);
  if ((w.Line?.length ?? 0) !== (bill.Line?.length ?? 0))
    drift.push(`Line count ${bill.Line?.length} -> ${w.Line?.length}`);

  if (drift.length) {
    await audit({
      realm: realm.id,
      kind: "error",
      operator,
      tool: "set_invoice_number",
      entity: "Bill",
      entity_id: bill.Id,
      outcome: "unexpected_drift",
      detail: { drift, sent: payload },
    });
    throw new Error(
      `The document number was written, but something else changed on bill ${bill.Id}: ${drift.join("; ")}. This has been logged. Check this bill in QuickBooks before writing any others.`,
    );
  }

  await audit({
    realm: realm.id,
    kind: "write",
    operator,
    tool: "set_invoice_number",
    entity: "Bill",
    entity_id: bill.Id,
    outcome: "applied",
    detail: {
      vendor,
      currency,
      amount,
      value_before: before,
      value_after: after,
      source_doc: `carrier invoice ${invoice_number}`,
      load_number: load_number ?? null,
    },
  });

  // Mark the matching proposal as applied, so the run record shows what was done.
  await db
    .update(
      "recon_match",
      `bill_id=eq.${encodeURIComponent(bill.Id)}&status=eq.matched`,
      { notes: `Applied ${invoice_number} by ${operator} at ${new Date().toISOString()}` },
    )
    .catch(() => {});

  return { ...base, after, applied: true, note: "Applied." };
}
