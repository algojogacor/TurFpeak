-- Flash Peak TMS - Migration 010: Store WhatsApp Message ID for Outbox Messages
ALTER TABLE outbox_messages ADD COLUMN wa_message_id TEXT;
