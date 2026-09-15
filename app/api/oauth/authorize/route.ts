/**
 * Authorization endpoint. GET renders the sign-in page; POST checks the
 * person's credentials and, if they are an authorised Proactive user, sends an
 * authorization code back to Claude. PKCE (S256) is mandatory.
 */
import { clientIp, esc, getClient, issueCode, login } from "@/lib/auth";
import { audit } from "@/lib/core";
import { page } from "@/lib/html";
export const dynamic = "force-dynamic";

type Params = {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string;
};

function pick(src: URLSearchParams | FormData): Params {
  const g = (k: string) => String(src.get(k) ?? "");
  return {
    response_type: g("response_type"),
    client_id: g("client_id"),
    redirect_uri: g("redirect_uri"),
    state: g("state"),
    code_challenge: g("code_challenge"),
    code_challenge_method: g("code_challenge_method"),
    scope: g("scope"),
    resource: g("resource"),
  };
}

async function validate(p: Params): Promise<string | null> {
  if (p.response_type !== "code") return "response_type must be code";
  if (!p.client_id) return "client_id missing";
  const c = await getClient(p.client_id);
  if (!c) return "unknown client_id — Claude needs to register first";
  if (!p.redirect_uri || !c.redirect_uris.includes(p.redirect_uri)) return "redirect_uri is not registered for this client";
  if (!p.code_challenge || p.code_challenge_method !== "S256") return "PKCE S256 code_challenge is required";
  return null;
}

function hidden(p: Params) {
  return (Object.keys(p) as (keyof Params)[])
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`)
    .join("");
}

function form(p: Params, opts: { error?: string; email?: string; mfa?: boolean }) {
  return page(
    "Sign in",
    `${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
     <p>Claude is asking to use the QuickBooks connector <strong>as you</strong>. Sign in with the email and password issued to you by Proactive. Every action you take through Claude is recorded under your name.</p>
     <form method="post" action="/api/oauth/authorize" autocomplete="on">
       ${hidden(p)}
       <label for="email">Work email</label>
       <input id="email" name="email" type="email" required autocomplete="username" value="${esc(opts.email ?? "")}">
       <label for="password">Password</label>
       <input id="password" name="password" type="password" required autocomplete="current-password">
       ${
         opts.mfa
           ? `<label for="totp">Authenticator code</label>
              <input id="totp" name="totp" type="text" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" required>`
           : `<input type="hidden" name="totp" value="">`
       }
       <button type="submit">Sign in and allow Claude</button>
     </form>
     <p><small>Forgotten your password or need an account? Contact <a href="mailto:michael@proactivegroup.ca">michael@proactivegroup.ca</a>. There is no self-service reset by design.</small></p>`,
    opts.error ? 401 : 200,
  );
}

export async function GET(req: Request) {
  const p = pick(new URL(req.url).searchParams);
  const problem = await validate(p);
  if (problem) return page("Cannot sign in", `<div class="err">${esc(problem)}</div><p>Close this window and try connecting again from Claude.</p>`, 400);
  return form(p, {});
}

export async function POST(req: Request) {
  const fd = await req.formData();
  const p = pick(fd);
  const problem = await validate(p);
  if (problem) return page("Cannot sign in", `<div class="err">${esc(problem)}</div>`, 400);

  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const totp = String(fd.get("totp") ?? "").trim() || undefined;

  const r = await login(email, password, totp, clientIp(req));
  if (!r.ok) {
    const msg: Record<string, string> = {
      invalid: "That email and password were not recognised.",
      locked: "Too many failed attempts. This account is locked for 15 minutes.",
      inactive: "That email and password were not recognised.",
      setup_required: "That email and password were not recognised. If you have not set your password yet, or your role requires an authenticator app you have not enrolled, use the set-up link you were sent or ask the project owner for a new one.",
      mfa_required: "Enter the 6-digit code from your authenticator app.",
      mfa_invalid: "That authenticator code was not accepted.",
    };
    return form(p, { error: msg[r.reason], email, mfa: r.reason === "mfa_required" || r.reason === "mfa_invalid" });
  }

  const code = await issueCode({
    user_id: r.user.id,
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    scope: p.scope || "qbo",
    resource: p.resource || null,
  });
  await audit({ kind: "auth", operator: r.user.email, tool: "oauth_authorize", outcome: "code_issued", detail: { client_id: p.client_id } });

  const to = new URL(p.redirect_uri);
  to.searchParams.set("code", code);
  if (p.state) to.searchParams.set("state", p.state);
  return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
}
