-- Flash Peak TMS - Migration 008: Outbox Media Support
-- Allows outbox_messages to carry an optional local image path + mime type
-- so the running bot process can dispatch image broadcasts (posters/certificates)
-- through its active WhatsApp gateway session.

ALTER TABLE outbox_messages ADD COLUMN media_path TEXT;
ALTER TABLE outbox_messages ADD COLUMN media_mime TEXT;
