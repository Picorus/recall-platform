-- P2.7: area ids at most 48 characters, so a booking line id ("booking/area/date/hour", booking ids up
-- to 40) and its make-ups ("…#1") always fit the 120 characters a screen's plan and play record allow.
ALTER TABLE area_versions ADD CONSTRAINT area_id_length CHECK (length(area_id) <= 48);
