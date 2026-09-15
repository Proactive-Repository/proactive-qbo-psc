/**
 * Connector sign-in (QBO-02).
 *
 * The connector is an OAuth 2.1 authorization server for exactly one client
 * type: Claude. Claude discovers it through RFC 9728 / RFC 8414 metadata,
 * registers itself (RFC 7591), sends the person to /api/oauth/authorize, and
 * the person signs in with the email and password Proactive issued them.
 * Every subsequent MCP call carries a bearer access token that resolves to
 * that person, which is what makes the audit log true.
 *
 * Passwords: scrypt (node:crypto), per-user salt, never logged.
 * MFA: RFC 6238 TOTP, optional per user (mfa_required), secret AES-encrypted.
 * Tokens: opaque random strings; only SHA-256 hashes are stored.
 * Lockout: 8 failed attempts locks the account for 15 minutes.
 *
 * Nothing in this file touches QuickBooks.
 */
import crypto from "node:crypto";
import { ConnectorUser, audit, db, decrypt, encrypt, sha256 } from "./core";

/* ------------------------------------------------------------ constants */

export const ACCESS_TOKEN_TTL_S = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 days
export const AUTH_CODE_TTL_S = 5 * 60;
export const SETUP_LINK_TTL_S = 24 * 60 * 60;
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

/** Redirect URIs Claude uses. Anything else is refused at registration. */
const ALLOWED_REDIRECT_HOSTS = [/\.claude\.ai$/, /^claude\.ai$/, /\.claude\.com$/, /^claude\.com$/, /\.anthropic\.com$/];

export const rand = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/* ------------------------------------------------------------ passwords */

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const hash = crypto.scryptSync(pw.normalize("NFKC"), salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [alg, nStr, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const got = crypto.scryptSync(pw.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(nStr),
    r: 8,
    p: 1,
  });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export function passwordProblems(pw: string): string[] {
  const p: string[] = [];
  if (pw.length < 12) p.push("at least 12 characters");
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) p.push("upper and lower case letters");
  if (!/[0-9]/.test(pw)) p.push("a number");
  return p;
}

/* ----------------------------------------------------------------- TOTP */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0,
    value = 0,
    out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secretB32: string, step = 30, t = Date.now()): string {
  const counter = Math.floor(t / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const o = h[19] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secretB32: string, code: string): boolean {
  const c = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  for (const skew of [-1, 0, 1]) {
    if (totpCode(secretB32, 30, Date.now() + skew * 30_000) === c) return true;
  }
  return false;
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function otpauthUri(secretB32: string, email: string, issuer: string) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------------------------------------------------------------- users */

export type AuthUser = ConnectorUser & {
  password_hash: string | null;
  totp_secret_enc: string | null;
  mfa_required: boolean;
  must_set_password: boolean;
  failed_attempts: number;
  locked_until: string | null;
  active: boolean;
};

export async function userByEmail(email: string): Promise<AuthUser | null> {
  const rows = await db.select(
    "connector_user",
    `email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=id,full_name,email,role,password_hash,totp_secret_enc,mfa_required,must_set_password,failed_attempts,locked_until,active`,
  );
  return rows?.[0] ?? null;
}

export type LoginResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: "invalid" | "locked" | "inactive" | "mfa_required" | "mfa_invalid" | "setup_required" };

export async function login(email: string, password: string, totp: string | undefined, ip: string | null): Promise<LoginResult> {
  const u = await userByEmail(email);
  type FailReason = Extract<LoginResult, { ok: false }>["reason"];
  const fail = async (reason: FailReason, bump = true): Promise<LoginResult> => {
    if (u && bump) {
      const lockExpired = u.locked_until && new Date(u.locked_until).getTime() <= Date.now();
      const attempts = lockExpired ? 1 : (u.failed_attempts ?? 0) + 1;
      const patch: Record<string, unknown> = { failed_attempts: attempts };
      patch.locked_until = attempts >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
      await db.update("connector_user", `id=eq.${u.id}`, patch).catch(() => {});
    }
    await audit({ kind: "auth", operator: email.toLowerCase(), tool: "login", outcome: `failed_${reason}`, detail: { ip } });
    return { ok: false as const, reason };
  };

  if (!u) return fail("invalid", false);
  if (!u.active) return fail("inactive", false);
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) return fail("locked", false);
  if (!u.password_hash || u.must_set_password) return fail("setup_required", false);
  if (!verifyPassword(password, u.password_hash)) return fail("invalid");
  if (u.mfa_required || u.totp_secret_enc) {
    if (!u.totp_secret_enc) return fail("setup_required", false);
    if (!totp) return { ok: false, reason: "mfa_required" };
    if (!verifyTotp(decrypt(u.totp_secret_enc), totp)) return fail("mfa_invalid");
  }
  await db.update("connector_user", `id=eq.${u.id}`, {
    failed_attempts: 0,
    locked_until: null,
    last_seen_at: new Date().toISOString(),
  }).catch(() => {});
  await audit({ kind: "auth", operator: u.email, tool: "login", outcome: "ok", detail: { ip, mfa: Boolean(u.totp_secret_enc) } });
  return { ok: true, user: u };
}

/* -------------------------------------------------------- setup links */

export async function issueSetupLink(userId: string, baseUrl: string, purpose: "setup" | "reset") {
  const token = rand(32);
  await db.insert("auth_setup_token", {
    user_id: userId,
    token_hash: sha256(token),
    purpose,
    expires_at: new Date(Date.now() + SETUP_LINK_TTL_S * 1000).toISOString(),
  });
  return `${baseUrl}/auth/setup?token=${token}`;
}

export async function consumeSetupToken(token: string): Promise<{ user: AuthUser; purpose: string } | null> {
  const rows = await db.select(
    "auth_setup_token",
    `token_hash=eq.${sha256(token)}&consumed_at=is.null&select=id,user_id,purpose,expires_at`,
  );
  const t = rows?.[0];
  if (!t || new Date(t.expires_at).getTime() < Date.now()) return null;
  const users = await db.select(
    "connector_user",
    `id=eq.${t.user_id}&select=id,full_name,email,role,password_hash,totp_secret_enc,mfa_required,must_set_password,failed_attempts,locked_until,active`,
  );
  if (!users?.[0]?.active) return null;
  return { user: users[0], purpose: t.purpose };
}

/** The TOTP secret offered on the set-up page is generated and held server-side, keyed by the link. */
export async function pendingTotpSecret(token: string, fresh?: string): Promise<string> {
  const q = `token_hash=eq.${sha256(token)}`;
  const rows = await db.select("auth_setup_token", `${q}&select=pending_totp_secret_enc`);
  const existing = rows?.[0]?.pending_totp_secret_enc;
  if (existing) return decrypt(existing);
  const secret = fresh ?? newTotpSecret();
  await db.update("auth_setup_token", q, { pending_totp_secret_enc: encrypt(secret) });
  return secret;
}

export async function markSetupTokenUsed(token: string) {
  await db.update("auth_setup_token", `token_hash=eq.${sha256(token)}`, { consumed_at: new Date().toISOString() });
}

export async function setPassword(userId: string, password: string, totpSecret?: string) {
  const patch: Record<string, unknown> = {
    password_hash: hashPassword(password),
    must_set_password: false,
    failed_attempts: 0,
    locked_until: null,
    password_set_at: new Date().toISOString(),
  };
  if (totpSecret) patch.totp_secret_enc = encrypt(totpSecret);
  await db.update("connector_user", `id=eq.${userId}`, patch);
}

/* -------------------------------------------------- OAuth: clients (DCR) */

export type OAuthClient = { client_id: string; client_secret_hash: string | null; redirect_uris: string[]; client_name: string | null };

export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:") return false;
    return ALLOWED_REDIRECT_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export async function registerClient(meta: any): Promise<{ client_id: string; client_secret?: string; redirect_uris: string[]; client_name: string | null }> {
  const uris: string[] = Array.isArray(meta?.redirect_uris) ? meta.redirect_uris.map(String) : [];
  if (!uris.length || !uris.every(redirectAllowed)) {
    throw Object.assign(new Error("redirect_uris must be https URLs on claude.ai / claude.com / anthropic.com"), {
      oauth: "invalid_redirect_uri",
    });
  }
  const client_id = rand(24);
  const wantsSecret = meta?.token_endpoint_auth_method && meta.token_endpoint_auth_method !== "none";
  const client_secret = wantsSecret ? rand(32) : undefined;
  await db.insert("oauth_client", {
    client_id,
    client_secret_hash: client_secret ? sha256(client_secret) : null,
    redirect_uris: uris,
    client_name: meta?.client_name ? String(meta.client_name).slice(0, 120) : null,
    metadata: meta ?? null,
  });
  await audit({ kind: "auth", tool: "oauth_register", outcome: "ok", detail: { client_id, client_name: meta?.client_name ?? null, redirect_uris: uris } });
  return { client_id, client_secret, redirect_uris: uris, client_name: meta?.client_name ?? null };
}

export async function getClient(client_id: string): Promise<OAuthClient | null> {
  const rows = await db.select("oauth_client", `client_id=eq.${encodeURIComponent(client_id)}&select=client_id,client_secret_hash,redirect_uris,client_name`);
  return rows?.[0] ?? null;
}

/* ------------------------------------------------------ OAuth: codes */

export async function issueCode(p: {
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
}) {
  const code = rand(32);
  await db.insert("oauth_code", {
    code_hash: sha256(code),
    user_id: p.user_id,
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    scope: p.scope,
    resource: p.resource,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_S * 1000).toISOString(),
  });
  return code;
}

export async function redeemCode(code: string, client_id: string, redirect_uri: string, code_verifier: string) {
  const rows = await db.select("oauth_code", `code_hash=eq.${sha256(code)}&select=*`);
  const c = rows?.[0];
  if (!c) return { error: "invalid_grant", description: "unknown code" };
  // single use: mark consumed first so a replay races to a failure
  if (c.consumed_at) return { error: "invalid_grant", description: "code already used" };
  const claimed = await db.update("oauth_code", `id=eq.${c.id}&consumed_at=is.null`, { consumed_at: new Date().toISOString() });
  if (!Array.isArray(claimed) || !claimed.length) return { error: "invalid_grant", description: "code already used" };
  if (new Date(c.expires_at).getTime() < Date.now()) return { error: "invalid_grant", description: "code expired" };
  if (c.client_id !== client_id) return { error: "invalid_grant", description: "client mismatch" };
  if (redirect_uri && c.redirect_uri !== redirect_uri) return { error: "invalid_grant", description: "redirect_uri mismatch" };
  const expected = crypto.createHash("sha256").update(code_verifier).digest("base64url");
  if (expected !== c.code_challenge) return { error: "invalid_grant", description: "PKCE verification failed" };
  return { ok: true as const, user_id: c.user_id as string, scope: c.scope as string | null, resource: c.resource as string | null };
}

/* ------------------------------------------------------ OAuth: tokens */

export async function issueTokens(user_id: string, client_id: string, scope: string | null) {
  const access = rand(32);
  const refresh = rand(32);
  const now = Date.now();
  await db.insert("oauth_token", {
    access_hash: sha256(access),
    refresh_hash: sha256(refresh),
    user_id,
    client_id,
    scope,
    access_expires_at: new Date(now + ACCESS_TOKEN_TTL_S * 1000).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_S * 1000).toISOString(),
  });
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_S, token_type: "Bearer", scope: scope ?? undefined };
}

export async function refreshTokens(refresh: string, client_id: string) {
  const rows = await db.select("oauth_token", `refresh_hash=eq.${sha256(refresh)}&revoked_at=is.null&select=*`);
  const t = rows?.[0];
  if (!t) return { error: "invalid_grant", description: "unknown refresh token" };
  if (t.client_id !== client_id) return { error: "invalid_grant", description: "client mismatch" };
  if (new Date(t.refresh_expires_at).getTime() < Date.now()) return { error: "invalid_grant", description: "refresh token expired" };
  // The user must still be active; a deactivated person's refresh stops working immediately.
  const users = await db.select("connector_user", `id=eq.${t.user_id}&active=is.true&select=id`);
  if (!users?.length) return { error: "invalid_grant", description: "user inactive" };
  // rotate — atomically, so two concurrent refreshes cannot both succeed
  const claimed = await db.update("oauth_token", `id=eq.${t.id}&revoked_at=is.null`, { revoked_at: new Date().toISOString(), rotated: true });
  if (!Array.isArray(claimed) || !claimed.length) return { error: "invalid_grant", description: "refresh token already used" };
  return { ok: true as const, ...(await issueTokens(t.user_id, client_id, t.scope)) };
}

export async function userFromBearer(header: string | null): Promise<ConnectorUser | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (token.length < 20) return null;
  const rows = await db.select(
    "oauth_token",
    `access_hash=eq.${sha256(token)}&revoked_at=is.null&select=user_id,access_expires_at`,
  );
  const t = rows?.[0];
  if (!t || new Date(t.access_expires_at).getTime() < Date.now()) return null;
  const users = await db.select("connector_user", `id=eq.${t.user_id}&active=is.true&select=id,full_name,email,role`);
  if (!users?.length) return null;
  db.update("connector_user", `id=eq.${t.user_id}`, { last_seen_at: new Date().toISOString() }).catch(() => {});
  return users[0];
}

export async function revokeToken(token: string) {
  const h = sha256(token);
  await db.update("oauth_token", `or=(access_hash.eq.${h},refresh_hash.eq.${h})`, { revoked_at: new Date().toISOString() }).catch(() => {});
}

/* ------------------------------------------------------------- helpers */

export function baseUrl(req: Request): string {
  const env = process.env.APP_BASE_URL;
  if (env) return env.replace(/\/$/, "");
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${proto}://${host}`;
}

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip");
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
