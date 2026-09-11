export default function Disconnect() {
  return (
    <>
      <h1>Disconnecting a company file</h1>
      <p className="sub">Proactive QuickBooks Connector</p>

      <p>
        A QuickBooks administrator can revoke this application&rsquo;s access to any company file
        at any time, without contacting us and without affecting any other company file.
      </p>

      <h2>How</h2>
      <ol>
        <li>Sign in to QuickBooks Online as an administrator of that company file.</li>
        <li>
          Go to <code>Settings</code> → <code>Apps</code> → <code>My Apps</code>.
        </li>
        <li>
          Find <em>Proactive QuickBooks Connector</em> and choose <code>Disconnect</code>.
        </li>
      </ol>

      <div className="note">
        Access stops immediately. Stored tokens for that company file become invalid and are
        deleted. Reconciliation history and the audit log are retained as accounting records.
      </div>

      <h2>Reconnecting</h2>
      <p>
        Reconnection requires a QuickBooks administrator to authorise the application again. No
        Proactive employee other than a QuickBooks administrator can grant access.
      </p>

      <p>
        Questions: <a href="mailto:michael@proactivegroup.ca">michael@proactivegroup.ca</a>
      </p>
    </>
  );
}
