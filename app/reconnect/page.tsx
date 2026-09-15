export const dynamic = "force-dynamic";

export default function Reconnect() {
  return (
    <>
      <h1>Connecting or reconnecting a company file</h1>
      <p className="sub">Proactive PSC QuickBooks Connector · Project QBO-02</p>

      <p>
        This application is connected to a QuickBooks company file by a QuickBooks administrator,
        using an authorisation link issued by the project owner. It cannot be connected from this
        page, and it cannot be connected by anyone who is not an administrator of the company
        file.
      </p>

      <div className="note">
        That is deliberate. Authorising access to a set of books is an administrative act, so it
        requires an administrator and a link issued for the purpose — not a public button.
      </div>

      <h2>If a company file has been disconnected</h2>
      <ol>
        <li>
          Contact the project owner:{" "}
          <a href="mailto:michael@proactivegroup.ca">michael@proactivegroup.ca</a>
        </li>
        <li>
          You will be sent an authorisation link for that specific company file.
        </li>
        <li>
          Open it while signed in to QuickBooks Online as an administrator of that company, and
          approve.
        </li>
      </ol>

      <p>
        Reconnecting the same company file restores access. Pointing a company file at a
        different set of books is refused by the application and has to be reset by an
        administrator first, which is logged.
      </p>

      <h2>If you are an accounting user</h2>
      <p>
        You do not need to connect a company file. In Claude, click <strong>Connect</strong> on
        the QuickBooks connector and sign in with your own Proactive connector email and password.
        If a tool reports that a company file is not connected, contact the project owner.
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
    </>
  );
}
