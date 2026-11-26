import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import { ProviderRouter } from '../../src/ai/router.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../../src/ai/adapter.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

const ORG_JID = '628999000001@s.whatsapp.net';

interface MockSpec {
  screenType?: 'MAIN_MATCH_SUMMARY' | 'UNKNOWN_OR_UNRELATED';
  leftScore?: number;
  rightScore?: number;
  leftPlayers?: Array<{ name: string; rating?: number; goals?: number }>;
  rightPlayers?: Array<{ name: string; rating?: number; goals?: number }>;
}

const pendingSpecs: MockSpec[] = [];

function mockAdapter(): ProviderAdapter {
  return {
    name: 'MOCK',
    model: 'mock-v1',
    capabilities: { vision: true, text: true, structured_output: true, supported_mime_types: ['image/jpeg'] },
    healthCheck: async () => true,
    execute: async (req: AIRequest): Promise<AIResponse<unknown>> => {
      if (req.task === 'CLASSIFY') {
        const next = pendingSpecs[0];
        const screenType = next?.screenType ?? 'MAIN_MATCH_SUMMARY';
        if (screenType !== 'MAIN_MATCH_SUMMARY') pendingSpecs.shift();
        const j = { screen_type: screenType, confidence: 0.99, reason: 'mock', visual_features: [], uncertainties: [] };
        return {
          raw_text: JSON.stringify(j),
          parsed_json: j,
          telemetry: { provider: 'MOCK', model: 'm', task_type: 'CLASSIFY', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null },
        };
      }
      if (req.task === 'EXTRACT_MATCH') {
        const spec = pendingSpecs.shift() || {};
        const j = {
          screen_type: 'MAIN_MATCH_SUMMARY',
          team_a_score: spec.leftScore ?? 0,
          team_b_score: spec.rightScore ?? 0,
          result_indicator: 'WIN',
          team_a_players: (spec.leftPlayers ?? []).map((p) => ({
            nickname_raw: p.name,
            rating: p.rating ?? 9.0,
            goals: p.goals ?? 0,
            assists: 0,
            passes: 5,
            defense: 3,
          })),
          team_b_players: (spec.rightPlayers ?? []).map((p) => ({
            nickname_raw: p.name,
            rating: p.rating ?? 8.0,
            goals: p.goals ?? 0,
            assists: 0,
            passes: 5,
            defense: 3,
          })),
          confidence: 0.95,
          unreadable_fields: [],
          uncertainties: [],
        };
        return {
          raw_text: JSON.stringify(j),
          parsed_json: j,
          telemetry: { provider: 'MOCK', model: 'm', task_type: 'EXTRACT_MATCH', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null },
        };
      }
      throw new Error('unhandled task ' + req.task);
    },
  } as unknown as ProviderAdapter;
}

function imgMsg(sender: string, chat: string, caption: string | null, key: string): NormalizedMessage {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    provider_message_key: key,
    chat_id: chat,
    sender_raw_address: sender,
    sender_normalized_address: sender,
    address_type: 'JID',
    is_from_me: false,
    participant: sender,
    push_name: 'Tester',
    message_timestamp: now,
    received_at: now,
    message_type: 'IMAGE',
    text_body: null,
    caption,
    reply_to_key: null,
    quoted_participant: null,
    quoted_text: null,
    media_metadata: { mimetype: 'image/jpeg', fileName: 'shot.jpg' } as any,
    raw_message: {} as any,
  };
}

describe('Knockout Routing Guards, Roster Mismatch & Rating Normalization', () => {
  let db: Client;
  const tourneyId = 't-ko-guards';
  const fixAtlKge = 'fix-atl-kge';
  const fixXiiTz = 'fix-xii-tz';
  const delAtlAddr = '628111000001@s.whatsapp.net';
  const delTzAddr = '628111000002@s.whatsapp.net';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    pendingSpecs.length = 0;
    const now = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'SF Guard Cup', 'ACTIVE', 'Asia/Jakarta', '1', '{}', ?, ?)`,
      args: [tourneyId, now, now],
    });

    const teams: Array<[string, string, string | null, string | null]> = [
      ['t-atl', 'Astra Lumina Nova', 'd-atl', delAtlAddr],
      ['t-kge', 'Kazekage', null, null],
      ['t-xii', 'The Apostles Dominion', null, null],
      ['t-tz', 'Team Zodiac', 'd-tz', delTzAddr],
    ];
    for (const [tid, name, did, addr] of teams) {
      if (did && addr) {
        await db.execute({
          sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?)`,
          args: [did, `Del ${name}`, now, now],
        });
        await db.execute({
          sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, verified_at, created_at)
                VALUES (?, ?, ?, 'JID', 1, ?, ?)`,
          args: [randomUUID(), did, addr, now, now],
        });
      }
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, delegate_id, created_at, updated_at)
              VALUES (?, ?, ?, 'VERIFIED', ?, ?, ?)`,
        args: [tid, tourneyId, name, did, now, now],
      });
    }

    const rosters: Array<[string, string[]]> = [
      ['t-atl', ['ATL_Preman✧', 'ATL_Missouri', 'ATL_LEAK✧', 'ATL_C I N O X✧']],
      ['t-kge', ['KGE.F9', 'KGE.DINGZ', 'KGE.Xieman', 'KGE.Floww']],
      ['t-xii', ['XIIㆍSimon⚚', 'XIIㆍUBAY⚚', 'XIIㆍFalzzx⚚', 'XIIㆍﾑoryst⚚']],
      ['t-tz', ['TZ・Ẋenø✦', 'TZ・ϻartysυpp', 'TZ・Ҡurøko✦', 'TZ・Տhυki✦']],
    ];
    for (const [tid, nicks] of rosters) {
      for (let idx = 0; idx < nicks.length; idx++) {
        const nick = nicks[idx]!;
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'OUTFIELD', ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [randomUUID(), tourneyId, tid, nick, nick, nick.toLowerCase(), idx + 1, now, now],
        });
      }
    }

    // Semifinal 1 (ATL vs KGE) is ALREADY COMPLETED 2-0
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, 'KNOCKOUT', 'SEMI_FINAL', 't-atl', 't-kge', 't-atl', 'COMPLETED', ?, ?)`,
      args: [fixAtlKge, tourneyId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO series (id, fixture_id, format, target_wins, status, winner_team_id, team_a_game_wins, team_b_game_wins, created_at, updated_at)
            VALUES ('ser-atl-kge', ?, 'BO3', 2, 'COMPLETED', 't-atl', 2, 0, ?, ?)`,
      args: [fixAtlKge, now, now],
    });

    // Semifinal 2 (Apostles vs Zodiac) is STILL ACTIVE (SCHEDULED, 0-0)
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, 'KNOCKOUT', 'SEMI_FINAL', 't-xii', 't-tz', 't-xii', 'SCHEDULED', ?, ?)`,
      args: [fixXiiTz, tourneyId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO series (id, fixture_id, format, target_wins, status, winner_team_id, team_a_game_wins, team_b_game_wins, created_at, updated_at)
            VALUES ('ser-xii-tz', ?, 'BO3', 2, 'PENDING', NULL, 0, 0, ?, ?)`,
      args: [fixXiiTz, now, now],
    });
  });

  it('blocks a late plain photo from a completed team from hijacking another active KO series', async () => {
    const app = createApp({
      db,
      providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }),
      centralGroupJid: 'g@g.us',
      organizerJid: ORG_JID,
    });

    pendingSpecs.push({
      screenType: 'MAIN_MATCH_SUMMARY',
      leftScore: 1,
      rightScore: 2,
      leftPlayers: [{ name: 'ATL_Preman✧', goals: 1 }],
      rightPlayers: [{ name: 'KGE.DINGZ', goals: 2 }],
    });

    const res = await app.handleInboundMessage(
      imgMsg(delAtlAddr, 'g@g.us', null, 'msg-late-atl'),
      Buffer.from('fake')
    );

    expect(res.handled).toBe(true);
    expect(String(res.replyText)).toContain('Astra Lumina Nova');
    expect(String(res.replyText)).toContain('COMPLETED');
    expect(String(res.replyText)).toContain('!kores');

    // Apostles vs Zodiac MUST remain untouched!
    const gamesRes = await db.execute({ sql: `SELECT COUNT(*) AS c FROM games WHERE fixture_id = ?`, args: [fixXiiTz] });
    expect(Number((gamesRes.rows[0] as any).c)).toBe(0);
    const evRes = await db.execute({ sql: `SELECT COUNT(*) AS c FROM ko_game_evidence WHERE fixture_id = ?`, args: [fixXiiTz] });
    expect(Number((evRes.rows[0] as any).c)).toBe(0);
  });

  it('rejects explicit !kogame <other_fixture_id> from a non-participant delegate', async () => {
    const app = createApp({
      db,
      providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }),
      centralGroupJid: 'g@g.us',
      organizerJid: ORG_JID,
    });

    const res = await app.handleInboundMessage(
      imgMsg(delAtlAddr, 'g@g.us', `!kogame ${fixXiiTz}`, 'msg-wrong-explicit'),
      Buffer.from('fake')
    );

    expect(res.handled).toBe(true);
    expect(String(res.replyText)).toContain('bukan peserta');
    const gamesRes = await db.execute({ sql: `SELECT COUNT(*) AS c FROM games`, args: [] });
    expect(Number((gamesRes.rows[0] as any).c)).toBe(0);
  });

  it('rejects post-extraction roster mismatch even when organizer targets a single active fixture', async () => {
    const app = createApp({
      db,
      providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }),
      centralGroupJid: 'g@g.us',
      organizerJid: ORG_JID,
    });

    pendingSpecs.push({
      screenType: 'MAIN_MATCH_SUMMARY',
      leftScore: 1,
      rightScore: 2,
      leftPlayers: [{ name: 'ATL_Preman✧', goals: 1 }, { name: 'ATL_LEAK✧', goals: 0 }],
      rightPlayers: [{ name: 'KGE.DINGZ', goals: 2 }, { name: 'KGE.F9', goals: 0 }],
    });

    const res = await app.handleInboundMessage(
      imgMsg(ORG_JID, 'g@g.us', `!kogame ${fixXiiTz}`, 'msg-org-mismatch'),
      Buffer.from('fake')
    );

    expect(res.handled).toBe(true);
    expect(String(res.replyText)).toContain('tidak cocok dengan roster');
    const gamesRes = await db.execute({ sql: `SELECT COUNT(*) AS c FROM games WHERE fixture_id = ?`, args: [fixXiiTz] });
    expect(Number((gamesRes.rows[0] as any).c)).toBe(0);
  });

  it('routes post-round KO match photos to completed notice and ignores casual non-match photos', async () => {
    // Mark Semifinal 2 COMPLETED as well so NO active KO fixture remains
    await db.execute({ sql: `UPDATE fixtures SET status = 'COMPLETED' WHERE id = ?`, args: [fixXiiTz] });
    await db.execute({ sql: `UPDATE series SET status = 'COMPLETED', winner_team_id = 't-tz', team_b_game_wins = 2 WHERE id = 'ser-xii-tz'` });

    const app = createApp({
      db,
      providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }),
      centralGroupJid: 'g@g.us',
      organizerJid: ORG_JID,
    });

    // 1. Casual non-match photo -> ignored cleanly (not handled as error)
    pendingSpecs.push({ screenType: 'UNKNOWN_OR_UNRELATED' });
    const casualRes = await app.handleInboundMessage(
      imgMsg(delTzAddr, 'g@g.us', null, 'msg-casual-meme'),
      Buffer.from('fake')
    );
    expect(casualRes.handled).toBe(false);

    // 2. Late match summary photo -> explicit completed series notice
    pendingSpecs.push({ screenType: 'MAIN_MATCH_SUMMARY' });
    const matchRes = await app.handleInboundMessage(
      imgMsg(delTzAddr, 'g@g.us', null, 'msg-late-tz'),
      Buffer.from('fake')
    );
    expect(matchRes.handled).toBe(true);
    expect(String(matchRes.replyText)).toContain('Team Zodiac');
    expect(String(matchRes.replyText)).toContain('COMPLETED');
  });

  it('normalizes 0-100 OCR ratings to 0-10 and matches OCR-swapped clan prefix in KO stats', async () => {
    const app = createApp({
      db,
      providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }),
      centralGroupJid: 'g@g.us',
      organizerJid: ORG_JID,
    });

    // Simulate Groq OCR reading "TZ・" as "XIIㆍ" and ratings as 100/98/90/86
    pendingSpecs.push({
      screenType: 'MAIN_MATCH_SUMMARY',
      leftScore: 7,
      rightScore: 4,
      leftPlayers: [
        { name: 'XIIㆍXeno⚚', rating: 100, goals: 0 },
        { name: 'XIIㆍMartysupp', rating: 98, goals: 7 },
        { name: 'XIIㆍKuroko⚚', rating: 90, goals: 0 },
        { name: 'XIIㆍShuki⚚', rating: 86, goals: 0 },
      ],
      rightPlayers: [
        { name: 'XIIㆍSimon⚚', rating: 100, goals: 0 },
        { name: 'XIIㆍFalzzx⚚', rating: 100, goals: 0 },
        { name: 'XIIㆍUBAY⚚', rating: 100, goals: 0 },
        { name: 'XIIㆍLoryst⚚', rating: 91, goals: 4 },
      ],
    });

    const res = await app.handleInboundMessage(
      imgMsg(delTzAddr, 'g@g.us', null, 'msg-tz-ocr-swap'),
      Buffer.from('fake')
    );

    expect(res.handled).toBe(true);
    expect(String(res.replyText)).toContain('The Apostles Dominion 4 — 7 Team Zodiac');

    // All 8 players saved, all ratings normalized to <= 10.0, Martysupp has 7 goals on Team Zodiac!
    const statsRes = await db.execute({
      sql: `SELECT pgs.team_id, p.nickname_raw, pgs.goals, pgs.rating
            FROM player_game_stats pgs
            JOIN players p ON pgs.player_id = p.id`,
    });
    expect(statsRes.rows.length).toBe(8);
    for (const r of statsRes.rows as any[]) {
      expect(Number(r.rating)).toBeLessThanOrEqual(10.0);
    }
    const marty = (statsRes.rows as any[]).find((r) => String(r.nickname_raw) === 'TZ・ϻartysυpp');
    expect(marty).toBeDefined();
    expect(Number(marty.goals)).toBe(7);
    expect(Number(marty.rating)).toBe(9.8);
    expect(String(marty.team_id)).toBe('t-tz');
  });
});
