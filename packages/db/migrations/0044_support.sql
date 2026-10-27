-- P3.15: support. Brand and rider requests in one inbox: each conversation (a thread) with one
-- person (a phone or an email), linked to the rider or brand it matched, with every message in and
-- out, staff notes, and its steps (open, waiting, done; who picked it up), each with who and when.
-- Append-only (hard rule 3).
-- One running number for messages and steps together: a conversation's history in the order it
-- happened, even within the same second.
CREATE SEQUENCE support_order;

CREATE TABLE support_threads (
  thread_id   text        PRIMARY KEY CHECK (thread_id ~ '^SUP-[0-9A-F]{10}$'),
  channel     text        NOT NULL CHECK (channel IN ('whatsapp', 'email', 'phone', 'in person')),
  -- Who: a mobile number (+91 and 10 digits) or an email address.
  contact     text        NOT NULL CHECK (contact ~ '^\+91[6-9][0-9]{9}$'
                                       OR contact ~ '^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$'),
  party_kind  text        CHECK (party_kind IN ('rider', 'brand')),
  party_id    text        CHECK (length(party_id) BETWEEN 1 AND 64),
  subject     text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  created_by  text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL,
  CHECK ((party_kind IS NULL) = (party_id IS NULL))
);
CREATE INDEX support_threads_contact ON support_threads (contact, created_at DESC);
CREATE INDEX support_threads_party ON support_threads (party_kind, party_id);

CREATE TABLE support_messages (
  thread_id    text        NOT NULL REFERENCES support_threads (thread_id),
  seq          integer     NOT NULL CHECK (seq >= 1),
  -- in: from the person; out: our reply (sent or failed); note: staff only, never sent.
  direction    text        NOT NULL CHECK (direction IN ('in', 'out', 'note')),
  body         text        NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  -- A message in: its channel and the provider's id ("whatsapp:wamid…"), kept once.
  provider_id  text        CHECK (provider_id IS NULL OR length(provider_id) <= 200),
  -- A reply is written down before it is sent ('sending'); how it went is in
  -- support_reply_results.
  status       text        CHECK (status = 'sending'),
  detail       text        CHECK (detail IS NULL OR length(detail) <= 300),
  by_who       text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at           timestamptz NOT NULL,
  n            bigint      NOT NULL DEFAULT nextval('support_order'),
  PRIMARY KEY (thread_id, seq),
  CHECK ((direction = 'out') = (status IS NOT NULL))
);
CREATE UNIQUE INDEX support_messages_in_once ON support_messages (provider_id)
  WHERE direction = 'in';

-- How each reply went: sent (with the provider's id) or failed (with why). A reply with no result
-- may or may not have gone (the system stopped while sending).
CREATE TABLE support_reply_results (
  thread_id   text        NOT NULL,
  seq         integer     NOT NULL,
  status      text        NOT NULL CHECK (status IN ('sent', 'failed')),
  provider_id text        CHECK (provider_id IS NULL OR length(provider_id) <= 200),
  detail      text        CHECK (detail IS NULL OR length(detail) <= 300),
  at          timestamptz NOT NULL,
  PRIMARY KEY (thread_id, seq),
  FOREIGN KEY (thread_id, seq) REFERENCES support_messages (thread_id, seq)
);

CREATE TABLE support_steps (
  thread_id   text        NOT NULL REFERENCES support_threads (thread_id),
  seq         integer     NOT NULL CHECK (seq >= 1),
  state       text        NOT NULL CHECK (state IN ('open', 'waiting', 'done')),
  -- Who has it now (a staff id), or nobody.
  owner       text        CHECK (owner IS NULL OR length(owner) BETWEEN 1 AND 120),
  reason      text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  by_who      text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at          timestamptz NOT NULL,
  n           bigint      NOT NULL DEFAULT nextval('support_order'),
  PRIMARY KEY (thread_id, seq)
);

CREATE TRIGGER support_threads_no_change BEFORE UPDATE OR DELETE ON support_threads
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER support_threads_no_truncate BEFORE TRUNCATE ON support_threads
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER support_messages_no_change BEFORE UPDATE OR DELETE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER support_messages_no_truncate BEFORE TRUNCATE ON support_messages
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER support_reply_results_no_change BEFORE UPDATE OR DELETE ON support_reply_results
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER support_reply_results_no_truncate BEFORE TRUNCATE ON support_reply_results
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER support_steps_no_change BEFORE UPDATE OR DELETE ON support_steps
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER support_steps_no_truncate BEFORE TRUNCATE ON support_steps
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON support_threads, support_messages, support_steps, support_reply_results
  TO recall_app;
GRANT USAGE ON SEQUENCE support_order TO recall_app;
