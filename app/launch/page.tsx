export const dynamic = "force-dynamic";

export default function Launch() {
  return (
    <>
      <h1>Proactive QuickBooks Connector</h1>
      <p className="sub">Internal application · Project QBO-02 (PSC)</p>

      <p>
        This application has no user interface of its own. Authorised Proactive accounting staff
        use it from within Claude, where it appears as a set of QuickBooks tools.
      </p>

      <h2>If you are a QuickBooks administrator</h2>
      <p>
        To authorise a company file, use the connect link issued to you by the project owner. Each
        company file is authorised separately.
      </p>

      <h2>If you are an accounting user</h2>
      <p>
        You do not need to sign in here. Your connector was added to your Claude account by the
        project owner. Ask in Claude, for example: <em>&ldquo;show me open reconciliation
        exceptions for PSC&rdquo;</em> or upload an approved supplier invoice and ask for it to be
        entered as a bill.
      </p>

      <div className="note">
        <strong>Scope.</strong> This connector reads your QuickBooks data and, where an
        administrator has enabled it, can set the document number and memo on a bill or create a
        vendor bill from an approved invoice — always showing you the exact record first, and
        only posting when you say &ldquo;post to qbo&rdquo;.
      </div>

      <p>
        Support: <a href="mailto:michael@proactivegroup.ca">michael@proactivegroup.ca</a>
      </p>
    </>
  );
}
