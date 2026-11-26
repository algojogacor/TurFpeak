import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import { ProviderRouter } from '../../src/ai/router.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../../src/ai/adapter.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

const ORG_JID = '628999000001@s.whatsapp.net';

interface ExtractedSpec {
  leftScore: number;
  rightScore: number;
  leftPlayers: string[];
  rightPlayers: string[];
}

const pendingSpecs: ExtractedSpec[] = [];

function mockAdapter(): ProviderAdapter {
  return {
    name: 'MOCK',
    model: 'mock-v1',
    capabilities: { vision: true, text: true, structured_output: true, supported_mime_types: ['image/jpeg'] },
    healthCheck: async () => true,
    execute: async (req: AIRequest): Promise<AIResponse<unknown>> => {
      if (req.task === 'CLASSIFY') {
        const j = { screen_type: 'MAIN_MATCH_SUMMARY', confidence: 0.99, reason: 'mock', visual_features: [], uncertainties: [] };
        return {
          raw_text: JSON.stringify(j), parsed_json: j,
          telemetry: { provider: 'MOCK', model: 'm', task_type: 'CLASSIFY', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null },
        };
      }
      if (req.task === 'EXTRACT_MATCH') {
        const spec = pendingSpecs.shift() || { leftScore: 4, rightScore: 1, leftPlayers: [], rightPlayers: [] };
        const j = {
          screen_type: 'MAIN_MATCH_SUMMARY',
          team_a_score: spec.leftScore,
          team_b_score: spec.rightScore,
          result_indicator: 'WIN',
          team_a_players: spec.leftPlayers.map((name) => ({
            nickname_raw: name,
            rating: 8.5,
            goals: 2,
            assists: 1,
            passes: 10,
            defense: 5,
          })),
          team_b_players: spec.rightPlayers.map((name) => ({
            nickname_raw: name,
            rating: 6.0,
            goals: 0,
            assists: 0,
            passes: 5,
            defense: 2,
          })),
          confidence: 0.99,
          unreadable_fields: [],
          uncertainties: [],
        };
        return {
          raw_text: JSON.stringify(j), parsed_json: j,
          telemetry: { provider: 'MOCK', model: 'm', task_type: 'EXTRACT_MATCH', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null },
        };
      }
      throw new Error('unhandled task ' + req.task);
    },
  } as unknown as ProviderAdapter;
}

function imgMsg(sender: string, chat: string, caption: string, key: string): NormalizedMessage {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), provider_message_key: key,
    chat_id: chat, sender_raw_address: sender, sender_normalized_address: sender,
    address_type: 'JID', is_from_me: false, participant: sender, push_name: 'T',
    message_timestamp: now, received_at: now, message_type: 'IMAGE',
    text_body: null, caption, reply_to_key: null,
    quoted_participant: null, quoted_text: null,
    media_metadata: { mimetype: 'image/jpeg', fileName: 'shot.jpg' } as any,
    raw_message: {} as any,
  };
}

describe('Knockout Side-Swap & Player Stats Grounding', () => {
  let db: Client;
  let fixtureId: string;
  let teamAId: string;
  let teamBId: string;
  let delBJid: string;

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    pendingSpecs.length = 0;

    const tourneyId = randomUUID();
    teamAId = randomUUID();
    teamBId = randomUUID();
    fixtureId = randomUUID();
    delBJid = '628111222333@s.whatsapp.net';
    const now = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'Test Cup', 'ACTIVE', 'Asia/Jakarta', '1', '{}', ?, ?)`,
      args: [tourneyId, now, now],
    });

    // Delegate for Team B
    const delBId = randomUUID();
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Apostles Del', 'ACTIVE', ?, ?)`,
      args: [delBId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, verified_at, created_at)
            VALUES (?, ?, ?, 'JID', 1, ?, ?)`,
      args: [randomUUID(), delBId, delBJid, now, now],
    });

    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, delegate_id, created_at, updated_at) VALUES (?, ?, 'Elite 8', 'VERIFIED', NULL, ?, ?), (?, ?, 'The Apostles', 'VERIFIED', ?, ?, ?)`,
      args: [teamAId, tourneyId, now, now, teamBId, tourneyId, delBId, now, now],
    });

    // Players for Team A
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES (?, ?, ?, 'E8ㆍTikaGemoy', 'E8ㆍTikaGemoy', 'tikagemoy', 'OUTFIELD', 1, 'STARTER', 'ACTIVE', ?, ?)`,
      args: [randomUUID(), tourneyId, teamAId, now, now],
    });

    // Players for Team B
    const aorystId = randomUUID();
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES (?, ?, ?, 'XIIㆍﾑoryst⚚', 'XIIㆍﾑoryst⚚', 'aoryst', 'OUTFIELD', 1, 'STARTER', 'ACTIVE', ?, ?)`,
      args: [aorystId, tourneyId, teamBId, now, now],
    });

    // Fixture: Elite 8 (team_a) vs The Apostles (team_b)
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, 'KNOCKOUT', 'QUARTER_FINAL', ?, ?, ?, 'SCHEDULED', ?, ?)`,
      args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
    });

    await db.execute({
      sql: `INSERT INTO series (id, fixture_id, format, target_wins, status, winner_team_id, team_a_game_wins, team_b_game_wins, created_at, updated_at)
            VALUES (?, ?, 'BO3', 2, 'PENDING', NULL, 0, 0, ?, ?)`,
      args: [randomUUID(), fixtureId, now, now],
    });
  });

  it('correctly detects side swap when uploader is on left side and inverts scores & records player stats', async () => {
    const router = new ProviderRouter({ adapters: [mockAdapter()] });
    const app = createApp({
      db,
      providerRouter: router,
      centralGroupJid: 'group@g.us',
      organizerJid: ORG_JID,
    });

    // Screen extraction: Left side = XIIㆍﾑoryst⚚ (The Apostles, Team B) scored 4
    // Right side = E8ㆍTikaGemoy (Elite 8, Team A) scored 1
    pendingSpecs.push({
      leftScore: 4,
      rightScore: 1,
      leftPlayers: ['XIIㆍﾑoryst⚚'],
      rightPlayers: ['E8ㆍTikaGemoy'],
    });

    const msg = imgMsg(delBJid, 'group@g.us', `!kogame ${fixtureId}`, 'msg-ko-1');
    const res = await app.handleInboundMessage(msg, Buffer.from('fake'));

    expect(res.handled).toBe(true);
    expect(res.replyText).toContain('HASIL GAME KNOCKOUT TERCATAT');
    // Team A (Elite 8) should have score 1, Team B (The Apostles) should have score 4!
    expect(res.replyText).toContain('Elite 8 1 — 4 The Apostles');
    expect(res.replyText).toContain('*Skor Series:* 0 — 1');

    // Check games table: team_a_score = 1, team_b_score = 4, winner = teamB
    const gameRes = await db.execute({
      sql: `SELECT team_a_score, team_b_score, winner_team_id FROM games WHERE fixture_id = ?`,
      args: [fixtureId],
    });
    expect(gameRes.rows.length).toBe(1);
    expect(Number(gameRes.rows[0].team_a_score)).toBe(1);
    expect(Number(gameRes.rows[0].team_b_score)).toBe(4);
    expect(String(gameRes.rows[0].winner_team_id)).toBe(teamBId);

    // Check player_game_stats table: Aoryst should have goals recorded
    const statsRes = await db.execute({
      sql: `SELECT pgs.goals, pgs.team_id, p.nickname_raw
            FROM player_game_stats pgs
            JOIN players p ON pgs.player_id = p.id
            WHERE pgs.team_id = ?`,
      args: [teamBId],
    });
    expect(statsRes.rows.length).toBe(1);
    expect(Number(statsRes.rows[0].goals)).toBe(2);
    expect(String(statsRes.rows[0].nickname_raw)).toBe('XIIㆍﾑoryst⚚');
  });

  it('falls back to submitting delegate team when extracted players are empty', async () => {
    const router = new ProviderRouter({ adapters: [mockAdapter()] });
    const app = createApp({
      db,
      providerRouter: router,
      centralGroupJid: 'group@g.us',
      organizerJid: ORG_JID,
    });

    pendingSpecs.push({
      leftScore: 8,
      rightScore: 5,
      leftPlayers: [],
      rightPlayers: [],
    });

    const msg = imgMsg(delBJid, 'group@g.us', `!kogame ${fixtureId}`, 'msg-ko-fallback');
    const res = await app.handleInboundMessage(msg, Buffer.from('fake'));

    expect(res.handled).toBe(true);
    expect(res.replyText).toContain('Elite 8 5 — 8 The Apostles');
    expect(res.replyText).toContain('*Skor Series:* 0 — 1');

    const gameRes = await db.execute({
      sql: `SELECT team_a_score, team_b_score, winner_team_id FROM games WHERE fixture_id = ?`,
      args: [fixtureId],
    });
    expect(gameRes.rows.length).toBe(1);
    expect(Number(gameRes.rows[0].team_a_score)).toBe(5);
    expect(Number(gameRes.rows[0].team_b_score)).toBe(8);
    expect(String(gameRes.rows[0].winner_team_id)).toBe(teamBId);
  });
});
