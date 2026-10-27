-- P5.2: a business sets itself up on the brand portal. What kind of business it is (versions by
-- time: latest wins), and every GST number looked up in the GST records with what the record said
-- (so the details on an invoice can always be traced to it, and lookups can be limited).
-- Append-only (hard rule 3).

CREATE TABLE brand_profiles (
  brand_id      text        NOT NULL REFERENCES brands (brand_id),
  set_at        timestamptz NOT NULL,
  business_type text        NOT NULL CHECK (business_type IN ('food', 'retail', 'apps', 'education',
                              'health', 'real-estate', 'finance', 'auto', 'events', 'other')),
  set_by        text        NOT NULL CHECK (length(set_by) BETWEEN 1 AND 254),
  PRIMARY KEY (brand_id, set_at)
);

CREATE TABLE gst_lookups (
  id         bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gstin      text          NOT NULL CHECK (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  -- Who asked: the portal sign-in's number or email.
  asker      brand_address NOT NULL,
  status     text          NOT NULL CHECK (status IN ('found', 'not-found', 'unavailable')),
  legal_name text          CHECK (length(legal_name) <= 200),
  trade_name text          CHECK (length(trade_name) <= 200),
  state_code text          CHECK (state_code ~ '^[0-9]{2}$'),
  address    text          CHECK (length(address) <= 500),
  active     boolean,
  at         timestamptz   NOT NULL,
  CHECK ((status = 'found') = (legal_name IS NOT NULL AND state_code IS NOT NULL AND active IS NOT NULL))
);
CREATE INDEX gst_lookups_asker ON gst_lookups (asker, at DESC);
CREATE INDEX gst_lookups_gstin ON gst_lookups (gstin, at DESC);
CREATE INDEX brand_tax_profiles_gstin ON brand_tax_profiles (gstin) WHERE gstin IS NOT NULL;

CREATE TRIGGER brand_profiles_no_change BEFORE UPDATE OR DELETE ON brand_profiles
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_profiles_no_truncate BEFORE TRUNCATE ON brand_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON brand_profiles TO recall_app;
CREATE TRIGGER gst_lookups_no_change BEFORE UPDATE OR DELETE ON gst_lookups
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER gst_lookups_no_truncate BEFORE TRUNCATE ON gst_lookups
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON gst_lookups TO recall_app;

-- The audit log (0054) with business types set.
CREATE OR REPLACE VIEW audit_log AS
SELECT at, coalesce(who, '') AS who, area, action, coalesce(ref, '') AS ref,
       coalesce(detail, '') AS detail, uid
  FROM (
          SELECT at, by AS who, 'staff' AS area, CASE WHEN active THEN 'access set' ELSE 'access removed' END AS action,
                 staff_id AS ref, concat_ws(': ', role || ' ' || array_to_string(areas, ', '), reason) AS detail,
                 'staff_access:' || id AS uid
            FROM staff_access
UNION ALL SELECT added_at, added_by, 'staff', 'staff added', id, name, 'staff:' || id FROM staff
-- A refused sign-in for an email that is no member: whatever was typed is not shown.
UNION ALL SELECT at, coalesce(staff_id, 'unknown'), 'staff', CASE WHEN ok THEN 'signed in' ELSE 'sign-in refused' END,
                 coalesce(staff_id, 'not a member'), why, 'staff_sign_ins:' || id FROM staff_sign_ins
UNION ALL SELECT made_at, by, 'staff', 'invite made', staff_id, '', 'staff_invites:' || md5(token_hash) FROM staff_invites
UNION ALL SELECT saved_at, saved_by, 'areas', CASE WHEN draft THEN 'area draft saved' ELSE 'area version saved' END,
                 area_id || ' v' || version, reason, 'area_versions:' || area_id || ':' || version FROM area_versions
UNION ALL SELECT set_at, set_by, 'areas', 'hour limit set', area_id || ' ' || day || ' ' || start_hour || ':00',
                 concat_ws(': ', coalesce(max_bikes || ' bikes', 'no limit'), reason),
                 concat_ws(':', 'area_hour_limits', area_id, day, start_hour, version) FROM area_hour_limits
UNION ALL SELECT set_at, set_by, 'areas', 'supply estimate set', area_id || ' ' || start_hour || ':00',
                 bikes || ' bikes', concat_ws(':', 'area_supply_estimates', area_id, start_hour, version)
            FROM area_supply_estimates
UNION ALL SELECT saved_at, saved_by, 'prices', 'price book saved', 'v' || version, reason, 'price_books:' || version FROM price_books
UNION ALL SELECT set_at, set_by, 'business', 'business mode set', mode, reason, 'business_modes:' || from_at FROM business_modes
UNION ALL SELECT created_at, held_by, 'calendar', 'hold made', hold_id, concat_ws(': ', brand_id, reason), 'holds:' || hold_id FROM holds
UNION ALL SELECT ended_at, ended_by, 'calendar', 'hold ended', hold_id, reason, 'hold_ends:' || hold_id FROM hold_ends
UNION ALL SELECT created_at, created_by, 'brands', 'brand added', brand_id, kind, 'brands:' || brand_id FROM brands
UNION ALL SELECT set_at, set_by, 'brands', 'brand details set', brand_id || ' v' || version,
                 concat_ws(': ', name, reason), 'brand_versions:' || brand_id || ':' || version FROM brand_versions
UNION ALL SELECT at, by, 'brands', 'brand note', brand_id, '', 'brand_notes:' || id FROM brand_notes
UNION ALL SELECT set_at, set_by, 'brands', 'brand contact set', brand_id, '', 'brand_contacts:' || brand_id || ':' || set_at FROM brand_contacts
UNION ALL SELECT set_at, set_by, 'brands', 'brand tax details set', brand_id, legal_name,
                 'brand_tax_profiles:' || brand_id || ':' || set_at FROM brand_tax_profiles
UNION ALL SELECT created_at, created_by, 'bookings', 'booking made', booking_id, brand_id, 'bookings:' || booking_id FROM bookings
UNION ALL SELECT at, by_who, 'bookings', 'booking ' || state, booking_id, reason, 'booking_events:' || booking_id || ':' || seq FROM booking_events
UNION ALL SELECT at, by, 'bookings', 'booking note', booking_id, '', 'booking_notes:' || id FROM booking_notes
UNION ALL SELECT created_at, created_by, 'bookings', 'payment link sent', booking_id,
                 '₹' || to_char(amount_paise / 100.0, 'FM999999999990.00'), 'payment_links:' || link_id FROM payment_links
UNION ALL SELECT set_at, set_by, 'ads', 'ads chosen', booking_id, array_to_string(ad_ids, ', '),
                 'booking_ad_sets:' || booking_id || ':' || version FROM booking_ad_sets
UNION ALL SELECT uploaded_at, uploaded_by, 'ads', 'ad uploaded', ad_id, concat_ws(': ', brand_id, outcome), 'ads:' || ad_id FROM ads
UNION ALL SELECT reviewed_at, reviewed_by, 'ads', 'ad ' || decision, ad_id, reason, 'ad_reviews:' || ad_id FROM ad_reviews
UNION ALL SELECT decided_at, decided_by, 'money', 'refund ' || decision, refund_id, reason, 'refund_decisions:' || refund_id FROM refund_decisions
UNION ALL SELECT decided_at, decided_by, 'money', 'refund topped up', refund_id,
                 missing_plays || ' more plays missing', 'refund_topups:' || refund_id FROM refund_topups
UNION ALL SELECT decided_at, decided_by, 'money', kind || ' cut given', booking_id,
                 concat_ws(': ', partner_id || ' at ' || to_char(rate_bp / 100.0, 'FM990.00') || '%', reason),
                 'booking_cuts:' || booking_id || ':' || kind FROM booking_cuts
UNION ALL SELECT posted_at, posted_by, 'money', 'ledger: ' || kind, ref, left(memo, 200), 'ledger_entries:' || entry_id FROM ledger_entries
UNION ALL SELECT prepared_at, prepared_by, 'payouts', 'payout run prepared', run_id::text, '', 'payout_runs:' || run_id FROM payout_runs
UNION ALL SELECT approved_at, approved_by, 'payouts', 'payout run approved', run_id::text, '', 'payout_approvals:' || run_id FROM payout_approvals
UNION ALL SELECT at, by_who, 'payouts', CASE WHEN held THEN 'payout held' ELSE 'payout released' END,
                 run_id || ' ' || rider_id, reason, concat_ws(':', 'payout_holds', run_id, rider_id, seq) FROM payout_holds
UNION ALL SELECT at, by_who, 'money', 'money back: ' || status, owed_entry, reason,
                 'money_back_attempts:' || owed_entry || ':' || attempt FROM money_back_attempts
UNION ALL SELECT at, by_who, 'money', 'partner paid', kind || ' ' || partner_id,
                 concat('₹', to_char(amount_paise / 100.0, 'FM999999999990.00'), ' (', reference, ')'),
                 concat_ws(':', 'partner_payments', partner_id, kind, seq) FROM partner_payments
UNION ALL SELECT recorded_at, recorded_by, 'money', 'partner invoice recorded', partner_id, invoice_no,
                 'partner_invoices:' || partner_id || ':' || invoice_no FROM partner_invoices
UNION ALL SELECT created_at, created_by, 'riders', 'rider added', rider_id, channel, 'riders:' || rider_id FROM riders
UNION ALL SELECT set_at, set_by, 'riders', 'rider details set', rider_id || ' v' || version, reason,
                 'rider_versions:' || rider_id || ':' || version FROM rider_versions
UNION ALL SELECT at, by_who, 'riders', 'rider ' || status, rider_id, reason, 'rider_steps:' || rider_id || ':' || seq FROM rider_steps
UNION ALL SELECT at, by_who, 'riders', 'rider note', rider_id, '', 'rider_notes:' || rider_id || ':' || seq FROM rider_notes
UNION ALL SELECT uploaded_at, uploaded_by, 'riders', 'document uploaded', rider_id, kind, 'rider_documents:' || doc_id FROM rider_documents
UNION ALL SELECT r.reviewed_at, r.reviewed_by, 'riders', 'document ' || r.decision, d.rider_id,
                 concat_ws(': ', d.kind, r.reason), 'rider_document_reviews:' || r.doc_id
            FROM rider_document_reviews r JOIN rider_documents d USING (doc_id)
UNION ALL SELECT started_at, started_by, 'riders', kind || ' check started', rider_id, '', 'rider_checks:' || check_id FROM rider_checks
UNION ALL SELECT set_at, set_by, 'riders', 'payout account set', rider_id, '',
                 'rider_payout_accounts:' || rider_id || ':' || set_at FROM rider_payout_accounts
UNION ALL SELECT created_at, created_by, 'riders', 'fitting slot opened', slot_id, centre, 'fitting_slots:' || slot_id FROM fitting_slots
UNION ALL SELECT at, by_who, 'riders', 'fitting ' || event, rider_id, concat_ws(': ', slot_id, reason),
                 'fitting_bookings:' || rider_id || ':' || seq FROM fitting_bookings
UNION ALL SELECT recorded_at, recorded_by, 'riders', 'screen loan recorded', loan_id, concat(rider_id, ' with ', bank),
                 'screen_loans:' || loan_id FROM screen_loans
UNION ALL SELECT set_at, set_by, 'riders', 'screen loan ' || status, loan_id, note,
                 'screen_loan_events:' || loan_id || ':' || seq FROM screen_loan_events
UNION ALL SELECT enrolled_at, enrolled_by, 'screens', 'screen enrolled', screen_id, model, 'screens:' || screen_id FROM screens
UNION ALL SELECT set_at, set_by, 'screens', CASE WHEN rider_id IS NULL THEN 'screen taken off' ELSE 'screen fitted' END,
                 screen_id, concat_ws(' ', rider_id, reason), 'screen_fittings:' || screen_id || ':' || from_at FROM screen_fittings
UNION ALL SELECT set_at, set_by, 'screens', 'screen assigned', screen_id, coalesce(rider_id, 'nobody'),
                 'rider_screens:' || screen_id || ':' || from_at FROM rider_screens
UNION ALL SELECT made_at, by, 'screens', 'command: ' || command, screen_id, reason, 'screen_commands:' || id FROM screen_commands
UNION ALL SELECT at, by, 'screens', 'service: ' || kind, screen_id, reason, 'screen_service_events:' || id FROM screen_service_events
UNION ALL SELECT added_at, added_by, 'screens', 'screen key added', screen_id, key_id,
                 'screen_keys:' || screen_id || ':' || key_id FROM screen_keys
UNION ALL SELECT revoked_at, revoked_by, 'screens', 'screen key revoked', screen_id, concat_ws(': ', key_id, reason),
                 'screen_key_revocations:' || screen_id || ':' || key_id FROM screen_key_revocations
UNION ALL SELECT issued_at, issued_by, 'screens', 'certificate issued', screen_id, serial, 'screen_certificates:' || serial FROM screen_certificates
UNION ALL SELECT revoked_at, revoked_by, 'screens', 'certificate revoked', serial, reason,
                 'screen_certificate_revocations:' || serial FROM screen_certificate_revocations
-- No key of its own; rows are never moved (append-only), so their place is theirs.
UNION ALL SELECT changed_at, changed_by, 'screens', 'screen inbox moved', screen_id,
                 'up to ' || up_to_from || ' → ' || up_to_to, 'screen_inbox_changes:' || ctid FROM screen_inbox_changes
UNION ALL SELECT made_at, by, 'screens', 'player release made', id, version_name, 'player_releases:' || id FROM player_releases
UNION ALL SELECT at, by, 'screens', 'release ' || kind, release_id, why, 'release_events:' || id FROM release_events
UNION ALL SELECT created_at, created_by, 'support', 'conversation started', thread_id, channel,
                 'support_threads:' || thread_id FROM support_threads WHERE created_by <> 'inbound'
UNION ALL SELECT at, by_who, 'support', 'conversation ' || state, thread_id, reason,
                 'support_steps:' || thread_id || ':' || seq FROM support_steps WHERE by_who <> 'inbound'
UNION ALL SELECT at, by_who, 'support', CASE direction WHEN 'out' THEN 'reply sent' ELSE 'support note' END, thread_id, '',
                 'support_messages:' || thread_id || ':' || seq FROM support_messages WHERE direction <> 'in'
UNION ALL SELECT marked_at, marked_by, 'business', 'marked as a demo copy', '', '', 'demo_copy:' || marked_at FROM demo_copy
UNION ALL SELECT saved_at, saved_by, 'settings', 'setting saved', key || ' v' || version, reason, 'settings:' || key || ':' || version FROM settings
UNION ALL SELECT at, by, 'riders', 'rider app signed out', coalesce(rider_id, 'new rider'), why, 'rider_session_ends:' || token_hash
            FROM rider_session_ends
UNION ALL SELECT at, rider_id, 'riders', 'rider app joined', rider_id, 'session opened his record', 'rider_session_joins:' || token_hash
            FROM rider_session_joins
UNION ALL SELECT at, by_who, 'screens', CASE WHEN seen THEN 'fitting: panel seen' ELSE 'fitting: panel not right' END,
                 screen_id, rider_id, 'fitting_panel_answers:' || command_id FROM fitting_panel_answers
UNION ALL SELECT set_at, set_by, 'brands', CASE WHEN active THEN 'portal access set' ELSE 'portal access removed' END,
                 brand_id, concat_ws(': ', address || ' as ' || role, reason),
                 'brand_members:' || brand_id || ':' || address || ':' || version FROM brand_members
UNION ALL SELECT started_at, address, 'brands', 'brand portal signed in', address, ip, 'brand_sessions:' || token_hash
            FROM brand_sessions
UNION ALL SELECT at, by, 'brands', 'brand portal signed out', address, why, 'brand_session_ends:' || token_hash
            FROM brand_session_ends
UNION ALL SELECT set_at, set_by, 'brands', 'business type set', brand_id, business_type,
                 'brand_profiles:' || brand_id || ':' || set_at FROM brand_profiles
) x;

GRANT SELECT ON audit_log TO recall_app;
