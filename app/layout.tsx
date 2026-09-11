export const metadata = {
  title: "Proactive PSC · QuickBooks Connector",
  description:
    "Internal QuickBooks Online connector for Proactive Supply Chain Solutions (PSC). Not a public service.",
};

const css = `
:root{--navy:#1F3557;--grey:#5A6472;--rule:#C9D2DC;--bg:#ffffff;--body:#222}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 24px 80px}
h1{font-size:26px;color:var(--navy);margin:0 0 4px}
h2{font-size:17px;color:var(--navy);margin:32px 0 8px}
.sub{color:var(--grey);font-size:14px;margin:0 0 28px;padding-bottom:20px;border-bottom:2px solid var(--navy)}
p,li{font-size:15px}
code{background:#EEF2F6;padding:2px 6px;border-radius:4px;font-size:13px}
.note{background:#FBF3E4;border-left:4px solid var(--navy);padding:14px 18px;margin:20px 0;font-size:14px}
a{color:var(--navy)}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--rule);color:var(--grey);font-size:13px}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <main>
          {children}
          <footer>
            Proactive Supply Chain Group · Internal application (QBO-02, PSC). Access is restricted to
            authorised Proactive staff. Enquiries: michael@proactivegroup.ca
          </footer>
        </main>
      </body>
    </html>
  );
}
