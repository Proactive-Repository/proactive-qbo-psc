-- New division: run schema.sql, then migration_002_login.sql, then this (edit the three values).
-- The seed in schema.sql inserts PSC; delete it for a non-PSC division:
delete from qbo_realm where label = 'PSC' and realm_id is null;

insert into qbo_realm (label, environment, country, home_currency, status, write_enabled, write_scope, notes)
values ('PSL', 'production', 'CA', 'CAD', 'pending', false, '{}',
        'Proactive Specialized Logistics. Intuit app "PSL Oauth". Consent by the PSL QuickBooks admin.')
on conflict (label) do nothing;
