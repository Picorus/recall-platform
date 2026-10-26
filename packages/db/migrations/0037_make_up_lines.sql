-- P3.10: the Delivery page looks up a line's make-ups by line (refunds.line_id is unique already).
CREATE INDEX make_ups_line ON make_ups (line_id);
