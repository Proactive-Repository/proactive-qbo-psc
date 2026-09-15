/**
 * Division branding. One codebase serves every Proactive division; each Vercel
 * project sets these. Defaults are PSC so the existing deployment is unchanged.
 *
 *   APP_LABEL          short label, also the qbo_realm.label   e.g. PSL
 *   APP_DIVISION_NAME  legal name shown to Intuit and users     e.g. Proactive Specialized Logistics Inc.
 *   APP_PROJECT_CODE   charter code                             e.g. QBO-03
 */
export const LABEL = process.env.APP_LABEL ?? "PSC";
export const DIVISION = process.env.APP_DIVISION_NAME ?? "Proactive Supply Chain Solutions Inc.";
export const PROJECT_CODE = process.env.APP_PROJECT_CODE ?? "QBO-02";
export const BRAND = process.env.APP_BRAND ?? `Proactive ${LABEL} · QuickBooks Connector`;
export const SERVER_NAME = `proactive-qbo-${LABEL.toLowerCase()}`;
