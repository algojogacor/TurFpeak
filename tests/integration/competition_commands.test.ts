import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

describe('Competition Worker Commands Integration (!createtournament & !draw)', () => {
  let db: Client;
  const organizerPhone = '6289999999999';
  const organizerJid = '6289999999999@s.whatsapp.net';
  const regularUserJid = '6281111111111@s.whatsapp.net';
  const centralGroupJid = '120363000000000000@g.us';

  beforeEach(async () => {
    db = createClient({ url: 'file::memory:?cache=shared' });
    await runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTextMessage(
    senderJid: string,
    chatId: string,
    text: string
  ): NormalizedMessage {
    return {
      id: randomUUID(),
      provider_message_key: randomUUID(),
      chat_id: chatId,
      sender_raw_address: senderJid,
      sender_normalized_address: senderJid,
      address_type: 'JID',
      is_from_me: false,
      participant: senderJid,
      push_name: 'Test Sender',
      message_timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
      message_type: 'TEXT',
      text_body: text,
      caption: null,
      reply_to_key: null,
      quoted_participant: null,
      quoted_text: null,
      raw_message: {} as any,
    };
  }

  it('rejects !createtournament when invoked by non-organizer', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    const msg = createTextMessage(regularUserJid, centralGroupJid, '!createtournament Summer Cup');
    const res = await app.handleInboundMessage(msg);

    expect(res.handled).toBe(true);
    expect(res.type).toBe('COMMAND');
    expect(res.commandResult?.success).toBe(false);
    expect(res.replyText).toContain('hanya memiliki izin untuk dijalankan oleh Organizer');
  });

  it('successfully creates tournament with !createtournament by organizer', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    const msg = createTextMessage(organizerJid, centralGroupJid, '!createtournament Flash Peak Grand Cup');
    const res = await app.handleInboundMessage(msg);

    expect(res.handled).toBe(true);
    expect(res.type).toBe('COMMAND');
    expect(res.commandResult?.success).toBe(true);
    expect(res.replyText).toContain('TURNAMEN BERHASIL DIBUAT');
    expect(res.replyText).toContain('Flash Peak Grand Cup');

    // Verify tournament in DB
    const dbTourneys = await db.execute("SELECT * FROM tournaments WHERE name = 'Flash Peak Grand Cup'");
    expect(dbTourneys.rows.length).toBe(1);
    expect(dbTourneys.rows[0].status).toBe('DRAFT');
  });

  it('rejects !draw when fewer than 8 teams are verified', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    // Create tournament
    await app.handleInboundMessage(
      createTextMessage(organizerJid, centralGroupJid, '!createtournament Draw Test')
    );

    // Call !draw without enough teams
    const drawMsg = createTextMessage(organizerJid, centralGroupJid, '!draw');
    const res = await app.handleInboundMessage(drawMsg);

    expect(res.handled).toBe(true);
    expect(res.commandResult?.success).toBe(false);
    expect(res.replyText).toContain('minimal 8 tim');
  });

  it('successfully executes !draw, creates groups & fixtures, and announces schedule', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    // 1. Create tournament
    await app.handleInboundMessage(
      createTextMessage(organizerJid, centralGroupJid, '!createtournament Autumn League')
    );
    const tourneyRes = await db.execute("SELECT id FROM tournaments WHERE name = 'Autumn League'");
    const tourneyId = String(tourneyRes.rows[0].id);

    // 2. Register 8 verified teams
    const now = new Date().toISOString();
    for (let i = 1; i <= 8; i++) {
      const delId = randomUUID();
      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES (?, ?, 'ACTIVE', ?, ?)`,
        args: [delId, `Delegate ${i}`, now, now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'VERIFIED', ?, ?)`,
        args: [randomUUID(), tourneyId, `Team ${i}`, delId, now, now],
      });
    }

    // 3. Execute !draw
    const drawMsg = createTextMessage(organizerJid, centralGroupJid, '!draw');
    const res = await app.handleInboundMessage(drawMsg);

    expect(res.handled).toBe(true);
    expect(res.commandResult?.success).toBe(true);
    expect(res.replyText).toContain('HASIL LENGKAP PENGUNDIAN GRUP');
    expect(res.replyText).toContain('JADWAL PERTANDINGAN');
    expect(res.replyText).toContain('GRUP A');
    expect(res.replyText).toContain('GRUP B');

    // 4. Verify Tournament transitioned to ACTIVE
    const updatedTourney = await db.execute({
      sql: 'SELECT status FROM tournaments WHERE id = ?',
      args: [tourneyId],
    });
    expect(updatedTourney.rows[0].status).toBe('ACTIVE');

    // 5. Verify Fixtures were created (for 2 groups of 4: 6 matches per group = 12 total fixtures)
    const fixturesRes = await db.execute({
      sql: 'SELECT COUNT(*) as cnt FROM fixtures WHERE tournament_id = ?',
      args: [tourneyId],
    });
    expect(Number(fixturesRes.rows[0].cnt)).toBe(12);

    // 6. Calling !draw again returns existing draw without rerolling (FR-COMP-006)
    const secondDraw = await app.handleInboundMessage(drawMsg);
    expect(secondDraw.commandResult?.success).toBe(true);
    expect(secondDraw.replyText).toContain('sudah selesai sebelumnya');
  });
});
