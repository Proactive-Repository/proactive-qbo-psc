import { PROJECT_CODE } from "./brand";
/**
 * QBO-02 connector (PSC) — core services.
 * Reads are unrestricted. The single write path is qboPost, which is gated on
 * write_enabled AND a named write scope per company file. Two scopes exist:
 *   set_invoice_number — sparse update of DocNumber + PrivateNote on an existing bill
 *   create_bill        — create one new vendor bill from an approved invoice
 * Nothing else is writable. Nothing can void, delete or pay.
 */
import crypto from "node:crypto";

/* ------------------------------------------------------------------ config */

export const CFG = {
  clientId: process.env.QBO_CLIENT_ID ?? "",
  clientSecret: process.env.QBO_CLIENT_SECRET ?? "",
  env: (process.env.QBO_ENV ?? "sandbox") as "sandbox" | "production",
  redirectUri: process.env.QBO_REDIRECT_URI ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  encKey: process.env.TOKEN_ENC_KEY ?? "",
  adminKey: process.env.ADMIN_KEY ?? "",
};

export const QBO_BASE = () =>
  CFG.env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

const MINOR_VERSION = "75";

export function configProblems(): string[] {
  const missing: string[] = [];
  for (const [k, v] of Object.entries({
    QBO_CLIENT_ID: CFG.clientId,
    QBO_CLIENT_SECRET: CFG.clientSecret,
    QBO_REDIRECT_URI: CFG.redirectUri,
    SUPABASE_URL: CFG.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: CFG.supabaseKey,
    TOKEN_ENC_KEY: CFG.encKey,
  })) {
    if (!v) missing.push(k);
  }
  return missing;
}

/* --------------------------------------------------------------- crypto */

function key(): Buffer {
  const k = Buffer.from(CFG.encKey, "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64 encoded");
  return k;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decrypt(blob: string): string {
  const b = Buffer.from(blob, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/* -------------------------------------------------------------- supabase */

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: CFG.supabaseKey,
      Authorization: `Bearer ${CFG.supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const db = {
  select: (t: string, q = "") => sb(`${t}?${q}`),
  insert: (t: string, row: unknown) =>
    sb(t, { method: "POST", body: JSON.stringify(row) }),
  update: (t: string, q: string, patch: unknown) =>
    sb(`${t}?${q}`, { method: "PATCH", body: JSON.stringify(patch) }),
};

/* ----------------------------------------------------------------- audit */

export type AuditKind = "read" | "write" | "auth" | "error";

export async function audit(e: {
  realm?: string | null;
  kind: AuditKind;
  operator?: string | null;
  tool?: string;
  entity?: string;
  entity_id?: string;
  outcome?: string;
  detail?: unknown;
}) {
  try {
    await db.insert("audit_event", {
      realm: e.realm ?? null,
      kind: e.kind,
      operator: e.operator ?? null,
      tool: e.tool ?? null,
      entity: e.entity ?? null,
      entity_id: e.entity_id ?? null,
      outcome: e.outcome ?? "ok",
      detail: e.detail ?? null,
    });
  } catch {
    /* audit must never break the caller; failures surface in Vercel logs */
  }
}

/* ----------------------------------------------------------------- realms */

export type Realm = {
  id: string;
  label: string;
  realm_id: string | null;
  environment: string;
  status: string;
  write_enabled: boolean;
  write_scope: string[] | null;
  home_currency: string | null;
  authorised_by: string | null;
  authorised_at: string | null;
};

export async function getRealm(label: string): Promise<Realm> {
  const rows = await db.select(
    "qbo_realm",
    `label=eq.${encodeURIComponent(label.toUpperCase())}&select=*`,
  );
  if (!rows?.length) throw new Error(`Unknown company file "${label}"`);
  return rows[0];
}

export async function listRealms(): Promise<Realm[]> {
  return (await db.select("qbo_realm", "select=*&order=label")) ?? [];
}

/* ----------------------------------------------------------------- tokens */

/**
 * OAuth endpoints come from Intuit's discovery document rather than being
 * hardcoded, so an endpoint change on Intuit's side does not break us.
 * Cached in module memory for the life of the serverless instance; falls back
 * to the documented endpoints if discovery is unreachable.
 */
const DISCOVERY_URL = () =>
  CFG.env === "production"
    ? "https://developer.api.intuit.com/.well-known/openid_configuration"
    : "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration";

const FALLBACK = {
  authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
  token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
};

let discoveryCache: { at: number; doc: typeof FALLBACK } | null = null;

export async function endpoints(): Promise<typeof FALLBACK> {
  if (discoveryCache && Date.now() - discoveryCache.at < 60 * 60 * 1000) {
    return discoveryCache.doc;
  }
  try {
    const res = await fetch(DISCOVERY_URL(), { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    const doc = {
      authorization_endpoint: d.authorization_endpoint ?? FALLBACK.authorization_endpoint,
      token_endpoint: d.token_endpoint ?? FALLBACK.token_endpoint,
      revocation_endpoint: d.revocation_endpoint ?? FALLBACK.revocation_endpoint,
    };
    discoveryCache = { at: Date.now(), doc };
    return doc;
  } catch (e) {
    await audit({
      kind: "error",
      tool: "discovery",
      outcome: "discovery_unavailable",
      detail: { message: String(e), note: "using documented fallback endpoints" },
    });
    return FALLBACK;
  }
}

function basicAuth() {
  return Buffer.from(`${CFG.clientId}:${CFG.clientSecret}`).toString("base64");
}

export async function exchangeCode(code: string) {
  const { token_endpoint } = await endpoints();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CFG.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function refresh(realm: Realm, refreshToken: string) {
  const { token_endpoint } = await endpoints();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) {
    await db.update("qbo_token", `realm=eq.${realm.id}`, {
      refresh_failures: 99,
      updated_at: new Date().toISOString(),
    });
    await audit({
      realm: realm.id,
      kind: "error",
      outcome: "refresh_failed",
      detail: { status: res.status },
    });
    throw new Error(
      `Refresh failed for ${realm.label} (${res.status}). The company file must be re-authorised.`,
    );
  }
  return res.json();
}

export async function saveTokens(realmRowId: string, tok: any) {
  const now = Date.now();
  await db.insert("qbo_token", {
    realm: realmRowId,
    access_token_enc: encrypt(tok.access_token),
    access_expires_at: new Date(now + tok.expires_in * 1000).toISOString(),
    refresh_token_enc: encrypt(tok.refresh_token),
    refresh_expires_at: new Date(
      now + (tok.x_refresh_token_expires_in ?? 8640000) * 1000,
    ).toISOString(),
    last_refresh_at: new Date().toISOString(),
    refresh_failures: 0,
    updated_at: new Date().toISOString(),
  } as any).catch(async () => {
    await db.update("qbo_token", `realm=eq.${realmRowId}`, {
      access_token_enc: encrypt(tok.access_token),
      access_expires_at: new Date(now + tok.expires_in * 1000).toISOString(),
      refresh_token_enc: encrypt(tok.refresh_token),
      refresh_expires_at: new Date(
        now + (tok.x_refresh_token_expires_in ?? 8640000) * 1000,
      ).toISOString(),
      last_refresh_at: new Date().toISOString(),
      refresh_failures: 0,
      updated_at: new Date().toISOString(),
    });
  });
}

async function accessToken(realm: Realm): Promise<string> {
  const rows = await db.select("qbo_token", `realm=eq.${realm.id}&select=*`);
  if (!rows?.length) throw new Error(`${realm.label} is not connected yet.`);
  const row = rows[0];
  const expiresAt = new Date(row.access_expires_at).getTime();
  // refresh a minute early
  if (expiresAt - Date.now() > 60_000) return decrypt(row.access_token_enc);
  const tok = await refresh(realm, decrypt(row.refresh_token_enc));
  await saveTokens(realm.id, tok);
  return tok.access_token;
}

/* -------------------------------------------------------------- QBO calls */

/**
 * Read call. GET only. The write path is qboPost, further down, which is the
 * code path that can POST to QuickBooks during Phase 1.
 */
export async function qboGet(realm: Realm, path: string, operator?: string) {
  if (!realm.realm_id) throw new Error(`${realm.label} has no realm id — not authorised.`);
  const token = await accessToken(realm);
  const sep = path.includes("?") ? "&" : "?";
  const url = `${QBO_BASE()}/v3/company/${realm.realm_id}/${path}${sep}minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await res.text();
  // Intuit's support team traces requests by intuit_tid. Capture it on every
  // call so a problem report can be tied to their server-side logs.
  const tid = res.headers.get("intuit_tid") ?? res.headers.get("Intuit_TID") ?? null;

  if (!res.ok) {
    await audit({
      realm: realm.id,
      kind: "error",
      operator,
      entity: path,
      outcome: `http_${res.status}`,
      detail: { intuit_tid: tid, body: body.slice(0, 800) },
    });
    const ref = tid ? ` (Intuit reference ${tid})` : "";
    if (res.status === 429)
      throw new Error(`QuickBooks rate limit hit. Wait 60 seconds and retry.${ref}`);
    if (res.status === 401)
      throw new Error(
        `QuickBooks rejected the credentials for ${realm.label}. The company file must be re-authorised by a QuickBooks admin.${ref}`,
      );
    throw new Error(`QuickBooks ${res.status}: ${body.slice(0, 400)}${ref}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    await audit({
      realm: realm.id,
      kind: "error",
      operator,
      entity: path,
      outcome: "unparseable_response",
      detail: { intuit_tid: tid, body: body.slice(0, 400) },
    });
    throw new Error(
      `QuickBooks returned a response that could not be read${tid ? ` (Intuit reference ${tid})` : ""}.`,
    );
  }
  if (tid) parsed.__intuit_tid = tid;
  return parsed;
}

/**
 * The ONLY write path to QuickBooks.
 *
 * Every guard lives here so there is exactly one place to audit:
 *
 *  1. The company file must have write_enabled = true, set by an administrator
 *     through /api/admin/enable-writes with a stated reason and a named
 *     authoriser, and logged.
 *  2. The operation must be in the file's write_scope. A file enabled for
 *     set_invoice_number cannot create bills, and vice versa. Scope is granted
 *     per file, per operation, by an administrator, and logged.
 *  3. Only entities on the allow-list may be written (Bill).
 *  4. UPDATE: sparse only, with the SyncToken just read, so a concurrent edit
 *     in QuickBooks conflicts instead of being overwritten, and omitted fields
 *     are never nulled.
 *  5. CREATE: no Id or SyncToken may be present — a create that carries an Id
 *     is an update in disguise. The caller (lib/bills.ts) owns the duplicate
 *     guard, total check and post-write verification.
 */
export type WriteScope = "set_invoice_number" | "create_bill";
const WRITABLE_ENTITIES = new Set(["bill"]);

export function hasScope(realm: Realm, scope: WriteScope) {
  return realm.write_enabled && Array.isArray(realm.write_scope) && realm.write_scope.includes(scope);
}

export function scopeError(realm: Realm, scope: WriteScope) {
  if (!realm.write_enabled)
    return `Writes are not enabled for ${realm.label}. An administrator must enable them for this company file before anything can be changed in QuickBooks.`;
  return `${realm.label} is not enabled for "${scope}". Enabled scopes: ${
    (realm.write_scope ?? []).join(", ") || "none"
  }. An administrator must grant this scope for the company file; it is a logged decision under charter ${PROJECT_CODE}.`;
}

export async function qboPost(
  realm: Realm,
  entity: string,
  payload: Record<string, unknown>,
  operator: string,
  op: { scope: WriteScope; mode: "update" | "create" },
) {
  if (!hasScope(realm, op.scope)) throw new Error(scopeError(realm, op.scope));
  if (!WRITABLE_ENTITIES.has(entity.toLowerCase())) {
    throw new Error(`${entity} is not on the authorised write list.`);
  }
  if (op.mode === "update") {
    if (!payload.Id || !payload.SyncToken) {
      throw new Error("Refusing to write without an Id and the SyncToken just read.");
    }
    if (payload.sparse !== true) {
      throw new Error("Refusing a non-sparse update: it would null unlisted fields.");
    }
  } else {
    if (payload.Id || payload.SyncToken) {
      throw new Error("Refusing a create that carries an Id or SyncToken.");
    }
    if (!Array.isArray(payload.Line) || !(payload.Line as unknown[]).length) {
      throw new Error("Refusing to create a bill with no lines.");
    }
  }
  if (!realm.realm_id) throw new Error(`${realm.label} is not authorised.`);

  const token = await accessToken(realm);
  const url = `${QBO_BASE()}/v3/company/${realm.realm_id}/${entity.toLowerCase()}?minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await res.text();
  const tid = res.headers.get("intuit_tid") ?? null;

  if (!res.ok) {
    await audit({
      realm: realm.id,
      kind: "error",
      operator,
      tool: op.scope,
      entity,
      entity_id: payload.Id ? String(payload.Id) : undefined,
      outcome: `write_http_${res.status}`,
      detail: { intuit_tid: tid, mode: op.mode, payload, body: body.slice(0, 800) },
    });
    const ref = tid ? ` (Intuit reference ${tid})` : "";
    if (res.status === 401)
      throw new Error(`QuickBooks rejected the credentials for ${realm.label}.${ref}`);
    if (body.includes("Stale Object") || body.includes("stale"))
      throw new Error(
        `This bill was changed in QuickBooks since it was read. Nothing was written. Re-run the match and try again.${ref}`,
      );
    if (body.includes("Duplicate Document Number") || body.includes("6140"))
      throw new Error(
        `QuickBooks refused: a bill with that document number already exists for this vendor (fault 6140). Nothing was written.${ref}`,
      );
    throw new Error(`QuickBooks refused the change (${res.status}): ${body.slice(0, 300)}${ref}`);
  }
  const parsed = JSON.parse(body);
  if (tid) parsed.__intuit_tid = tid;
  return parsed;
}

/**
 * Company preferences — used to detect directly whether multicurrency and
 * class/location tracking are enabled, rather than inferring it from the data.
 */
export async function getPreferences(realm: Realm, operator?: string) {
  const data = await qboQuery(realm, "select * from Preferences", operator);
  const p = data?.Preferences?.[0] ?? {};
  return {
    multicurrency: Boolean(p?.CurrencyPrefs?.MultiCurrencyEnabled),
    home_currency: p?.CurrencyPrefs?.HomeCurrency?.value ?? null,
    class_tracking: Boolean(p?.AccountingInfoPrefs?.ClassTrackingPerTxnLine ||
                            p?.AccountingInfoPrefs?.ClassTrackingPerTxn),
    location_tracking: Boolean(p?.AccountingInfoPrefs?.TrackDepartments),
    using_sales_tax: Boolean(p?.TaxPrefs?.UsingSalesTax),
  };
}

export async function qboQuery(realm: Realm, sql: string, operator?: string) {
  const data = await qboGet(realm, `query?query=${encodeURIComponent(sql)}`, operator);
  return data?.QueryResponse ?? {};
}

/** Page through a QuickBooks query. QBO caps a single response at 1000 rows. */
export async function qboQueryAll(
  realm: Realm,
  select: string,
  entity: string,
  operator?: string,
  cap = 2000,
) {
  const out: any[] = [];
  let start = 1;
  const page = 500;
  while (out.length < cap) {
    const q = `${select} STARTPOSITION ${start} MAXRESULTS ${page}`;
    const r = await qboQuery(realm, q, operator);
    const rows = r?.[entity] ?? [];
    out.push(...rows);
    if (rows.length < page) break;
    start += page;
  }
  return out;
}

/* ------------------------------------------------------------------ users */

export type ConnectorUser = {
  id: string;
  full_name: string;
  email: string;
  role: "reader" | "approver" | "admin";
};

export async function userFromToken(token: string): Promise<ConnectorUser | null> {
  if (!token || token.length < 20) return null;
  const rows = await db.select(
    "connector_user",
    `token_hash=eq.${sha256(token)}&active=is.true&select=id,full_name,email,role`,
  );
  if (!rows?.length) return null;
  db.update("connector_user", `id=eq.${rows[0].id}`, {
    last_seen_at: new Date().toISOString(),
  }).catch(() => {});
  return rows[0];
}

/* ----------------------------------------------------------------- format */

export const money = (n: number | null | undefined, ccy = "") =>
  n === null || n === undefined
    ? "—"
    : `${n < 0 ? "-" : ""}${Math.abs(n).toLocaleString("en-CA", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}${ccy ? " " + ccy : ""}`;

export function table(rows: Record<string, unknown>[], cols?: string[]): string {
  if (!rows.length) return "_No rows._";
  const keys = cols ?? Object.keys(rows[0]);
  const head = `| ${keys.join(" | ")} |`;
  const rule = `| ${keys.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${keys.map((k) => String(r[k] ?? "")).join(" | ")} |`)
    .join("\n");
  return [head, rule, body].join("\n");
}
