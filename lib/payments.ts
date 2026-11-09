/**
 * Customer payment application (QuickBooks Payment / "Receive Payment").
 *
 * Used for cash application: one cheque or EFT from one customer, applied to one or more of that
 * customer's open invoices. Guards:
 *   - customer must exist and be active; payment currency must equal the customer's currency;
 *   - every invoice must exist, belong to that customer, and its current Balance must equal the
 *     expected_open_balance the caller matched against (stale match → refused, nothing written);
 *   - a line may not exceed the invoice's balance; lines may not sum to more than the payment;
 *   - deposit account must be an active Bank or Other Current Asset (Undeposited Funds) account;
 *   - duplicate: same customer + date + amount + reference already posted → refused;
 *     same customer + amount within 3 days → possible duplicate unless overridden;
 *   - dry run by default; post-write drift check; every run audited.
 * Any amount above the applied lines is left on the customer as an unapplied credit — QuickBooks
 * does this natively. Nothing here can delete, void, refund or move money between accounts.
 */
import { Realm, audit, db, getPreferences, money, qboPost, qboQuery } from "./core";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type PaymentLineIn = { invoice_id: string; amount: number; expected_open_balance: number };
export type ApplyPaymentArgs = {
  customer_id: string;
  txn_date: string;
  total_amount: number;
  currency?: string;
  payment_ref?: string; // cheque / EFT number
  deposit_account_id: string;
  payment_method?: string; // optional PaymentMethod id or name
  memo?: string;
  exchange_rate?: number;
  lines: PaymentLineIn[];
  source_doc?: string;
  override_possible_duplicate?: boolean;
  dry_run: boolean;
};

export type ApplyPaymentResult = {
  status: "ready" | "refused" | "possible_duplicate" | "created" | "created_with_drift";
  message: string;
  preview: Record<string, unknown>;
  payment_id?: string;
  duplicates?: unknown[];
  drift?: string[];
};

export async function applyPayment(realm: Realm, a: ApplyPaymentArgs, operator: string): Promise<ApplyPaymentResult> {
  const problems: string[] = [];
  const prefs = await getPreferences(realm, operator);
  const home = prefs.home_currency || "CAD";

  /* customer */
  const cid = String(a.customer_id).replace(/'/g, "");
  const cq = await qboQuery(realm, `select * from Customer where Id = '${cid}'`, operator);
  const customer = cq?.Customer?.[0];
  if (!customer) problems.push(`Customer ${a.customer_id} not found on ${realm.label}.`);
  else if (customer.Active === false) problems.push(`Customer ${customer.DisplayName} is inactive.`);
  const custCcy: string = customer?.CurrencyRef?.value ?? home;
  const currency = (a.currency ?? custCcy).toUpperCase();
  if (customer && currency !== custCcy) problems.push(`Payment currency ${currency} does not match ${customer.DisplayName}'s currency ${custCcy}.`);

  /* deposit account */
  const did = String(a.deposit_account_id).replace(/'/g, "");
  const aq = await qboQuery(realm, `select * from Account where Id = '${did}'`, operator);
  const depAcct = aq?.Account?.[0];
  if (!depAcct) problems.push(`Deposit account ${a.deposit_account_id} not found.`);
  else {
    if (depAcct.Active === false) problems.push(`Deposit account ${depAcct.FullyQualifiedName} is inactive.`);
    if (!["Bank", "Other Current Asset"].includes(depAcct.AccountType)) problems.push(`Deposit account ${depAcct.FullyQualifiedName} is ${depAcct.AccountType}; must be a Bank account or Undeposited Funds.`);
    const acctCcy = depAcct.CurrencyRef?.value;
    if (acctCcy && depAcct.AccountType === "Bank" && acctCcy !== currency) problems.push(`Bank account ${depAcct.FullyQualifiedName} is ${acctCcy}; the payment is ${currency}.`);
  }

  /* date / amount */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.txn_date)) problems.push(`txn_date must be YYYY-MM-DD.`);
  const total = round2(Number(a.total_amount));
  if (!(total > 0)) problems.push(`total_amount must be greater than zero.`);
  if (!Array.isArray(a.lines) || !a.lines.length) problems.push(`At least one invoice line is required.`);

  /* invoices */
  const preview_lines: Record<string, unknown>[] = [];
  const lineOut: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let applied = 0;
  for (const [i, l] of (a.lines ?? []).entries()) {
    const n = i + 1;
    const iid = String(l.invoice_id).replace(/'/g, "");
    if (seen.has(iid)) { problems.push(`Line ${n}: invoice ${iid} appears twice.`); continue; }
    seen.add(iid);
    const amt = round2(Number(l.amount));
    const expected = round2(Number(l.expected_open_balance));
    const iq = await qboQuery(realm, `select * from Invoice where Id = '${iid}'`, operator);
    const inv = iq?.Invoice?.[0];
    if (!inv) { problems.push(`Line ${n}: invoice ${iid} not found.`); continue; }
    const bal = round2(Number(inv.Balance));
    if (customer && String(inv.CustomerRef?.value) !== String(customer.Id)) problems.push(`Line ${n}: invoice ${inv.DocNumber ?? iid} belongs to ${inv.CustomerRef?.name}, not ${customer.DisplayName}.`);
    if (Math.abs(bal - expected) > 0.005) problems.push(`Line ${n}: invoice ${inv.DocNumber ?? iid} open balance is now ${money(bal, currency)}, not ${money(expected, currency)} as matched. Re-run the match.`);
    if (!(amt > 0)) problems.push(`Line ${n}: amount must be greater than zero.`);
    if (amt - bal > 0.005) problems.push(`Line ${n}: ${money(amt, currency)} exceeds invoice ${inv.DocNumber ?? iid}'s open balance ${money(bal, currency)}.`);
    if (inv.CurrencyRef?.value && inv.CurrencyRef.value !== currency) problems.push(`Line ${n}: invoice ${inv.DocNumber ?? iid} is ${inv.CurrencyRef.value}; the payment is ${currency}.`);
    applied = round2(applied + amt);
    preview_lines.push({ line: n, invoice: inv.DocNumber ?? iid, invoice_id: iid, invoice_date: inv.TxnDate, invoice_total: money(Number(inv.TotalAmt), currency), open_balance: money(bal, currency), apply: money(amt, currency), remaining_after: money(round2(bal - amt), currency) });
    lineOut.push({ Amount: amt, LinkedTxn: [{ TxnId: iid, TxnType: "Invoice" }] });
  }
  if (applied - total > 0.005) problems.push(`Lines apply ${money(applied, currency)} but the payment is only ${money(total, currency)}.`);
  const unapplied = round2(total - applied);

  const preview: Record<string, unknown> = {
    file: realm.label,
    customer: customer ? `${customer.DisplayName} id ${customer.Id} (${custCcy})` : String(a.customer_id),
    txn_date: a.txn_date, currency, payment_ref: a.payment_ref ?? "", memo: a.memo ?? "",
    deposit_to: depAcct ? `${depAcct.FullyQualifiedName} (${depAcct.AccountType})` : String(a.deposit_account_id),
    lines: preview_lines, total: money(total, currency), applied: money(applied, currency),
    unapplied_credit: unapplied > 0 ? money(unapplied, currency) : "none", source_doc: a.source_doc ?? "",
  };
  if (problems.length) return { status: "refused", message: problems.join("\n"), preview };

  /* duplicates */
  const d = new Date(a.txn_date + "T00:00:00Z");
  const lo = new Date(d.getTime() - 3 * 86400000).toISOString().slice(0, 10), hi = new Date(d.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const near = await qboQuery(realm, `select * from Payment where CustomerRef = '${customer.Id}' and TxnDate >= '${lo}' and TxnDate <= '${hi}' maxresults 200`, operator);
  const nearRows: any[] = (near?.Payment ?? []).filter((p: any) => Math.abs(Number(p.TotalAmt) - total) <= 0.01);
  const exact = nearRows.filter((p: any) => p.TxnDate === a.txn_date && (!a.payment_ref || String(p.PaymentRefNum ?? "") === String(a.payment_ref)));
  const alsoPosted = (await db.select("posted_payment", `realm=eq.${realm.id}&customer_id=eq.${customer.Id}&txn_date=eq.${a.txn_date}&total=eq.${total}&select=qbo_payment_id,operator,created_at`)) ?? [];
  if (exact.length || alsoPosted.length) return { status: "refused", message: `DUPLICATE. ${customer.DisplayName} already has a ${money(total, currency)} payment on ${a.txn_date}: ${exact.map((p: any) => `Payment ${p.Id} ref ${p.PaymentRefNum ?? "—"}`).join("; ")}${alsoPosted.map((p: any) => ` connector-posted ${p.qbo_payment_id} by ${p.operator}`).join("")}. Not posted.`, preview, duplicates: exact };
  if (nearRows.length && !a.override_possible_duplicate) return { status: "possible_duplicate", message: `POSSIBLE DUPLICATE. ${customer.DisplayName} has ${nearRows.length} payment(s) of ${money(total, currency)} within 3 days: ${nearRows.map((p: any) => `Payment ${p.Id} on ${p.TxnDate} ref ${p.PaymentRefNum ?? "—"}`).join("; ")}. Confirm with the user; re-run with override_possible_duplicate: true if it is a different remittance. Not posted.`, preview, duplicates: nearRows };

  /* fx */
  let exchangeRate: number | undefined;
  if (currency !== home) {
    exchangeRate = a.exchange_rate;
    if (!exchangeRate) { try { const er = await (await import("./core")).qboGet(realm, `exchangerate?sourcecurrencycode=${currency}&asofdate=${a.txn_date}`, operator); exchangeRate = Number(er?.ExchangeRate?.Rate); } catch {} }
    if (!exchangeRate || !(exchangeRate > 0)) return { status: "refused", message: `${currency} payment on a ${home} file needs an exchange rate; none found for ${a.txn_date}. Pass exchange_rate.`, preview };
    preview.exchange_rate = exchangeRate;
  }

  /* payment method (optional) */
  let pm: any;
  if (a.payment_method) {
    const p = String(a.payment_method).replace(/'/g, "");
    const q = await qboQuery(realm, /^\d+$/.test(p) ? `select * from PaymentMethod where Id = '${p}'` : `select * from PaymentMethod where Name = '${p}'`, operator);
    pm = q?.PaymentMethod?.[0];
    if (!pm) return { status: "refused", message: `Payment method "${a.payment_method}" not found.`, preview };
    preview.payment_method = pm.Name;
  }

  if (a.dry_run) return { status: "ready", message: `Dry run. Nothing was written. All checks passed.${unapplied > 0 ? ` ${money(unapplied, currency)} would remain as an unapplied credit on ${customer.DisplayName}.` : ""}`, preview };

  const payload: Record<string, unknown> = { CustomerRef: { value: customer.Id }, TxnDate: a.txn_date, TotalAmt: total, DepositToAccountRef: { value: depAcct.Id }, Line: lineOut };
  if (a.payment_ref) payload.PaymentRefNum = String(a.payment_ref).slice(0, 21);
  if (a.memo) payload.PrivateNote = String(a.memo).slice(0, 4000);
  if (pm) payload.PaymentMethodRef = { value: pm.Id };
  if (currency !== home) { payload.CurrencyRef = { value: currency }; payload.ExchangeRate = exchangeRate; }

  const written = await qboPost(realm, "payment", payload, operator, { scope: "apply_payment", mode: "create" });
  const w = written?.Payment ?? {};
  const drift: string[] = [];
  if (String(w.CustomerRef?.value) !== String(customer.Id)) drift.push(`CustomerRef ${customer.Id} -> ${w.CustomerRef?.value}`);
  if (Math.abs(Number(w.TotalAmt) - total) > 0.005) drift.push(`TotalAmt ${total} -> ${w.TotalAmt}`);
  if (Math.abs(Number(w.UnappliedAmt ?? 0) - unapplied) > 0.005) drift.push(`UnappliedAmt ${unapplied} -> ${w.UnappliedAmt}`);
  const linked = (w.Line ?? []).flatMap((l: any) => (l.LinkedTxn ?? []).map((t: any) => String(t.TxnId)));
  for (const l of lineOut) { const id = String((l.LinkedTxn as any)[0].TxnId); if (!linked.includes(id)) drift.push(`Invoice ${id} not linked`); }

  await db.insert("posted_payment", { realm: realm.id, qbo_payment_id: w.Id ?? null, customer_id: customer.Id, customer_name: customer.DisplayName, payment_ref: a.payment_ref ?? null, txn_date: a.txn_date, currency, total, applied, unapplied, deposit_account_id: depAcct.Id, deposit_account_name: depAcct.FullyQualifiedName, lines: preview_lines, source_doc: a.source_doc ?? null, operator, drift: drift.length ? drift : null }).catch(() => {});
  await audit({ realm: realm.id, kind: drift.length ? "error" : "write", operator, tool: "apply_payment", entity: "Payment", entity_id: w.Id, outcome: drift.length ? "unexpected_drift" : "created", detail: { intuit_tid: written?.__intuit_tid ?? null, value_before: preview_lines.map((l) => ({ invoice: l.invoice, open_balance: l.open_balance })), value_after: { customer: customer.DisplayName, txn_date: a.txn_date, currency, total, applied, unapplied, deposit_to: depAcct.FullyQualifiedName, ref: a.payment_ref ?? null, lines: preview_lines }, source_doc: a.source_doc ?? null, drift: drift.length ? drift : undefined } });

  if (drift.length) return { status: "created_with_drift", message: `Payment ${w.Id} WAS CREATED but differs from what was sent: ${drift.join("; ")}. Check it in QuickBooks before continuing.`, preview, payment_id: w.Id, drift };
  return { status: "created", message: `Created payment ${w.Id} on ${realm.label}: ${customer.DisplayName}, ${a.txn_date}, ${money(total, currency)}${a.payment_ref ? " ref " + a.payment_ref : ""}, applied ${money(applied, currency)} to ${lineOut.length} invoice(s)${unapplied > 0 ? `, ${money(unapplied, currency)} left as unapplied credit` : ""}.`, preview, payment_id: w.Id };
}

/** Open invoices for one customer — the matching list for cash application. Read only. */
export async function openInvoices(realm: Realm, customerId: string, operator: string) {
  const cid = String(customerId).replace(/'/g, "");
  const r = await qboQuery(realm, `select * from Invoice where CustomerRef = '${cid}' and Balance > '0' orderby TxnDate maxresults 500`, operator);
  return (r?.Invoice ?? []).map((i: any) => ({ id: i.Id, doc: i.DocNumber ?? "", date: i.TxnDate, due: i.DueDate ?? "", currency: i.CurrencyRef?.value ?? "", total: Number(i.TotalAmt), balance: Number(i.Balance), customer: i.CustomerRef?.name ?? "" }));
}

/** Customers by name search (and currency). Read only. */
export async function findCustomers(realm: Realm, search: string, operator: string) {
  const s = String(search).replace(/'/g, "").replace(/%/g, "");
  const r = await qboQuery(realm, `select * from Customer where Active = true and DisplayName like '%${s}%' maxresults 50`, operator);
  return (r?.Customer ?? []).map((c: any) => ({ id: c.Id, name: c.DisplayName, currency: c.CurrencyRef?.value ?? "", balance: Number(c.Balance ?? 0) }));
}

/** Deposit targets: active Bank and Undeposited Funds accounts. Read only. */
export async function depositAccounts(realm: Realm, operator: string) {
  const r = await qboQuery(realm, `select * from Account where Active = true and AccountType in ('Bank','Other Current Asset') maxresults 200`, operator);
  return (r?.Account ?? []).filter((a: any) => a.AccountType === "Bank" || a.AccountSubType === "UndepositedFunds").map((a: any) => ({ id: a.Id, name: a.FullyQualifiedName, type: a.AccountType === "Bank" ? "Bank" : "Undeposited Funds", currency: a.CurrencyRef?.value ?? "" }));
}
