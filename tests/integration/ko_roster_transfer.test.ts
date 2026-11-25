import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import { calculateTournamentAwards } from '../../src/stats/awards.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

describe('KO Roster Transfer Window & Interactive !ganti Flow', () => {
  let db: Client;
  const organizerPhone = '6289999999999';
  const organizerJid = '6289999999999@s.whatsapp.net';
  const delegate1Jid = '6281111111111@s.whatsapp.net';
  const delegate2Jid = '6282222222222@s.whatsapp.net';
  const centralGroupJid = '120363000000000000@g.us';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTextMessage(
    senderJid: string,
    chatId: string,
    text: string,
    replyToKey: string | null = null
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
      push_name: 'Tester',
      message_timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
      message_type: 'TEXT',
      text_body: text,
      caption: null,
      reply_to_key: replyToKey,
      quoted_participant: null,
      quoted_text: null,
      raw_message: {} as any,
    };
  }

  async function seedGroupTournamentToKoReady() {
    const app = createApp({ db, organizerPhone, centralGroupJid });
    await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!createtournament KO Transfer Cup'));
    const tRes = await db.execute(`SELECT id FROM tournaments ORDER BY created_at DESC LIMIT 1`);
    const tournamentId = String(tRes.rows[0].id);

    const now = new Date().toISOString();
    const teamIds: string[] = [];

    // Create 8 teams (2 groups of 4), verify delegates, register 6 players each for first 2 teams (and 5 for others)
    for (let i = 1; i <= 8; i++) {
      const delId = randomUUID();
      const jid = i === 1 ? delegate1Jid : i === 2 ? delegate2Jid : `628000000000${i}@s.whatsapp.net`;
      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?)`,
        args: [delId, `Del ${i}`, now, now],
      });
      await db.execute({
        sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, source_chat_id, is_primary, verified_at, created_at)
              VALUES (?, ?, ?, 'JID', ?, 1, ?, ?)`,
        args: [randomUUID(), delId, jid, centralGroupJid, now, now],
      });

      const tid = randomUUID();
      teamIds.push(tid);
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'VERIFIED', ?, ?)`,
        args: [tid, tournamentId, `Team${i}`, delId, now, now],
      });

      // Register 1 GK + 4 Inti (+ 1 Sub for Team1)
      await app.handleInboundMessage(
        createTextMessage(
          organizerJid,
          centralGroupJid,
          i === 1
            ? `!roster Team1 GK: T1GK | Inti: T1A, T1B, T1C, T1D | Cadangan: T1Sub1`
            : `!roster Team${i} GK: T${i}GK | Inti: T${i}A, T${i}B, T${i}C, T${i}D`
        )
      );
    }

    // Draw group stage
    const drawRes = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!draw'));
    expect(drawRes.commandResult?.success).toBe(true);

    return { app, tournamentId, teamIds };
  }

  it('allows interactive !ganti before Round 1 is played (and requires direct reply + valid sender)', async () => {
    const { app } = await seedGroupTournamentToKoReady();

    // Team1 delegate starts !ganti before any match has been played
    const startRes = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!ganti'));
    expect(startRes.handled).toBe(true);
    expect(startRes.commandResult?.success).toBe(true);
    expect(startRes.replyText).toContain('Pra-Round 1');
    expect(startRes.replyText).toContain('T1GK');
    expect(startRes.replyText).toContain('7.* [Cadangan] _(Kosong');

    const promptKey1 = String(startRes.commandResult?.metadata?.promptMessageKey);

    // Unrelated chat message without replying to prompt should NOT hijack the session
    const strayRes = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '2'));
    expect(strayRes.handled).toBe(false);

    // Another user replying to delegate1's prompt should NOT hijack the session
    const hijackRes = await app.handleInboundMessage(createTextMessage(delegate2Jid, centralGroupJid, '2', promptKey1));
    expect(hijackRes.handled).toBe(false);

    // Delegate1 replies with slot 2
    const step2Res = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '2', promptKey1));
    expect(step2Res.handled).toBe(true);
    expect(step2Res.replyText).toContain('SLOT 2 (Inti)');
    expect(step2Res.replyText).toContain('T1A');

    const promptKey2 = String(step2Res.commandResult?.metadata?.promptMessageKey);

    // Delegate1 replies with new nickname
    const step3Res = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, 'T1ANew', promptKey2));
    expect(step3Res.handled).toBe(true);
    expect(step3Res.replyText).toContain('PERGANTIAN PEMAIN BERHASIL');
    expect(step3Res.replyText).toContain('*T1A* ➡️ *T1ANew*');

    // View !roster Team1 confirms T1ANew is active in slot 2
    const viewRes = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!roster Team1'));
    expect(viewRes.replyText).toContain('T1ANew');
    expect(viewRes.replyText).not.toContain('T1A\n');
  });

  it('enforces !bukaganti / !tutupganti RBAC, KO qualification, full 100% swap, Rule 2.7, awards retention, and per-team KO hard-lock', async () => {
    const { app, tournamentId, teamIds } = await seedGroupTournamentToKoReady();
    const now = new Date().toISOString();

    // Non-organizer cannot run !bukaganti
    const deniedOpen = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!bukaganti'));
    expect(deniedOpen.commandResult?.success).toBe(false);

    // Record group stage stats for Team1's old player T1A (8 goals!) and T1GK (12 saves!) BEFORE completing group stage
    const groupFxRes = await db.execute({
      sql: `SELECT f.id, f.team_a_id, f.team_b_id, g.id as game_id
            FROM fixtures f JOIN games g ON g.fixture_id = f.id
            WHERE f.tournament_id = ? AND f.stage = 'GROUP'`,
      args: [tournamentId],
    });

    // Find a fixture with Team1 and seed a locked report + player_game_stats for T1A & T1GK
    const t1Id = teamIds[0]!;
    const t1Fx = groupFxRes.rows.find((r: any) => String(r.team_a_id) === t1Id || String(r.team_b_id) === t1Id)!;
    const t1PlayersRes = await db.execute({
      sql: `SELECT id, nickname_raw FROM players WHERE team_id = ? ORDER BY roster_slot ASC`,
      args: [t1Id],
    });
    const t1GkId = String(t1PlayersRes.rows[0].id);
    const t1AId = String(t1PlayersRes.rows[1].id);

    await db.execute({
      sql: `INSERT INTO report_sessions (id, fixture_id, game_id, submitting_team_id, status, last_message_at, debounce_due_at, created_at, updated_at)
            VALUES ('rs-g1', ?, ?, ?, 'DRAFT_READY', ?, ?, ?, ?)`,
      args: [String(t1Fx.id), String(t1Fx.game_id), t1Id, now, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO report_versions (id, report_session_id, fixture_id, version_number, status, extraction_json, validated_data_json, provenance, created_by, created_at)
            VALUES ('rv-g1', 'rs-g1', ?, 1, 'LOCKED', '{}', '{}', 'AI', 'test', ?)`,
      args: [String(t1Fx.id), now],
    });
    const t1IsA = String(t1Fx.team_a_id) === t1Id;
    await db.execute({
      sql: `UPDATE games SET status = 'COMPLETED', team_a_score = ?, team_b_score = ?, winner_team_id = ?, evidence_status = 'VERIFIED' WHERE id = ?`,
      args: [t1IsA ? 8 : 0, t1IsA ? 0 : 8, t1Id, String(t1Fx.game_id)],
    });
    await db.execute({
      sql: `UPDATE fixtures SET status = 'COMPLETED' WHERE id = ?`,
      args: [String(t1Fx.id)],
    });
    await db.execute({
      sql: `INSERT INTO player_game_stats (id, game_id, player_id, team_id, rating, goals, assists, passes, defense_raw, goalkeeper_saves, source_report_version_id, is_award_eligible, created_at)
            VALUES ('pgs-t1a', ?, ?, ?, 9.5, 8, 2, 20, 4, NULL, 'rv-g1', 1, ?)`,
      args: [String(t1Fx.game_id), t1AId, t1Id, now],
    });
    await db.execute({
      sql: `INSERT INTO player_game_stats (id, game_id, player_id, team_id, rating, goals, assists, passes, defense_raw, goalkeeper_saves, source_report_version_id, is_award_eligible, created_at)
            VALUES ('pgs-t1gk', ?, ?, ?, 9.0, 0, 0, 15, 10, 12, 'rv-g1', 1, ?)`,
      args: [String(t1Fx.game_id), t1GkId, t1Id, now],
    });

    // When Team1 has played Group Stage and !bukaganti is NOT open -> !ganti must be blocked
    const closedRes = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!ganti'));
    expect(closedRes.commandResult?.success).toBe(false);
    expect(closedRes.replyText).toContain('DITUTUP');

    // Finish remaining group matches deterministically so we can draw KO
    for (const row of groupFxRes.rows as any[]) {
      if (String(row.id) === String(t1Fx.id)) continue;
      // Team with lower index in teamIds wins so Team1..Team4 (or top 2 per group) cleanly separate without ties
      const taIdx = teamIds.indexOf(String(row.team_a_id));
      const tbIdx = teamIds.indexOf(String(row.team_b_id));
      const winId = taIdx < tbIdx ? String(row.team_a_id) : String(row.team_b_id);
      const sA = taIdx < tbIdx ? 3 : 0;
      const sB = taIdx < tbIdx ? 0 : 3;
      await db.execute({
        sql: `UPDATE games SET status = 'COMPLETED', team_a_score = ?, team_b_score = ?, winner_team_id = ?, evidence_status = 'VERIFIED' WHERE id = ?`,
        args: [sA, sB, winId, String(row.game_id)],
      });
      await db.execute({
        sql: `UPDATE fixtures SET status = 'COMPLETED' WHERE id = ?`,
        args: [String(row.id)],
      });
    }

    // Draw KO stage
    const koDrawRes = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!drawknockout'));
    expect(koDrawRes.commandResult?.success).toBe(true);

    // Find which teams qualified vs eliminated in KO
    const koFxRes = await db.execute({
      sql: `SELECT id, team_a_id, team_b_id FROM fixtures WHERE tournament_id = ? AND stage = 'KNOCKOUT'`,
      args: [tournamentId],
    });
    const koTeamIds = new Set<string>();
    for (const r of koFxRes.rows as any[]) {
      koTeamIds.add(String(r.team_a_id));
      koTeamIds.add(String(r.team_b_id));
    }
    const eliminatedTeamId = teamIds.find((id) => !koTeamIds.has(id))!;
    const eliminatedTeamRes = await db.execute({ sql: `SELECT team_name FROM teams WHERE id = ?`, args: [eliminatedTeamId] });
    const eliminatedName = String(eliminatedTeamRes.rows[0].team_name);

    // Organizer opens KO transfer window via !bukaganti
    const openRes = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!bukaganti'));
    expect(openRes.commandResult?.success).toBe(true);
    expect(openRes.replyText).toContain('DIBUKA');

    // Eliminated team cannot use !ganti even when window is open
    const elimRes = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, `!ganti ${eliminatedName}`));
    expect(elimRes.commandResult?.success).toBe(false);
    expect(elimRes.replyText).toContain('tidak terdaftar sebagai peserta fase Knockout');

    // Verify Team1 (which has stats on T1A and T1GK) qualified (index 0 always won above)
    expect(koTeamIds.has(t1Id)).toBe(true);

    // Replace ALL 6 registered players of Team1 + fill slots 7 and 8 (100% roster replacement!)
    // Also test Rule 2.7 rejection and 'batal' flow first
    const g1 = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!ganti'));
    expect(g1.commandResult?.success).toBe(true);
    expect(g1.replyText).toContain('Jendela Transfer KO');
    const pk1 = String(g1.commandResult?.metadata?.promptMessageKey);

    const g1Slot = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '2', pk1));
    const pk2 = String(g1Slot.commandResult?.metadata?.promptMessageKey);

    // Attempt to recruit Team2's player 'T2A' -> MUST be rejected per Rule 2.7
    const r27 = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, 'T2A', pk2));
    expect(r27.handled).toBe(true);
    expect(r27.replyText).toContain('Pasal 2.7');

    // Cancel via 'batal'
    const cancelRes = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, 'batal', pk2));
    expect(cancelRes.handled).toBe(true);
    expect(cancelRes.replyText).toContain('dibatalkan');

    // Perform full replacement of all 8 slots (slots 1..6 replaced + slots 7..8 filled)
    for (let slot = 1; slot <= 8; slot++) {
      const s = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!ganti'));
      expect(s.commandResult?.success).toBe(true);
      const p1 = String(s.commandResult?.metadata?.promptMessageKey);
      const s2 = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, String(slot), p1));
      const p2 = String(s2.commandResult?.metadata?.promptMessageKey);
      const s3 = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, `KO_New_${slot}`, p2));
      expect(s3.replyText).toContain('PERGANTIAN PEMAIN BERHASIL');
    }

    // Verify !roster Team1 shows 8/8 new active players, and !teams shows 8/8 (NOT 14/8!)
    const viewRoster = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!roster Team1'));
    expect(viewRoster.replyText).toContain('KO_New_1');
    expect(viewRoster.replyText).toContain('KO_New_8');
    expect(viewRoster.replyText).not.toContain('T1GK');
    expect(viewRoster.replyText).toContain('8 / 8');

    const teamsView = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!teams'));
    expect(teamsView.replyText).toContain('Team1');
    expect(teamsView.replyText).toContain('(8 pemain)');

    // Verify re-activating own previously REPLACED player (e.g. bringing T1A back to slot 8) succeeds and restores original row
    const reactivate1 = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!ganti'));
    const rp1 = String(reactivate1.commandResult?.metadata?.promptMessageKey);
    const reactivate2 = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '8', rp1));
    const rp2 = String(reactivate2.commandResult?.metadata?.promptMessageKey);
    const reactivate3 = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, 'T1A', rp2));
    expect(reactivate3.replyText).toContain('PERGANTIAN PEMAIN BERHASIL');
    expect(reactivate3.replyText).toContain('*KO_New_8* ➡️ *T1A*');
    const restoredRow = await db.execute({ sql: `SELECT id, status, roster_slot FROM players WHERE id = ?`, args: [t1AId] });
    expect(String(restoredRow.rows[0].status)).toBe('ACTIVE');
    expect(Number(restoredRow.rows[0].roster_slot)).toBe(8);

    // Verify historical Group Stage stats of REPLACED players (T1A 8 goals, T1GK 12 saves) are STILL preserved and counted in !awards!
    const awards = await calculateTournamentAwards(db, tournamentId);
    expect(awards.goldenBoot.winners[0]?.nicknameRaw).toBe('T1A');
    expect(awards.goldenBoot.winners[0]?.metricValue).toBe(8);
    expect(awards.bestWinningGoalkeeper.winners[0]?.nicknameRaw).toBe('T1GK');
    expect(awards.bestWinningGoalkeeper.winners[0]?.metricValue).toBe(12);

    // HARD-LOCK TEST: Team1 plays/reports Game 1 in KO (!kores) -> !ganti MUST be permanently locked for Team1
    // even while !bukaganti is still open and even if Organizer tries !ganti Team1!
    const t1KoFx = koFxRes.rows.find((r: any) => String(r.team_a_id) === t1Id || String(r.team_b_id) === t1Id)!;
    const t1KoFxId = String(t1KoFx.id);
    const koresRes = await app.handleInboundMessage(
      createTextMessage(organizerJid, centralGroupJid, `!kores ${t1KoFxId} 1 2-1`)
    );
    expect(koresRes.commandResult?.success).toBe(true);

    const lockedDelegateRes = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!ganti'));
    expect(lockedDelegateRes.commandResult?.success).toBe(false);
    expect(lockedDelegateRes.replyText).toContain('SUDAH TERKUNCI PERMANEN');

    const lockedOrganizerRes = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, `!ganti Team1`));
    expect(lockedOrganizerRes.commandResult?.success).toBe(false);
    expect(lockedOrganizerRes.replyText).toContain('SUDAH TERKUNCI PERMANEN');

    // Another qualified team whose KO fixture hasn't started yet CAN still use !ganti while window is open
    const otherKoTeamId = [...koTeamIds].find((id) => id !== t1Id && id !== String(t1KoFx.team_a_id) && id !== String(t1KoFx.team_b_id));
    if (otherKoTeamId) {
      const otherNameRes = await db.execute({ sql: `SELECT team_name FROM teams WHERE id = ?`, args: [otherKoTeamId] });
      const otherName = String(otherNameRes.rows[0].team_name);
      const otherAllowed = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, `!ganti ${otherName}`));
      expect(otherAllowed.commandResult?.success).toBe(true);

      // Organizer closes window via !tutupganti -> that other team is now locked too
      const closeRes = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!tutupganti'));
      expect(closeRes.commandResult?.success).toBe(true);
      expect(closeRes.replyText).toContain('DITUTUP');

      const otherBlockedAfterClose = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, `!ganti ${otherName}`));
      expect(otherBlockedAfterClose.commandResult?.success).toBe(false);
      expect(otherBlockedAfterClose.replyText).toContain('DITUTUP');
    }

    // Verify !help lists !ganti, !bukaganti, !tutupganti for organizer, and !ganti (without admin commands) for delegate
    const orgHelp = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!help'));
    expect(orgHelp.replyText).toContain('*!ganti*');
    expect(orgHelp.replyText).toContain('*!bukaganti*');
    expect(orgHelp.replyText).toContain('*!tutupganti*');

    const delHelp = await app.handleInboundMessage(createTextMessage(delegate1Jid, centralGroupJid, '!help'));
    expect(delHelp.replyText).toContain('*!ganti*');
    expect(delHelp.replyText).not.toContain('*!bukaganti*');
  });
});
