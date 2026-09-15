/** Server-rendered pages for sign-in and account setup. No client JS. */

export const BRAND = process.env.APP_BRAND ?? "Proactive PSC · QuickBooks Connector";
export const PROJECT_CODE = process.env.APP_PROJECT_CODE ?? "QBO-02";

const CSS = `
:root{--navy:#1F3557;--grey:#5A6472;--rule:#C9D2DC;--bg:#F6F8FA;--body:#222;--err:#A33A2B;--ok:#2E6B3A}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:440px;margin:56px auto;padding:32px 28px;background:#fff;border:1px solid var(--rule);border-radius:10px}
h1{font-size:20px;color:var(--navy);margin:0 0 4px}
.sub{color:var(--grey);font-size:13px;margin:0 0 22px;padding-bottom:14px;border-bottom:2px solid var(--navy)}
label{display:block;font-size:13px;color:var(--grey);margin:14px 0 4px}
input[type=text],input[type=email],input[type=password]{width:100%;padding:10px 12px;font-size:16px;border:1px solid var(--rule);border-radius:6px}
button{margin-top:20px;width:100%;padding:11px;font-size:16px;background:var(--navy);color:#fff;border:0;border-radius:6px;cursor:pointer}
.note{background:#FBF3E4;border-left:4px solid var(--navy);padding:10px 14px;margin:16px 0;font-size:14px}
.err{background:#FBE9E5;border-left:4px solid var(--err);padding:10px 14px;margin:16px 0;font-size:14px}
.ok{background:#E8F4EA;border-left:4px solid var(--ok);padding:10px 14px;margin:16px 0;font-size:14px}
code{background:#EEF2F6;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
footer{margin-top:24px;color:var(--grey);font-size:12px}
small{color:var(--grey)}
`;

export function page(title: string, body: string, status = 200, extraHeaders: Record<string, string> = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · ${BRAND}</title><style>${CSS}</style></head>
<body><main><h1>${title}</h1><p class="sub">${BRAND}</p>${body}
<footer>Proactive Supply Chain Group · Internal application (${PROJECT_CODE}). Access is restricted to authorised Proactive staff. Enquiries: michael@proactivegroup.ca</footer></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    },
  });
}
