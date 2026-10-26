-- P3.9.2: an Ad review admin's decision on each uploaded ad: approved (the rule checklist ticked)
-- or rejected (with why). One decision per ad, final and never edited (hard rule 3): a wrong ad is
-- taken off a booking by choosing others, and a rejected one is fixed by uploading a new file.
CREATE TABLE ad_reviews (
  ad_id       text        PRIMARY KEY REFERENCES ads (ad_id),
  decision    text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason      text        CHECK (reason IS NULL OR length(reason) BETWEEN 10 AND 500),
  checklist   jsonb       NOT NULL,
  reviewed_by text        NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 120),
  reviewed_at timestamptz NOT NULL,
  -- A rejection always says why.
  CHECK (decision = 'approved' OR reason IS NOT NULL)
);

CREATE TRIGGER ad_reviews_no_change BEFORE UPDATE OR DELETE ON ad_reviews
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER ad_reviews_no_truncate BEFORE TRUNCATE ON ad_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON ad_reviews TO recall_app;
