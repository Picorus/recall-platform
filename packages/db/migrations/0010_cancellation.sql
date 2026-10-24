-- Cancellation after payment (Prateek, 24 Oct 2026): no refund by default; cancelled at least 72 hours
-- (a setting) before the first hour, a super admin may refund in full; later, nothing can be refunded
-- and the money is earned ('forfeited').
ALTER TABLE line_settlements DROP CONSTRAINT line_settlements_outcome_check;
ALTER TABLE line_settlements ADD CONSTRAINT line_settlements_outcome_check
  CHECK (outcome IN ('make-up', 'no window', 'not needed', 'refund', 'nothing paid', 'forfeited'));
