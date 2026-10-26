-- P3.6: why each price book version was saved (the admin "Prices and rules" page asks for a reason,
-- like every other change). Versions saved before this have none.
ALTER TABLE price_books ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 200);
