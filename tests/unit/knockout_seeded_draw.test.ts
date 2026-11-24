/**
 * Flash Peak TMS - Seeded Knockout Draw & Fixed Bracket Tree Unit Tests
 * 
 * Verifies:
 * 1. Seeded Draw Engine (generateKnockoutSeededDraw):
 *    - Every match pairs Pot 1 (rank 1) vs Pot 2 (rank 2).
 *    - Zero same-group pairings across multiple random iterations (Constraint 1).
 *    - Same-group teams strictly partitioned into Upper vs Lower Halves (Constraint 2).
 *    - 50:50 Host randomization (Constraint 3).
 *    - Robust fallback for odd group counts (backtracking derangement).
 *    - Validation guards (duplicate IDs, unequal pots, missing rank pairs).
 * 2. Fixed Bracket Tree Progression (generateKnockoutFixtures):
 *    - QF1 winner vs QF2 winner in SF1; QF3 winner vs QF4 winner in SF2.
 *    - SF1 winner vs SF2 winner in Grand Final (BO5).
 *    - Staggered fixture timestamps preserve slot order.
 * 3. Command Interface (!drawknockout, !kodraw, !drawko):
 *    - Role guard: ORGANIZER only.
 *    - Pre-condition guard: Rejects when group fixtures are incomplete.
 *    - Duplicate guard: Rejects when knockout fixtures already exist.
 *    - Progressive reveal & DB transaction execution.
 *    - !help command contains !drawknockout and !kodraw with descriptions.
 * 4. Formatters (formatKnockoutPotAnnouncement, formatKnockoutMatchReveal, formatKnockoutBracketTreeSummary).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import {
  generateKnockoutSeededDraw,
  type KnockoutQualifier,
  type KnockoutMatchPair,
} from '../../src/competition/draw.js';
import {
  generateKnockoutFixtures,
} from '../../src/competition/fixtures.js';
import {
  formatKnockoutPotAnnouncement,
  formatKnockoutMatchReveal,
  formatKnockoutBracketTreeSummary,
} from '../../src/whatsapp/formatters.js';
import { createApp } from '../../src/index.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

describe('Seeded Knockout Draw & Fixed Bracket Tree Engine', () => {
  let db: Client;
  const organizerPhone = '6289999999999';
  const organizerJid = '6289999999999@s.whatsapp.net';
  const regularUserJid = '6281111111111@s.whatsapp.net';
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

  // ===========================================================================
  // 1. generateKnockoutSeededDraw Unit Tests
  // ===========================================================================
  describe('generateKnockoutSeededDraw', () => {
    const create8Qualifiers = (): KnockoutQualifier[] => [
      { team_id: 't-a1', team_name: 'Team A1', group_code: 'A', group_rank: 1 },
      { team_id: 't-a2', team_name: 'Team A2', group_code: 'A', group_rank: 2 },
      { team_id: 't-b1', team_name: 'Team B1', group_code: 'B', group_rank: 1 },
      { team_id: 't-b2', team_name: 'Team B2', group_code: 'B', group_rank: 2 },
      { team_id: 't-c1', team_name: 'Team C1', group_code: 'C', group_rank: 1 },
      { team_id: 't-c2', team_name: 'Team C2', group_code: 'C', group_rank: 2 },
      { team_id: 't-d1', team_name: 'Team D1', group_code: 'D', group_rank: 1 },
      { team_id: 't-d2', team_name: 'Team D2', group_code: 'D', group_rank: 2 },
    ];

    it('pairs Pot 1 vs Pot 2 (Juara Grup vs Runner-up) for all matches', () => {
      const qualifiers = create8Qualifiers();
      const pairs = generateKnockoutSeededDraw(qualifiers);

      expect(pairs.length).toBe(4);
      for (const pair of pairs) {
        expect(pair.pot1_team.group_rank).toBe(1);
        expect(pair.pot2_team.group_rank).toBe(2);
        // team_a and team_b must be one pot1 and one pot2
        const ranks = [pair.team_a.group_rank, pair.team_b.group_rank].sort();
        expect(ranks).toEqual([1, 2]);
      }
    });

    it('guarantees zero same-group pairings across 100 random iterations', () => {
      const qualifiers = create8Qualifiers();

      for (let iter = 0; iter < 100; iter++) {
        const pairs = generateKnockoutSeededDraw(qualifiers);
        expect(pairs.length).toBe(4);

        for (const pair of pairs) {
          expect(pair.pot1_team.group_code).not.toBe(pair.pot2_team.group_code);
          expect(pair.team_a.group_code).not.toBe(pair.team_b.group_code);
        }
      }
    });

    it('strictly partitions same-group teams into Upper vs Lower Halves across 100 iterations', () => {
      const qualifiers = create8Qualifiers();

      for (let iter = 0; iter < 100; iter++) {
        const pairs = generateKnockoutSeededDraw(qualifiers);

        // Group team positions
        const groupHalves = new Map<string, { pot1Half: string; pot2Half: string }>();

        for (const pair of pairs) {
          const half = pair.bracket_half;

          const p1Group = pair.pot1_team.group_code;
          if (!groupHalves.has(p1Group)) {
            groupHalves.set(p1Group, { pot1Half: '', pot2Half: '' });
          }
          groupHalves.get(p1Group)!.pot1Half = half;

          const p2Group = pair.pot2_team.group_code;
          if (!groupHalves.has(p2Group)) {
            groupHalves.set(p2Group, { pot1Half: '', pot2Half: '' });
          }
          groupHalves.get(p2Group)!.pot2Half = half;
        }

        // For every group, pot1 and pot2 must be in opposite halves!
        for (const [group, halves] of groupHalves.entries()) {
          expect(halves.pot1Half).toBeDefined();
          expect(halves.pot2Half).toBeDefined();
          expect(
            halves.pot1Half,
            `Group ${group} Pot 1 and Pot 2 must be in opposite halves`
          ).not.toBe(halves.pot2Half);
          expect(['UPPER', 'LOWER']).toContain(halves.pot1Half);
          expect(['UPPER', 'LOWER']).toContain(halves.pot2Half);
        }

        // Upper half has matches 0 & 1, Lower half has matches 2 & 3
        const upperMatches = pairs.filter((p) => p.bracket_half === 'UPPER');
        const lowerMatches = pairs.filter((p) => p.bracket_half === 'LOWER');
        expect(upperMatches.length).toBe(2);
        expect(lowerMatches.length).toBe(2);
        expect(upperMatches.map((m) => m.match_index)).toEqual([0, 1]);
        expect(lowerMatches.map((m) => m.match_index)).toEqual([2, 3]);
      }
    });

    it('randomizes host assignment 50:50 between Pot 1 and Pot 2', () => {
      const qualifiers = create8Qualifiers();
      let pot1HostCount = 0;
      let totalMatches = 0;
      const iterations = 100;

      for (let iter = 0; iter < iterations; iter++) {
        const pairs = generateKnockoutSeededDraw(qualifiers);
        for (const pair of pairs) {
          totalMatches++;
          expect(pair.is_host_a).toBe(true);
          if (pair.is_pot1_host) {
            pot1HostCount++;
            expect(pair.team_a.group_rank).toBe(1);
            expect(pair.team_b.group_rank).toBe(2);
          } else {
            expect(pair.team_a.group_rank).toBe(2);
            expect(pair.team_b.group_rank).toBe(1);
          }
        }
      }

      // Over 400 matches, pot1HostCount should be roughly 200 (allow reasonable statistical bounds: 35% - 65%)
      const pot1Rate = pot1HostCount / totalMatches;
      expect(pot1Rate).toBeGreaterThan(0.35);
      expect(pot1Rate).toBeLessThan(0.65);
    });

    it('handles odd number of groups (e.g. 3 groups / 6 qualifiers) via backtracking derangement', () => {
      const oddQualifiers: KnockoutQualifier[] = [
        { team_id: 't-a1', team_name: 'Team A1', group_code: 'A', group_rank: 1 },
        { team_id: 't-a2', team_name: 'Team A2', group_code: 'A', group_rank: 2 },
        { team_id: 't-b1', team_name: 'Team B1', group_code: 'B', group_rank: 1 },
        { team_id: 't-b2', team_name: 'Team B2', group_code: 'B', group_rank: 2 },
        { team_id: 't-c1', team_name: 'Team C1', group_code: 'C', group_rank: 1 },
        { team_id: 't-c2', team_name: 'Team C2', group_code: 'C', group_rank: 2 },
      ];

      for (let iter = 0; iter < 50; iter++) {
        const pairs = generateKnockoutSeededDraw(oddQualifiers);
        expect(pairs.length).toBe(3);
        for (const pair of pairs) {
          expect(pair.pot1_team.group_rank).toBe(1);
          expect(pair.pot2_team.group_rank).toBe(2);
          expect(pair.pot1_team.group_code).not.toBe(pair.pot2_team.group_code);
        }
      }
    });

    it('rejects invalid qualifier sets (duplicate IDs, unequal pots, missing runner-up)', () => {
      // Duplicate IDs
      const duplicateIds: KnockoutQualifier[] = [
        { team_id: 't-dup', team_name: 'Team A1', group_code: 'A', group_rank: 1 },
        { team_id: 't-dup', team_name: 'Team A2', group_code: 'A', group_rank: 2 },
      ];
      expect(() => generateKnockoutSeededDraw(duplicateIds)).toThrow('kualifikasi duplikat');

      // Unequal Pots
      const unequalPots: KnockoutQualifier[] = [
        { team_id: 't-1', team_name: 'T1', group_code: 'A', group_rank: 1 },
        { team_id: 't-2', team_name: 'T2', group_code: 'B', group_rank: 1 },
        { team_id: 't-3', team_name: 'T3', group_code: 'A', group_rank: 2 },
      ];
      expect(() => generateKnockoutSeededDraw(unequalPots)).toThrow('harus sama');

      // Missing runner-up for a group
      const missingGroupRunnerUp: KnockoutQualifier[] = [
        { team_id: 't-1', team_name: 'T1', group_code: 'A', group_rank: 1 },
        { team_id: 't-2', team_name: 'T2', group_code: 'B', group_rank: 1 },
        { team_id: 't-3', team_name: 'T3', group_code: 'A', group_rank: 2 },
        { team_id: 't-4', team_name: 'T4', group_code: 'C', group_rank: 2 },
      ];
      expect(() => generateKnockoutSeededDraw(missingGroupRunnerUp)).toThrow('tidak memiliki perwakilan runner-up');
    });
  });

  // ===========================================================================
  // 2. Fixed Bracket Tree Advancement in generateKnockoutFixtures
  // ===========================================================================
  describe('Fixed Bracket Tree Progression (generateKnockoutFixtures)', () => {
    async function insertTeam(client: Client, tournamentId: string, id: string, name: string) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`,
        args: [id, tournamentId, name],
      });
    }

    it('advances QF winners according to Fixed Bracket Tree: (QF1 vs QF2 -> SF1, QF3 vs QF4 -> SF2, SF1 vs SF2 -> FINAL)', async () => {
      const tournamentId = 'trn-bracket-fixed-1';
      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Bracket Fixed Test', 'ACTIVE', '1.0', '{}', datetime('now'), datetime('now'))`,
        args: [tournamentId],
      });

      const teams = [
        { id: 'bt-a1', name: 'Alpha 1', g: 'A', r: 1 },
        { id: 'bt-a2', name: 'Alpha 2', g: 'A', r: 2 },
        { id: 'bt-b1', name: 'Beta 1', g: 'B', r: 1 },
        { id: 'bt-b2', name: 'Beta 2', g: 'B', r: 2 },
        { id: 'bt-c1', name: 'Gamma 1', g: 'C', r: 1 },
        { id: 'bt-c2', name: 'Gamma 2', g: 'C', r: 2 },
        { id: 'bt-d1', name: 'Delta 1', g: 'D', r: 1 },
        { id: 'bt-d2', name: 'Delta 2', g: 'D', r: 2 },
      ];

      for (const t of teams) {
        await insertTeam(db, tournamentId, t.id, t.name);
      }

      // Step 1: Round 1 (QF)
      const qfQuals: KnockoutQualifier[] = teams.map((t) => ({
        team_id: t.id,
        team_name: t.name,
        group_code: t.g,
        group_rank: t.r as 1 | 2,
      }));

      const qfRes = await generateKnockoutFixtures(db, tournamentId, qfQuals);
      expect(qfRes.fixtures.length).toBe(4);
      expect(qfRes.fixtures[0]!.round_code).toBe('QUARTER_FINAL');

      // Verify timestamps are staggered
      const times = qfRes.fixtures.map((f) => new Date(f.created_at).getTime());
      for (let i = 1; i < times.length; i++) {
        expect(times[i]!).toBeGreaterThan(times[i - 1]!);
      }

      // Step 2: Suppose QF winners are W_QF1, W_QF2, W_QF3, W_QF4
      // Match 1: team_a wins
      // Match 2: team_b wins
      // Match 3: team_a wins
      // Match 4: team_b wins
      const w1 = qfRes.fixtures[0]!.team_a_id;
      const w2 = qfRes.fixtures[1]!.team_b_id;
      const w3 = qfRes.fixtures[2]!.team_a_id;
      const w4 = qfRes.fixtures[3]!.team_b_id;

      const sfSeeds: KnockoutQualifier[] = [
        { team_id: w1, team_name: 'Winner QF1', group_code: 'KO', group_rank: 1 },
        { team_id: w2, team_name: 'Winner QF2', group_code: 'KO', group_rank: 1 },
        { team_id: w3, team_name: 'Winner QF3', group_code: 'KO', group_rank: 1 },
        { team_id: w4, team_name: 'Winner QF4', group_code: 'KO', group_rank: 1 },
      ];

      // Generate Semi-Finals without options.shuffle -> Fixed Bracket Tree!
      const sfRes = await generateKnockoutFixtures(db, tournamentId, sfSeeds);
      expect(sfRes.fixtures.length).toBe(2);
      expect(sfRes.fixtures[0]!.round_code).toBe('SEMI_FINAL');
      expect(sfRes.series[0]!.format).toBe('BO3');

      // SF 1 MUST be Winner QF1 vs Winner QF2
      expect(sfRes.fixtures[0]!.team_a_id).toBe(w1);
      expect(sfRes.fixtures[0]!.team_b_id).toBe(w2);

      // SF 2 MUST be Winner QF3 vs Winner QF4
      expect(sfRes.fixtures[1]!.team_a_id).toBe(w3);
      expect(sfRes.fixtures[1]!.team_b_id).toBe(w4);

      // Step 3: Grand Final
      // Suppose SF1 winner is w1, SF2 winner is w4
      const finalSeeds: KnockoutQualifier[] = [
        { team_id: w1, team_name: 'Winner SF1', group_code: 'KO', group_rank: 1 },
        { team_id: w4, team_name: 'Winner SF2', group_code: 'KO', group_rank: 1 },
      ];

      const finalRes = await generateKnockoutFixtures(db, tournamentId, finalSeeds);
      expect(finalRes.fixtures.length).toBe(1);
      expect(finalRes.fixtures[0]!.round_code).toBe('FINAL');
      expect(finalRes.series[0]!.format).toBe('BO5');
      expect(finalRes.series[0]!.target_wins).toBe(3);

      // Final MUST be Winner SF1 vs Winner SF2
      expect(finalRes.fixtures[0]!.team_a_id).toBe(w1);
      expect(finalRes.fixtures[0]!.team_b_id).toBe(w4);
    });

    it('respects pre-drawn matchPairs option when provided', async () => {
      const tournamentId = 'trn-pre-drawn-1';
      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Pre Drawn Test', 'ACTIVE', '1.0', '{}', datetime('now'), datetime('now'))`,
        args: [tournamentId],
      });

      const q1: KnockoutQualifier = { team_id: 'tm-1', team_name: 'T1', group_code: 'A', group_rank: 1 };
      const q2: KnockoutQualifier = { team_id: 'tm-2', team_name: 'T2', group_code: 'B', group_rank: 2 };
      const q3: KnockoutQualifier = { team_id: 'tm-3', team_name: 'T3', group_code: 'B', group_rank: 1 };
      const q4: KnockoutQualifier = { team_id: 'tm-4', team_name: 'T4', group_code: 'A', group_rank: 2 };

      for (const q of [q1, q2, q3, q4]) {
        await insertTeam(db, tournamentId, q.team_id, q.team_name);
      }

      const matchPairs: KnockoutMatchPair[] = [
        {
          match_index: 0,
          match_number: 1,
          bracket_half: 'UPPER',
          team_a: q1,
          team_b: q2,
          pot1_team: q1,
          pot2_team: q2,
          is_host_a: true,
          is_pot1_host: true,
        },
        {
          match_index: 1,
          match_number: 2,
          bracket_half: 'LOWER',
          team_a: q4,
          team_b: q3,
          pot1_team: q3,
          pot2_team: q4,
          is_host_a: true,
          is_pot1_host: false,
        },
      ];

      const res = await generateKnockoutFixtures(db, tournamentId, [q1, q2, q3, q4], { matchPairs });
      expect(res.fixtures.length).toBe(2);
      expect(res.fixtures[0]!.team_a_id).toBe('tm-1');
      expect(res.fixtures[0]!.team_b_id).toBe('tm-2');
      expect(res.fixtures[1]!.team_a_id).toBe('tm-4');
      expect(res.fixtures[1]!.team_b_id).toBe('tm-3');
    });
  });

  // ===========================================================================
  // 3. Command Interface (!drawknockout, !kodraw, !drawko)
  // ===========================================================================
  describe('Tournament Commands: !drawknockout & !kodraw', () => {
    const tournamentId = 'trn-cmd-ko-1';
    const now = new Date().toISOString();

    async function setupTournamentWithGroupStage(client: Client, isGroupComplete = true) {
      // 1. Organizer delegate
      await client.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES ('del-org', 'Organizer User', 'ACTIVE', ?, ?)`,
        args: [now, now],
      });
      await client.execute({
        sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at)
              VALUES ('wa-org', 'del-org', ?, 'PHONE', 1, ?)`,
        args: [organizerJid, now],
      });

      // 2. Tournament
      await client.execute({
        sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Flash Peak Cup 2026', 'ACTIVE', '1.0', '{}', ?, ?)`,
        args: [tournamentId, now, now],
      });

      // 3. Draw & 2 Groups
      await client.execute({
        sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
              VALUES ('draw-1', ?, 'COMPLETED', '{}', '[]', 'CRYPTO_RANDOM', '1.0', ?)`,
        args: [tournamentId, now],
      });
      await client.execute({
        sql: `INSERT INTO groups (id, draw_id, group_code, display_order)
              VALUES ('grp-a', 'draw-1', 'A', 1), ('grp-b', 'draw-1', 'B', 2)`,
      });

      // 4. Teams
      const teams = [
        { id: 'tm-a1', name: 'Alpha 1', grp: 'grp-a', pos: 1 },
        { id: 'tm-a2', name: 'Alpha 2', grp: 'grp-a', pos: 2 },
        { id: 'tm-a3', name: 'Alpha 3', grp: 'grp-a', pos: 3 },
        { id: 'tm-a4', name: 'Alpha 4', grp: 'grp-a', pos: 4 },
        { id: 'tm-b1', name: 'Beta 1', grp: 'grp-b', pos: 1 },
        { id: 'tm-b2', name: 'Beta 2', grp: 'grp-b', pos: 2 },
        { id: 'tm-b3', name: 'Beta 3', grp: 'grp-b', pos: 3 },
        { id: 'tm-b4', name: 'Beta 4', grp: 'grp-b', pos: 4 },
      ];

      for (const t of teams) {
        await client.execute({
          sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
                VALUES (?, ?, ?, 'VERIFIED', ?, ?)`,
          args: [t.id, tournamentId, t.name, now, now],
        });
        await client.execute({
          sql: `INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, ?)`,
          args: [t.grp, t.id, t.pos],
        });
      }

      // 5. Group Fixtures
      const fixtureStatus = isGroupComplete ? 'COMPLETED' : 'SCHEDULED';
      const fixtures = [
        { id: 'fx-g-1', g: 'grp-a', a: 'tm-a1', b: 'tm-a2', sa: 2, sb: 0 },
        { id: 'fx-g-2', g: 'grp-a', a: 'tm-a3', b: 'tm-a4', sa: 1, sb: 1 },
        { id: 'fx-g-3', g: 'grp-b', a: 'tm-b1', b: 'tm-b2', sa: 3, sb: 1 },
        { id: 'fx-g-4', g: 'grp-b', a: 'tm-b3', b: 'tm-b4', sa: 0, sb: 0 },
      ];

      for (const f of fixtures) {
        await client.execute({
          sql: `INSERT INTO fixtures (id, tournament_id, group_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
                VALUES (?, ?, ?, 'GROUP', 'ROUND_1', ?, ?, ?, ?, ?, ?)`,
          args: [f.id, tournamentId, f.g, f.a, f.b, f.a, fixtureStatus, now, now],
        });
        if (isGroupComplete) {
          await client.execute({
            sql: `INSERT INTO games (id, fixture_id, game_number, status, team_a_score, team_b_score, is_draw, is_walkover, walkover_type, evidence_status, created_at, updated_at)
                  VALUES (?, ?, 1, 'COMPLETED', ?, ?, ?, 0, 'NONE', 'VERIFIED', ?, ?)`,
            args: [`gm-${f.id}`, f.id, f.sa, f.sb, f.sa === f.sb ? 1 : 0, now, now],
          });
        }
      }

      // Standings
      if (isGroupComplete) {
        const { recalculateAndPersistGroupStandings } = await import('../../src/competition/standings.js');
        await recalculateAndPersistGroupStandings(client, tournamentId, 'grp-a');
        await recalculateAndPersistGroupStandings(client, tournamentId, 'grp-b');
      }
    }

    it('rejects !drawknockout when invoked by non-organizer (role guard)', async () => {
      await setupTournamentWithGroupStage(db, true);

      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msg = createTextMessage(regularUserJid, centralGroupJid, '!drawknockout');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.replyText).toContain('Organizer');
    });

    it('rejects !drawknockout when group fixtures are not completed yet', async () => {
      await setupTournamentWithGroupStage(db, false); // incomplete group stage

      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msg = createTextMessage(organizerJid, centralGroupJid, '!drawknockout');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.replyText).toContain('belum selesai');
    });

    it('successfully executes !drawknockout, generates fixtures and audit event', async () => {
      await setupTournamentWithGroupStage(db, true);

      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msg = createTextMessage(organizerJid, centralGroupJid, '!drawknockout');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.replyText).toContain('PENGUNDIAN BRACKET KNOCKOUT');
      expect(res.replyText).toContain('BAGAN BRACKET KNOCKOUT RESMI');

      // Verify DB fixtures created
      const koFixtures = await db.execute({
        sql: `SELECT * FROM fixtures WHERE tournament_id = ? AND stage = 'KNOCKOUT'`,
        args: [tournamentId],
      });
      expect(koFixtures.rows.length).toBe(2);

      // Verify DB series created
      const koSeries = await db.execute({
        sql: `SELECT * FROM series WHERE fixture_id IN (SELECT id FROM fixtures WHERE tournament_id = ? AND stage = 'KNOCKOUT')`,
        args: [tournamentId],
      });
      expect(koSeries.rows.length).toBe(2);

      // Verify audit event
      const auditRes = await db.execute({
        sql: `SELECT * FROM audit_events WHERE entity_id = ? AND event_type = 'KNOCKOUT_DRAW_COMPLETED'`,
        args: [tournamentId],
      });
      expect(auditRes.rows.length).toBe(1);
    });

    it('rejects duplicate !drawknockout if knockout fixtures already exist', async () => {
      await setupTournamentWithGroupStage(db, true);

      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      // First draw
      const msg1 = createTextMessage(organizerJid, centralGroupJid, '!drawknockout');
      const res1 = await app.handleInboundMessage(msg1);
      expect(res1.handled).toBe(true);

      // Second draw attempt
      const msg2 = createTextMessage(organizerJid, centralGroupJid, '!drawknockout');
      const res2 = await app.handleInboundMessage(msg2);
      expect(res2.handled).toBe(true);
      expect(res2.replyText).toContain('sudah diundi');
    });

    it('recognizes aliases !kodraw and !drawko', async () => {
      await setupTournamentWithGroupStage(db, true);

      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msgAlias = createTextMessage(organizerJid, centralGroupJid, '!kodraw');
      const resAlias = await app.handleInboundMessage(msgAlias);

      expect(resAlias.handled).toBe(true);
      expect(resAlias.replyText).toContain('PENGUNDIAN BRACKET KNOCKOUT');
    });

    it('includes !drawknockout and !kodraw in !help command listing for organizer, hides for regular user', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      // Regular user !help -> admin commands hidden
      const userHelpMsg = createTextMessage(regularUserJid, centralGroupJid, '!help');
      const userRes = await app.handleInboundMessage(userHelpMsg);
      expect(userRes.handled).toBe(true);
      expect(userRes.replyText).not.toContain('!drawknockout');
      expect(userRes.replyText).not.toContain('!kodraw');

      // Organizer !help -> admin commands visible
      const orgHelpMsg = createTextMessage(organizerJid, centralGroupJid, '!help');
      const orgRes = await app.handleInboundMessage(orgHelpMsg);
      expect(orgRes.handled).toBe(true);
      expect(orgRes.replyText).toContain('!drawknockout');
      expect(orgRes.replyText).toContain('!kodraw');
      expect(orgRes.replyText).toContain('!drawko');
    });
  });

  // ===========================================================================
  // 4. Formatters Verification
  // ===========================================================================
  describe('Formatters', () => {
    it('formatKnockoutPotAnnouncement renders pots and rules clearly', () => {
      const text = formatKnockoutPotAnnouncement({
        tournamentName: 'Season 1 Cup',
        pot1: [
          { team_name: 'Alpha Prime', group_code: 'A', group_rank: 1 },
          { team_name: 'Beta Lords', group_code: 'B', group_rank: 1 },
        ],
        pot2: [
          { team_name: 'Gamma Ray', group_code: 'A', group_rank: 2 },
          { team_name: 'Delta Force', group_code: 'B', group_rank: 2 },
        ],
      });

      expect(text).toContain('PENGUNDIAN BRACKET KNOCKOUT — SEASON 1 CUP');
      expect(text).toContain('POT 1 (Juara Grup):');
      expect(text).toContain('Alpha Prime (Grup A)');
      expect(text).toContain('Beta Lords (Grup B)');
      expect(text).toContain('POT 2 (Runner-up):');
      expect(text).toContain('Gamma Ray (Grup A)');
      expect(text).toContain('Delta Force (Grup B)');
      expect(text).toContain('Perlindungan Grup');
      expect(text).toContain('Pemisahan Bagan');
    });

    it('formatKnockoutMatchReveal renders match details with host indicator', () => {
      const text = formatKnockoutMatchReveal({
        matchIndex: 1,
        totalMatches: 4,
        roundLabel: 'PEREMPAT FINAL (QF)',
        teamA: 'Alpha Prime',
        teamB: 'Delta Force',
        isHostA: true,
      });

      expect(text).toContain('HASIL DRAW KNOCKOUT — PEREMPAT FINAL (QF)');
      expect(text).toContain('Match 1 dari 4');
      expect(text).toContain('*Alpha Prime* *(Host)*  vs  *Delta Force*');
      expect(text).toContain('BO3');
    });

    it('formatKnockoutBracketTreeSummary renders Upper & Lower Halves and Grand Final', () => {
      const text = formatKnockoutBracketTreeSummary({
        tournamentName: 'Championship 2026',
        upperHalf: [
          { matchLabel: 'QF 1', teamA: 'Team A1', teamB: 'Team B2', isHostA: true },
          { matchLabel: 'QF 2', teamA: 'Team C1', teamB: 'Team D2', isHostA: false },
        ],
        lowerHalf: [
          { matchLabel: 'QF 3', teamA: 'Team B1', teamB: 'Team A2', isHostA: true },
          { matchLabel: 'QF 4', teamA: 'Team D1', teamB: 'Team C2', isHostA: false },
        ],
      });

      expect(text).toContain('BAGAN BRACKET KNOCKOUT RESMI');
      expect(text).toContain('CHAMPIONSHIP 2026');
      expect(text).toContain('BAGAN ATAS (UPPER HALF)');
      expect(text).toContain('QF 1: *Team A1* (Host) vs *Team B2*');
      expect(text).toContain('Semi Final 1:');
      expect(text).toContain('BAGAN BAWAH (LOWER HALF)');
      expect(text).toContain('QF 3: *Team B1* (Host) vs *Team A2*');
      expect(text).toContain('Semi Final 2:');
      expect(text).toContain('GRAND FINAL');
      expect(text).toContain('BO5');
    });
  });
});
