-- 6- and 12-month deals (Prateek, 22 Oct 2026): lines keep their list price; the deal discount is one
-- amount on the bill, and GST is charged on the list subtotal less that discount.
ALTER TABLE bookings ADD COLUMN discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0);
COMMENT ON COLUMN bookings.subtotal_paise IS 'Taxable amount: the lines at list price less discount_paise';
