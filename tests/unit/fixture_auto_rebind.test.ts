/**
 * Flash Peak TMS - Fixture Auto-Rebind Unit Test
 *
 * Verifies that when a report session is bound to the wrong fixture (e.g. via fallback
 * on uncaptioned / unaliased submissions), evidence batch processing cross-checks
 * extracted players against other active scheduled fixtures and auto-rebinds to the
 * correct fixture without producing false roster violations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import { ProviderRouter } from '../../src/ai/router.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../../src/ai/adapter.js';
import type { ImageClassifier } from '../../src/ai/classifier.js';
import type { MatchSummaryExtractor } from '../../src/ai/extractors/match.js';
import { findOrCreateReportSession } from '../../src/ingestion/session.js';
import { claimDebounceBatch } from '../../src/ingestion/debounce.js';
import { processClaimedBatch } from '../../src/application/evidence-batch-processor.js';
import { createStubMediaClient } from '../helpers/stub_media_client.js';

function createMockAdapter(): ProviderAdapter {
  return {
    name: 'GROQ',
    model: 'groq-test-model',
    capabilities: {
      vision: true,
      text: true,
      structured_output: true,
      supported_mime_types: ['image/jpeg', 'image/png'],
    },
    healthCheck: async () => true,
    execute: async (req: AIRequest): Promise<AIResponse<unknown>> => ({
      raw_text: JSON.stringify({ mock: true }),
      parsed_json: { mock: true },
      telemetry: {
        provider: 'GROQ',
        model: 'groq-test-model',
        task_type: req.task,
        latency_ms: 10,
        input_tokens: 100,
        output_tokens: 50,
        status: 'SUCCESS' as const,
        error_code: null,
      },
    }),
  };
}

describe('Fixture Auto-Rebind on Roster Grounding', () => {
  let db: Client;
  const tournamentId = 'tour-rebind';
  const team1Id = 'team-1-avoid-prime';
  const team2Id = 'team-2-avoid-impact';
  const team3Id = 'team-3-astra-nova';
  const team4Id = 'team-4-apostles';

  const wrongFixtureId = 'fix-wrong-001';
  const correctFixtureId = 'fix-correct-002';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Rebind Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });

    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES (?, ?, 'AVOID Prime', 'VERIFIED', ?, ?),
                   (?, ?, 'AVOID Impact', 'VERIFIED', ?, ?),
                   (?, ?, 'Astra Lumina Nova', 'VERIFIED', ?, ?),
                   (?, ?, 'The Apostles Dominion', 'VERIFIED', ?, ?)`,
      args: [team1Id, tournamentId, now, now, team2Id, tournamentId, now, now, team3Id, tournamentId, now, now, team4Id, tournamentId, now, now],
    });

    // Fixture 1 (Wrong fallback): AVOID Prime vs AVOID Impact
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, scheduled_at, timezone, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, ?, ?, ?, 'Asia/Jakarta', 'SCHEDULED', ?, ?)`,
      args: [wrongFixtureId, tournamentId, team1Id, team2Id, team1Id, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
            VALUES ('game-wrong', ?, 1, 'SCHEDULED', 'PENDING', ?, ?)`,
      args: [wrongFixtureId, now, now],
    });

    // Fixture 2 (Correct target): Astra Lumina Nova vs The Apostles Dominion
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, scheduled_at, timezone, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, ?, ?, ?, 'Asia/Jakarta', 'SCHEDULED', ?, ?)`,
      args: [correctFixtureId, tournamentId, team3Id, team4Id, team3Id, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
            VALUES ('game-correct', ?, 1, 'SCHEDULED', 'PENDING', ?, ?)`,
      args: [correctFixtureId, now, now],
    });

    // Roster for Astra Lumina Nova (Team 3)
    const astraPlayers = ['ATL_Preman', 'ATL_LEAK', 'ATL_CINOX', 'ATL_Missouri', 'ATL_Keeper'];
    for (let i = 0; i < astraPlayers.length; i++) {
      const isGk = i === 4;
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-astra-${i}`, tournamentId, team3Id,
          astraPlayers[i], astraPlayers[i], astraPlayers[i].toLowerCase(),
          isGk ? 'GOALKEEPER' : 'OUTFIELD', i + 1, now, now,
        ],
      });
    }

    // Roster for The Apostles Dominion (Team 4)
    const apostlePlayers = ['XII_FaaSkie', 'XII_Falzzx', 'XII_Nomis', 'XII_Aoryst', 'XII_Keeper'];
    for (let i = 0; i < apostlePlayers.length; i++) {
      const isGk = i === 4;
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-apos-${i}`, tournamentId, team4Id,
          apostlePlayers[i], apostlePlayers[i], apostlePlayers[i].toLowerCase(),
          isGk ? 'GOALKEEPER' : 'OUTFIELD', i + 1, now, now,
        ],
      });
    }

    // Roster for AVOID Prime & Impact (Team 1 & 2)
    const avoid1Players = ['AVO_P1', 'AVO_P2', 'AVO_P3', 'AVO_P4', 'AVO_GK1'];
    const avoid2Players = ['IMP_P1', 'IMP_P2', 'IMP_P3', 'IMP_P4', 'IMP_GK2'];
    for (let i = 0; i < 5; i++) {
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [`p-av1-${i}`, tournamentId, team1Id, avoid1Players[i], avoid1Players[i], avoid1Players[i].toLowerCase(), i === 4 ? 'GOALKEEPER' : 'OUTFIELD', i + 1, now, now],
      });
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [`p-av2-${i}`, tournamentId, team2Id, avoid2Players[i], avoid2Players[i], avoid2Players[i].toLowerCase(), i === 4 ? 'GOALKEEPER' : 'OUTFIELD', i + 1, now, now],
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('automatically rebinds session from wrong fixture to correct fixture when extracted players match', async () => {
    // Session initially created for wrongFixtureId
    const { session } = await findOrCreateReportSession(db, {
      fixture_id: wrongFixtureId,
      submitting_team_id: team1Id,
    });

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO inbound_messages (id, report_session_id, provider_message_key, chat_id, sender_raw_address, message_type, message_timestamp, received_at, raw_metadata_json, created_at)
            VALUES ('msg-rebind-1', ?, 'key-1', 'chat-group-1', 'unknown_sender@lid', 'IMAGE', ?, ?, '{}', ?)`,
      args: [session.id, now, now, now],
    });

    const fakeBytes = Buffer.from('screenshot-astra-apostles');
    await db.execute({
      sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
            VALUES ('asset-rebind-1', 'FLASHPEAK_VM_MEDIA', 'remote-rebind-1.jpg', 'MAIN_MATCH', 'image/jpeg', ?, 'sha-rebind-1', 'PRIVATE', 'STORED', 'msg-rebind-1', ?)`,
      args: [fakeBytes.length, now],
    });

    // Make session eligible for claim
    await db.execute({
      sql: `UPDATE report_sessions
            SET debounce_due_at = datetime('now', '-5 seconds')
            WHERE id = ?`,
      args: [session.id],
    });

    const stubMedia = createStubMediaClient(new Map([['remote-rebind-1', fakeBytes]]));
    const router = new ProviderRouter({ adapters: [createMockAdapter()], cooldownWindowMs: 1000 });

    const classifier: ImageClassifier = {
      classify: vi.fn().mockResolvedValue({ screen_type: 'MAIN_MATCH_SUMMARY', confidence: 0.99 }),
    };

    // AI extractor returns the players seen on scoreboard: Astra Lumina Nova vs The Apostles Dominion
    const matchExtractor: MatchSummaryExtractor = {
      extract: vi.fn().mockResolvedValue({
        raw_extraction: {},
        summary_data: {
          team_a_score: 6,
          team_b_score: 2,
          team_a_players: [
            { nickname_raw: 'ATL_Preman', rating: 10, goals: 3, assists: 2, passes: 12, defense: 6 },
            { nickname_raw: 'ATL_LEAK', rating: 10, goals: 3, assists: 1, passes: 8, defense: 7 },
            { nickname_raw: 'ATL_CINOX', rating: 10, goals: 0, assists: 1, passes: 12, defense: 27 },
            { nickname_raw: 'ATL_Missouri', rating: 9.7, goals: 0, assists: 1, passes: 13, defense: 11 },
          ],
          team_b_players: [
            { nickname_raw: 'XII_FaaSkie', rating: 10, goals: 0, assists: 0, passes: 12, defense: 26 },
            { nickname_raw: 'XII_Falzzx', rating: 10, goals: 0, assists: 0, passes: 12, defense: 22 },
            { nickname_raw: 'XII_Nomis', rating: 8.9, goals: 0, assists: 2, passes: 10, defense: 2 },
            { nickname_raw: 'XII_Aoryst', rating: 7.5, goals: 2, assists: 0, passes: 0, defense: 2 },
          ],
        },
      }),
    };

    const claimed = await claimDebounceBatch(db, 'worker-rebind', 30_000);
    expect(claimed).not.toBeNull();

    const res = await processClaimedBatch(
      {
        db,
        mediaClient: stubMedia,
        providerRouter: router,
        classifier,
        matchExtractor,
      },
      claimed!
    );

    // Verify:
    // 1. Result fixtureId should be rebound to correctFixtureId
    expect(res.fixtureId).toBe(correctFixtureId);
    expect(res.status).toBe('DRAFT_CREATED');

    // 2. Draft summary contains Astra Lumina Nova and The Apostles Dominion
    expect(res.whatsappSummary).toContain('Astra Lumina Nova');
    expect(res.whatsappSummary).toContain('The Apostles Dominion');
    expect(res.whatsappSummary).toContain('6 - 2');
    expect(res.whatsappSummary).not.toContain('Pelanggaran Roster Berat');

    // 3. Database session record was updated to correctFixtureId
    const sessionDb = await db.execute({
      sql: 'SELECT fixture_id, status FROM report_sessions WHERE id = ?',
      args: [session.id],
    });
    expect(sessionDb.rows[0].fixture_id).toBe(correctFixtureId);
    expect(sessionDb.rows[0].status).toBe('DRAFT_READY');
  });

  it('rejects ungrounded screenshots that match no tournament fixture at all', async () => {
    const { session } = await findOrCreateReportSession(db, {
      fixture_id: wrongFixtureId,
      submitting_team_id: team1Id,
    });

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO inbound_messages (id, report_session_id, provider_message_key, chat_id, sender_raw_address, message_type, message_timestamp, received_at, raw_metadata_json, created_at)
            VALUES ('msg-unmatched-1', ?, 'key-2', 'chat-group-1', 'random_person@lid', 'IMAGE', ?, ?, '{}', ?)`,
      args: [session.id, now, now, now],
    });

    const fakeBytes = Buffer.from('random-pub-match');
    await db.execute({
      sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
            VALUES ('asset-unmatched-1', 'FLASHPEAK_VM_MEDIA', 'remote-unmatched-1.jpg', 'MAIN_MATCH', 'image/jpeg', ?, 'sha-unmatched-1', 'PRIVATE', 'STORED', 'msg-unmatched-1', ?)`,
      args: [fakeBytes.length, now],
    });

    await db.execute({
      sql: `UPDATE report_sessions
            SET debounce_due_at = datetime('now', '-5 seconds')
            WHERE id = ?`,
      args: [session.id],
    });

    const stubMedia = createStubMediaClient(new Map([['remote-unmatched-1', fakeBytes]]));
    const router = new ProviderRouter({ adapters: [createMockAdapter()], cooldownWindowMs: 1000 });

    const classifier: ImageClassifier = {
      classify: vi.fn().mockResolvedValue({ screen_type: 'MAIN_MATCH_SUMMARY', confidence: 0.99 }),
    };

    // AI extractor returns players from completely unrecognized teams / pub game
    const matchExtractor: MatchSummaryExtractor = {
      extract: vi.fn().mockResolvedValue({
        raw_extraction: {},
        summary_data: {
          team_a_score: 3,
          team_b_score: 1,
          team_a_players: [
            { nickname_raw: 'PubDude1', rating: 10, goals: 3, assists: 0, passes: 12, defense: 6 },
            { nickname_raw: 'PubDude2', rating: 9, goals: 0, assists: 1, passes: 8, defense: 7 },
          ],
          team_b_players: [
            { nickname_raw: 'RandomEnemy1', rating: 8, goals: 1, assists: 0, passes: 12, defense: 26 },
            { nickname_raw: 'RandomEnemy2', rating: 7, goals: 0, assists: 1, passes: 12, defense: 22 },
          ],
        },
      }),
    };

    const claimed = await claimDebounceBatch(db, 'worker-unmatched', 30_000);
    expect(claimed).not.toBeNull();

    const res = await processClaimedBatch(
      {
        db,
        mediaClient: stubMedia,
        providerRouter: router,
        classifier,
        matchExtractor,
      },
      claimed!
    );

    // Verify it fails safely without creating an erroneous draft
    expect(res.status).toBe('NEEDS_CORRECTION');
    expect(res.error).toContain('Extracted players do not match any active tournament fixture');
    expect(res.whatsappSummary).toContain('Screenshot skor pertandingan tidak cocok dengan tim atau roster');

    const drafts = await db.execute({
      sql: 'SELECT * FROM report_versions WHERE report_session_id = ?',
      args: [session.id],
    });
    expect(drafts.rows.length).toBe(0);
  });
});
