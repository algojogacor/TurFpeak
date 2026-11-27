-- Flash Peak TMS - Migration 009: Outbox Mentions Support
ALTER TABLE outbox_messages ADD COLUMN mentions_json TEXT;
