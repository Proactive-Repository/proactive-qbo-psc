import { PROJECT_CODE } from "@/lib/brand";
export default function Eula() {
  return (
    <>
      <h1>Terms of Use</h1>
      <p className="sub">Proactive QuickBooks Connector · Last updated September 2026</p>

      <h2>1. Scope</h2>
      <p>
        This application is provided by Proactive Supply Chain Group for the internal use of its
        own employees and authorised contractors. It is not licensed, sold or made available to
        any third party.
      </p>

      <h2>2. Permitted use</h2>
      <p>
        Authorised users may use the application to enter approved supplier invoices as bills in
        Proactive&rsquo;s QuickBooks Online company files, and to reconcile carrier invoices
        against recorded bills. Any other use, including
        sharing credentials or accessing company files outside a user&rsquo;s role, is prohibited.
      </p>

      <h2>3. Scope of access</h2>
      <p>
        The application reads vendors, bills, the chart of accounts and tax codes from the
        QuickBooks Online company files it has been authorised against. On a company file where an
        administrator has explicitly enabled the operation, it may (a) set the document number and
        memo on an existing bill, and (b) create a vendor bill from an approved supplier invoice
        &mdash; in each case one record at a time, confirmed by a person, and logged in full.
      </p>
      <p>
        It does not void or delete records, does not change an existing bill&rsquo;s amount,
        vendor or account, and cannot initiate a payment of any kind. Extending this scope requires
        written approval from the executive sponsor of project {PROJECT_CODE} and a corresponding
        disclosure to Intuit.
      </p>

      <h2>4. Accountability</h2>
      <p>
        Every action is logged against the individual who performed it. Users are responsible for
        the confidentiality of their credential and must report any suspected compromise
        immediately.
      </p>

      <h2>5. No warranty</h2>
      <p>
        The application supports the work of qualified finance staff; it does not replace their
        judgement. Reconciliation output is a proposal for human review. Proactive accepts no
        liability for decisions taken without that review.
      </p>

      <h2>6. Termination</h2>
      <p>
        Access may be withdrawn at any time, without notice, at Proactive&rsquo;s discretion, and
        is withdrawn automatically when a user leaves the relevant role.
      </p>

      <h2>7. Governing law</h2>
      <p>These terms are governed by the laws of the Province of Ontario, Canada.</p>
    </>
  );
}
