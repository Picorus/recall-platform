-- P3.5: why each area version was saved (the admin Areas page asks for a reason, like every other
-- change). Versions saved before this have none.
ALTER TABLE area_versions ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 200);
