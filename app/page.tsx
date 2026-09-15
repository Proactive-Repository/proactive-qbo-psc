import { DIVISION, LABEL, PROJECT_CODE } from "@/lib/brand";
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <>
      <h1>Proactive {LABEL} QuickBooks Connector</h1>
      <p className="sub">
        Internal application · {DIVISION} ({LABEL}) · Project {PROJECT_CODE}
      </p>

      <p>
        This application connects Proactive Supply Chain Group&rsquo;s own QuickBooks Online
        company file for {DIVISION} ({LABEL}) to Proactive&rsquo;s internal
        finance tooling. It is used by {LABEL} accounting staff to enter approved supplier invoices as
        bills in QuickBooks, and to reconcile carrier invoices against recorded bills.
      </p>

      <div className="note">
<strong>Scope.</strong> This application reads vendors, bills, the chart of accounts and
        tax codes. On a company file where an administrator has explicitly enabled it, it can do two
        things: (a) set the document number and memo on an existing bill, and (b) <strong>create a
        vendor bill</strong> from a supplier invoice that a Proactive accounting user has read,
        coded to a GL account and confirmed in chat &mdash; one record at a time, duplicate-checked,
        with the full bill logged. It cannot void or delete records, cannot change an existing
        bill&rsquo;s amount or vendor, and cannot initiate a payment of any kind.
      </div>

      <h2>Who can use it</h2>
      <p>
        Named Proactive employees only. Each user holds an individual credential, every action is
        logged against that person, and access is withdrawn when they leave the role. This is not
        a public service and is not offered to third parties.
      </p>

      <h2>What it accesses</h2>
      <p>
        Vendors, bills, the chart of accounts, tax codes and exchange rates on the Proactive
        company files that a QuickBooks administrator has explicitly authorised. Nothing else. No
        employee, payroll or banking data is read.
      </p>

      <h2>Links</h2>
      <ul>
        <li>
          <a href="/privacy">Privacy policy</a>
        </li>
        <li>
          <a href="/eula">Terms of use</a>
        </li>
        <li>
          <a href="/disconnect">Disconnecting a company file</a>
        </li>
      </ul>
    </>
  );
}
