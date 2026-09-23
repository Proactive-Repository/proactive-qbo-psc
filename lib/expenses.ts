/**
 * Credit-card expense entry (QuickBooks Purchase, PaymentType=CreditCard).
 *
 * Used for card statement reconciliation: statement lines that have no matching entry on the
 * card's QuickBooks account are created as Purchase transactions, one per line, each coded to a
 * GL account the person confirmed. Guards mirror create_bill:
 *   - the payment account must be an active Credit Card account on this file;
 *   - payee (vendor) optional, but if given must exist and be active;
 *   - duplicate: same card account + txn date + amount (+ same payee if given) already posted →
 *     refused; same account + amount within 3 days → possible duplicate unless overridden;
 *   - every line names an active postable account; Canadian files need a tax code per line and
 *     lines + tax must equal the statement amount to the cent; US files omit tax codes;
 *   - dry run by default; post-write drift check.
 * Nothing here can pay, void, delete, or touch bank accounts.
 */
import { Realm, audit, db, getPreferences, money, qboPost, qboQuery, qboQueryAll } from "./core";
import { loadAccounts, loadTaxCodes, resolveAccount } from "./bills";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function listCardAccounts(realm: Realm, operator: string) {
  const all = await loadAccounts(realm, operator);
  // loadAccounts caches the full Account list; filter to Credit Card type here.
  return all.filter((a) => a.AccountType === "Credit Card" && a.Active !== false)
    .map((a) => ({ id: a.Id, name: a.FullyQualifiedName, number: a.AcctNum ?? "", currency: a.CurrencyRef?.value ?? "" }));
}

export async function cardTransactions(realm: Realm, accountId: string, start: string, end: string, operator: string) {
  const id = accountId.replace(/'/g, "");
  // QBO does not allow filtering Purchase on AccountRef ("AccountRef is not queryable"),
  // so pull all credit-card purchases in the window and filter to the card here.
  const all: any[] = await qboQueryAll(
    realm,
    `select * from Purchase where PaymentType = 'CreditCard' and TxnDate >= '${start}' and TxnDate <= '${end}'`,
    "Purchase", operator, 1000,
  );
  const rows = all.filter((p) => String(p.AccountRef?.value) === id);
  return rows.map((p) => ({
    id: p.Id, date: p.TxnDate, payee: p.EntityRef?.name ?? "", amount: Number(p.TotalAmt), currency: p.CurrencyRef?.value ?? "",
    doc: p.DocNumber ?? "", memo: (p.PrivateNote ?? "").slice(0, 60),
    accounts: [...new Set((p.Line ?? []).map((l: any) => l.AccountBasedExpenseLineDetail?.AccountRef?.name).filter(Boolean))].join(" · "),
  }));
}

export type ExpenseLineIn = { description: string; amount: number; account: string; tax_code?: string };
export type CreateExpenseArgs = {
  card_account: string; // id, number or name of the credit card account
  txn_date: string;
  payee?: string; // vendor id or exact display name (optional)
  doc_number?: string; // statement reference
  memo?: string;
  currency?: string;
  exchange_rate?: number;
  lines: ExpenseLineIn[];
  expected_total: number; // statement line amount incl. tax
  source_doc?: string;
  override_possible_duplicate?: boolean;
  dry_run: boolean;
};

export type CreateExpenseResult = { status: "ready" | "refused" | "possible_duplicate" | "created" | "created_with_drift"; message: string; preview: Record<string, unknown>; purchase_id?: string; duplicates?: any[]; drift?: string[] };

export async function createExpense(realm: Realm, a: CreateExpenseArgs, operator: string): Promise<CreateExpenseResult> {
  const refused = (m: string): CreateExpenseResult => ({ status: "refused", message: m, preview: { card_account: a.card_account, txn_date: a.txn_date, expected_total: a.expected_total } });
  if (!Array.isArray(a.lines) || !a.lines.length) return refused("At least one line is required.");
  if (!Number.isFinite(a.expected_total) || a.expected_total <= 0) return refused("expected_total must be a positive number.");
  const validDate = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x) && !isNaN(new Date(x + "T00:00:00Z").getTime());
  if (!validDate(a.txn_date)) return refused("txn_date must be a valid date, YYYY-MM-DD.");

  let home = realm.home_currency ?? ""; let us = realm.country === "US";
  try { const p = await getPreferences(realm, operator); if (p.home_currency) home = p.home_currency; us = (p as any).country === "US" || us; } catch {}
  if (!home) return refused("Could not determine the company file's home currency.");

  /* card account */
  const cards = await listCardAccounts(realm, operator);
  const key = a.card_account.trim().toLowerCase();
  const card = cards.find((c) => c.id === a.card_account) ?? cards.find((c) => c.number && c.number === a.card_account) ?? cards.find((c) => c.name.toLowerCase() === key) ?? (cards.filter((c) => c.name.toLowerCase().includes(key)).length === 1 ? cards.filter((c) => c.name.toLowerCase().includes(key))[0] : undefined);
  if (!card) return refused(`"${a.card_account}" is not an active Credit Card account on ${realm.label}. Use list_card_accounts.`);
  const currency = (a.currency ?? card.currency ?? home).toUpperCase();
  if (card.currency && card.currency !== currency) return refused(`Card account ${card.name} is ${card.currency}; the transaction is ${currency}.`);

  /* payee */
  let payee: any = null;
  if (a.payee) {
    const p = a.payee.replace(/'/g, "");
    const q = await qboQuery(realm, /^\d+$/.test(p) ? `select * from Vendor where Id = '${p}'` : `select * from Vendor where DisplayName = '${p}'`, operator);
    payee = q?.Vendor?.[0];
    if (!payee) return refused(`Payee "${a.payee}" not found as a vendor. Omit payee, or use list_vendors to find the exact name.`);
    if (payee.Active === false) return refused(`Vendor "${payee.DisplayName}" is inactive.`);
  }

  /* lines */
  const accounts = await loadAccounts(realm, operator);
  const taxCodes = us ? [] : await loadTaxCodes(realm, operator);
  const lineOut: any[] = []; const preview_lines: any[] = []; const problems: string[] = [];
  let subtotal = 0, tax = 0;
  for (const [i, l] of a.lines.entries()) {
    if (!(Number(l.amount) > 0)) problems.push(`Line ${i + 1}: amount must be positive.`);
    const { account, candidates } = resolveAccount(accounts, String(l.account ?? ""));
    if (!account) problems.push(`Line ${i + 1}: account "${l.account}" ${candidates.length ? "is ambiguous — candidates: " + candidates.map((c) => c.FullyQualifiedName).join("; ") : "is not an active, postable account"}.`);
    const tcRef = String(l.tax_code ?? "").trim().toLowerCase();
    const tc = us ? null : taxCodes.find((t) => t.id === tcRef || t.name.toLowerCase() === tcRef);
    if (!us && !tc) problems.push(`Line ${i + 1}: tax code "${l.tax_code}" not found. Use list_tax_codes.`);
    if (account && (us || tc)) {
      const amt = round2(Number(l.amount)); subtotal += amt; if (tc) tax += amt * (tc.purchase_rate_pct / 100);
      const detail: Record<string, unknown> = { AccountRef: { value: account.Id, name: account.FullyQualifiedName } };
      if (tc) detail.TaxCodeRef = { value: tc.id };
      lineOut.push({ DetailType: "AccountBasedExpenseLineDetail", Amount: amt, Description: String(l.description ?? "").slice(0, 4000), AccountBasedExpenseLineDetail: detail });
      preview_lines.push({ line: i + 1, description: l.description, account: `${account.AcctNum ? account.AcctNum + " " : ""}${account.FullyQualifiedName}`, tax_code: tc ? `${tc.name} (${tc.purchase_rate_pct}%)` : "n/a (US file)", amount: money(amt) });
    }
  }
  subtotal = round2(subtotal); tax = round2(tax); const computed = round2(subtotal + tax);
  const preview: Record<string, unknown> = { file: realm.label, card_account: `${card.name} (${card.currency || home}) id ${card.id}`, txn_date: a.txn_date, payee: payee ? `${payee.DisplayName} id ${payee.Id}` : "(none)", doc_number: a.doc_number ?? "", memo: a.memo ?? "", currency, lines: preview_lines, subtotal: money(subtotal), tax: money(tax), computed_total: money(computed), statement_amount: money(a.expected_total), source_doc: a.source_doc ?? "" };
  if (problems.length) return { status: "refused", message: problems.join("\n"), preview };
  if (Math.abs(computed - round2(a.expected_total)) > 0.02) return { status: "refused", message: `Lines plus tax come to ${money(computed)} but the statement line is ${money(a.expected_total)} (difference ${money(round2(computed - a.expected_total))}). Nothing was written.`, preview };

  /* duplicates */
  const d = new Date(a.txn_date + "T00:00:00Z");
  const lo = new Date(d.getTime() - 3 * 86400000).toISOString().slice(0, 10), hi = new Date(d.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const near = await qboQuery(realm, `select * from Purchase where PaymentType = 'CreditCard' and TxnDate >= '${lo}' and TxnDate <= '${hi}' maxresults 1000`, operator);
  const nearRows: any[] = (near?.Purchase ?? []).filter((p: any) => String(p.AccountRef?.value) === String(card.id) && Math.abs(Number(p.TotalAmt) - round2(a.expected_total)) <= 0.01);
  const exact = nearRows.filter((p: any) => p.TxnDate === a.txn_date && (!payee || p.EntityRef?.value === payee.Id));
  const alsoPosted = (await db.select("posted_expense", `realm=eq.${realm.id}&card_account_id=eq.${card.id}&txn_date=eq.${a.txn_date}&total=eq.${round2(a.expected_total)}&select=qbo_purchase_id,operator,created_at`)) ?? [];
  if (exact.length || alsoPosted.length) return { status: "refused", message: `DUPLICATE. ${card.name} already has ${money(a.expected_total)} on ${a.txn_date}${payee ? " to " + payee.DisplayName : ""}: ${exact.map((p: any) => `Purchase ${p.Id} (${p.EntityRef?.name ?? "no payee"})`).join("; ")}${alsoPosted.map((p: any) => ` connector-posted ${p.qbo_purchase_id} by ${p.operator}`).join("")}. Not posted.`, preview, duplicates: exact };
  if (nearRows.length && !a.override_possible_duplicate) return { status: "possible_duplicate", message: `POSSIBLE DUPLICATE. ${card.name} has ${nearRows.length} transaction(s) for ${money(a.expected_total)} within 3 days: ${nearRows.map((p: any) => `Purchase ${p.Id} on ${p.TxnDate} (${p.EntityRef?.name ?? "no payee"})`).join("; ")}. Confirm with the user; re-run with override_possible_duplicate: true if it is a different charge. Not posted.`, preview, duplicates: nearRows };

  /* fx */
  let exchangeRate: number | undefined;
  if (currency !== home) {
    exchangeRate = a.exchange_rate;
    if (!exchangeRate) { try { const er = await (await import("./core")).qboGet(realm, `exchangerate?sourcecurrencycode=${currency}&asofdate=${a.txn_date}`, operator); exchangeRate = Number(er?.ExchangeRate?.Rate); } catch {} }
    if (!exchangeRate || !(exchangeRate > 0)) return { status: "refused", message: `${currency} transaction on a ${home} file needs an exchange rate; none found for ${a.txn_date}. Pass exchange_rate.`, preview };
    preview.exchange_rate = exchangeRate;
  }

  if (a.dry_run) return { status: "ready", message: "Dry run. Nothing was written. All checks passed.", preview };

  const payload: Record<string, unknown> = { PaymentType: "CreditCard", AccountRef: { value: card.id }, TxnDate: a.txn_date, Line: lineOut };
  if (payee) payload.EntityRef = { value: payee.Id, type: "Vendor" };
  if (a.doc_number) payload.DocNumber = String(a.doc_number).slice(0, 21);
  if (a.memo) payload.PrivateNote = String(a.memo).slice(0, 4000);
  if (!us) payload.GlobalTaxCalculation = "TaxExcluded";
  if (currency !== home) { payload.CurrencyRef = { value: currency }; payload.ExchangeRate = exchangeRate; }

  const written = await qboPost(realm, "purchase", payload, operator, { scope: "create_expense", mode: "create" });
  const w = written?.Purchase ?? {};
  const drift: string[] = [];
  if (w.AccountRef?.value !== card.id) drift.push(`AccountRef ${card.id} -> ${w.AccountRef?.value}`);
  if (Math.abs(Number(w.TotalAmt) - computed) > 0.02) drift.push(`TotalAmt ${computed} -> ${w.TotalAmt}`);
  if ((w.Line?.filter((l: any) => l.DetailType === "AccountBasedExpenseLineDetail").length ?? 0) !== lineOut.length) drift.push(`Line count ${lineOut.length} -> ${w.Line?.length}`);

  await db.insert("posted_expense", { realm: realm.id, qbo_purchase_id: w.Id ?? null, card_account_id: card.id, card_account_name: card.name, payee_id: payee?.Id ?? null, payee_name: payee?.DisplayName ?? null, doc_number: a.doc_number ?? null, txn_date: a.txn_date, currency, total: Number(w.TotalAmt ?? computed), lines: preview_lines, source_doc: a.source_doc ?? null, operator, drift: drift.length ? drift : null }).catch(() => {});
  await audit({ realm: realm.id, kind: drift.length ? "error" : "write", operator, tool: "create_expense", entity: "Purchase", entity_id: w.Id, outcome: drift.length ? "unexpected_drift" : "created", detail: { intuit_tid: written?.__intuit_tid ?? null, value_before: null, value_after: { card: card.name, payee: payee?.DisplayName ?? null, txn_date: a.txn_date, currency, total: w.TotalAmt, lines: preview_lines }, source_doc: a.source_doc ?? null, drift: drift.length ? drift : undefined } });

  if (drift.length) return { status: "created_with_drift", message: `Purchase ${w.Id} WAS CREATED but differs from what was sent: ${drift.join("; ")}. Check it in QuickBooks before continuing.`, preview, purchase_id: w.Id, drift };
  return { status: "created", message: `Created credit card expense ${w.Id} on ${realm.label}: ${card.name}, ${a.txn_date}, ${money(Number(w.TotalAmt), currency)}${payee ? ", " + payee.DisplayName : ""}.`, preview, purchase_id: w.Id };
}
