-- TDS on cuts (Prateek, 24 Oct 2026): held back from the partner and paid to the government. The rate
-- in force when the cut is given is kept with it (a price-book setting, 2% by default).
ALTER TABLE booking_cuts
  ADD COLUMN tds_bp integer NOT NULL DEFAULT 200 CHECK (tds_bp BETWEEN 0 AND 2000);
