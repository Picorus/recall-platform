-- P3.3: indexes for the fleet map, the Today page and the gateway's quick command send. Each
-- screen's latest position and latest report are found without reading everything it ever sent,
-- and commands just issued without reading every command.
CREATE INDEX screen_reports_latest_kind ON screen_reports (screen_id, kind, made_at DESC);
CREATE INDEX screen_reports_received ON screen_reports (screen_id, received_at DESC);
CREATE INDEX screen_commands_made ON screen_commands (made_at);
