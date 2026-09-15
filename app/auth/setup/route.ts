/**
 * Set or reset a password from a one-time link issued by the project owner.
 * Optionally enrol an authenticator app at the same time (required if the
 * account has mfa_required).
 */
import { consumeSetupToken, esc, markSetupTokenUsed, newTotpSecret, otpauthUri, passwordProblems, pendingTotpSecret, setPassword, verifyTotp } from "@/lib/auth";
import { audit } from "@/lib/core";
import { BRAND, page } from "@/lib/html";
export const dynamic = "force-dynamic";

function form(token: string, email: string, opts: { error?: string; mfaRequired: boolean; secret: string }) {
  const uri = otpauthUri(opts.secret, email, BRAND.split("·")[0].trim());
  return page(
    "Set your password",
    `${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
     <p>Account: <strong>${esc(email)}</strong></p>
     <form method="post" action="/auth/setup">
       <input type="hidden" name="token" value="${esc(token)}">
       <label for="p1">New password <small>(12+ characters, upper and lower case, a number)</small></label>
       <input id="p1" name="password" type="password" required autocomplete="new-password" minlength="12">
       <label for="p2">Repeat password</label>
       <input id="p2" name="password2" type="password" required autocomplete="new-password" minlength="12">

       <div class="note"><strong>Authenticator app${opts.mfaRequired ? " (required for your role)" : " (optional, recommended)"}.</strong>
       In Microsoft Authenticator, Google Authenticator or 1Password, add an account and enter this key manually:
       <p><code>${esc(opts.secret.replace(/(.{4})/g, "$1 ").trim())}</code></p>
       On a phone you can <a href="${esc(uri)}">tap here</a> to add it directly. Then enter the 6-digit code it shows.</div>
       <label for="totp">6-digit code${opts.mfaRequired ? "" : " — leave blank to skip"}</label>
       <input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" ${opts.mfaRequired ? "required" : ""}>
       <button type="submit">Save</button>
     </form>`,
    opts.error ? 400 : 200,
  );
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const t = token ? await consumeSetupToken(token) : null;
  if (!t) return page("Link not valid", `<div class="err">This set-up link has expired or was already used.</div><p>Ask the project owner for a new one.</p>`, 400);
  const secret = await pendingTotpSecret(token, newTotpSecret());
  return form(token, t.user.email, { mfaRequired: t.user.mfa_required, secret });
}

export async function POST(req: Request) {
  const fd = await req.formData();
  const token = String(fd.get("token") ?? "");
  const t = token ? await consumeSetupToken(token) : null;
  if (!t) return page("Link not valid", `<div class="err">This set-up link has expired or was already used.</div>`, 400);

  const p1 = String(fd.get("password") ?? "");
  const p2 = String(fd.get("password2") ?? "");
  const secret = await pendingTotpSecret(token);
  const totp = String(fd.get("totp") ?? "").trim();

  const problems = passwordProblems(p1);
  if (problems.length) return form(token, t.user.email, { error: `Password needs ${problems.join(", ")}.`, mfaRequired: t.user.mfa_required, secret });
  if (p1 !== p2) return form(token, t.user.email, { error: "The two passwords do not match.", mfaRequired: t.user.mfa_required, secret });
  if (t.user.mfa_required && !totp) return form(token, t.user.email, { error: "An authenticator code is required for your role.", mfaRequired: true, secret });
  if (totp && !verifyTotp(secret, totp)) return form(token, t.user.email, { error: "That authenticator code did not match. Check the key was entered correctly and try the current code.", mfaRequired: t.user.mfa_required, secret });

  await setPassword(t.user.id, p1, totp ? secret : undefined);
  await markSetupTokenUsed(token);
  await audit({ kind: "auth", operator: t.user.email, tool: "set_password", outcome: t.purpose, detail: { mfa_enrolled: Boolean(totp) } });

  return page(
    "Password saved",
    `<div class="ok">Your password is set${totp ? " and your authenticator app is enrolled" : ""}.</div>
     <p>Go back to Claude, open <strong>Settings → Connectors</strong>, and click <strong>Connect</strong> on the QuickBooks connector. Sign in with <strong>${esc(t.user.email)}</strong> and the password you just chose.</p>
     <p><small>You can close this window.</small></p>`,
  );
}
