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

  describe('Admin Manual Mode Command (!manualreport)', () => {
    it('rejects !manualreport when invoked by non-organizer', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msg = createTextMessage(regularUserJid, centralGroupJid, '!manualreport fix-001 2 1');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.type).toBe('COMMAND');
      expect(res.commandResult?.success).toBe(false);
      expect(res.replyText).toContain('hanya memiliki izin untuk dijalankan oleh Organizer');
    });

    it('shows usage guide when !manualreport is called without arguments by organizer', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msg = createTextMessage(organizerJid, centralGroupJid, '!manualreport');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.type).toBe('COMMAND');
      expect(res.commandResult?.success).toBe(false);
      expect(res.replyText).toContain('Format Perintah !manualreport');
      expect(res.replyText).toContain('!manualreport <fixture_id> <skor_a> <skor_b>');
    });

    it('successfully processes !manualreport with positional arguments and generates draft with MANUAL_ENTRY provenance', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-01';
      const teamAId = 'team-manual-a';
      const teamBId = 'team-manual-b';
      const delAId = 'del-manual-a';
      const delBId = 'del-manual-b';
      const fixtureId = 'fix-manual-01';
      const gameId = 'game-manual-01';

      // Seed tournament
      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Manual Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });

      // Seed delegates & teams
      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES (?, 'Del A', 'ACTIVE', ?, ?), (?, 'Del B', 'ACTIVE', ?, ?)`,
        args: [delAId, now, now, delBId, now, now],
      });

      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Alpha Team', ?, 'VERIFIED', ?, ?),
                     (?, ?, 'Beta Team', ?, 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, delAId, now, now, teamBId, tourneyId, delBId, now, now],
      });

      // Seed 5 registered active players per team (1 GK, 4 outfield)
      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-alpha-${i}`, tourneyId, teamAId, `Alpha${i}`, `Alpha${i}`, `alpha${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-beta-${i}`, tourneyId, teamBId, `Beta${i}`, `Beta${i}`, `beta${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      // Seed fixture & game
      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
              VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
        args: [gameId, fixtureId, now, now],
      });

      // Execute !manualreport
      const msg = createTextMessage(
        organizerJid,
        centralGroupJid,
        `!manualreport ${fixtureId} 2 1 Input manual karena kendala AI`
      );
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.type).toBe('COMMAND');
      expect(res.commandResult?.success).toBe(true);
      expect(res.replyText).toContain('PENDING APPROVAL');
      expect(res.replyText).toContain('Alpha Team');
      expect(res.replyText).toContain('Beta Team');
      expect(res.replyText).toContain('2 - 1');

      // Verify report_versions in DB
      const verRes = await db.execute({
        sql: 'SELECT provenance, status, created_by FROM report_versions WHERE fixture_id = ? ORDER BY version_number DESC LIMIT 1',
        args: [fixtureId],
      });
      expect(verRes.rows.length).toBe(1);
      expect(verRes.rows[0].provenance).toBe('MANUAL_ENTRY');
      expect(verRes.rows[0].status).toBe('PENDING_APPROVAL');
    });

    it('successfully processes !manualreport via JSON format with specific player statistics', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-02';
      const teamAId = 'team-manual-json-a';
      const teamBId = 'team-manual-json-b';
      const delAId = 'del-manual-json-a';
      const delBId = 'del-manual-json-b';
      const fixtureId = 'fix-manual-json-01';
      const gameId = 'game-manual-json-01';

      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Manual JSON Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });

      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES (?, 'Del JSON A', 'ACTIVE', ?, ?), (?, 'Del JSON B', 'ACTIVE', ?, ?)`,
        args: [delAId, now, now, delBId, now, now],
      });

      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Cyber JSON', ?, 'VERIFIED', ?, ?),
                     (?, ?, 'Solar JSON', ?, 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, delAId, now, now, teamBId, tourneyId, delBId, now, now],
      });

      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-cj-${i}`, tourneyId, teamAId, `CJPlayer${i}`, `CJPlayer${i}`, `cjplayer${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-sj-${i}`, tourneyId, teamBId, `SJPlayer${i}`, `SJPlayer${i}`, `sjplayer${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
              VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
        args: [gameId, fixtureId, now, now],
      });

      const payload = {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_score: 3,
        team_b_score: 0,
        team_a_players: [
          { nickname_raw: 'CJPlayer1', goals: 0, assists: 0, passes: 5, defense_raw: 6, goalkeeper_saves: 6 },
          { nickname_raw: 'CJPlayer2', goals: 2, assists: 1, passes: 12, defense_raw: 1 },
          { nickname_raw: 'CJPlayer3', goals: 1, assists: 1, passes: 14, defense_raw: 2 },
          { nickname_raw: 'CJPlayer4', goals: 0, assists: 0, passes: 8, defense_raw: 0 },
          { nickname_raw: 'CJPlayer5', goals: 0, assists: 0, passes: 9, defense_raw: 1 },
        ],
        team_b_players: [
          { nickname_raw: 'SJPlayer1', goals: 0, assists: 0, passes: 4, defense_raw: 3, goalkeeper_saves: 3 },
          { nickname_raw: 'SJPlayer2', goals: 0, assists: 0, passes: 7, defense_raw: 1 },
          { nickname_raw: 'SJPlayer3', goals: 0, assists: 0, passes: 6, defense_raw: 2 },
          { nickname_raw: 'SJPlayer4', goals: 0, assists: 0, passes: 5, defense_raw: 1 },
          { nickname_raw: 'SJPlayer5', goals: 0, assists: 0, passes: 8, defense_raw: 0 },
        ],
        notes: 'Input manual via JSON payload',
      };

      const msg = createTextMessage(
        organizerJid,
        centralGroupJid,
        `!manualreport ${JSON.stringify(payload)}`
      );
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.commandResult?.success).toBe(true);
      expect(res.replyText).toContain('PENDING APPROVAL');
      expect(res.replyText).toContain('Cyber JSON');
      expect(res.replyText).toContain('Solar JSON');
      expect(res.replyText).toContain('3 - 0');

      const verRes = await db.execute({
        sql: 'SELECT provenance, status FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(verRes.rows[0].provenance).toBe('MANUAL_ENTRY');
      expect(verRes.rows[0].status).toBe('PENDING_APPROVAL');
    });
  });
});
