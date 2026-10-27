-- P7.1 (security review).
-- Sign-in codes sent to a number or email that already has an account are marked: strangers asking
-- for codes to made-up numbers use up the shared hourly limit, never the one real people sign in on.
ALTER TABLE brand_codes ADD COLUMN known boolean NOT NULL DEFAULT false;
ALTER TABLE rider_codes ADD COLUMN known boolean NOT NULL DEFAULT false;
CREATE INDEX rider_codes_sent ON rider_codes (sent_at);
