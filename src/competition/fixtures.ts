/**
 * Flash Peak TMS - Fixtures & Scheduling Engine
 * 
 * Generates single round-robin fixtures within groups with strictly balanced
 * left/right host side assignment (FR-COMP-012, FR-COMP-013, D-034).
 * Generates knockout stage single-elimination brackets with BO3/BO5 series mapping.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  Fixture,
  Series,
  UUID,
  ISODateString,
} from '../shared/types/index.js';

export interface GroupTeamParticipant {
  team_id: UUID;
  team_name: string;
  draw_position?: number;
}

export interface ScheduledMatchPair {
  round: number;
  team_a: GroupTeamParticipant; // Left-side host recommendation
  team_b: GroupTeamParticipant; // Right-side team
}

export interface KnockoutQualifier {
  team_id: UUID;
  team_name: string;
  group_code: string;
  group_rank: 1 | 2; // 1st or 2nd place
}

/**
 * Berger / circle-method round-robin algorithm that strictly enforces:
 * 1. Every team plays every other team in the group exactly once (FR-COMP-012).
 * 2. Left vs Right host count difference for every team is <= 1 (FR-COMP-013, D-034).
 * 
 * Works deterministically for 4-team and 5-team groups (and any size).
 */
export function generateBalancedRoundRobin(
  teams: GroupTeamParticipant[]
): ScheduledMatchPair[] {
  const n = teams.length;
  if (n < 2) {
    return [];
  }

  // If odd number of teams, add a dummy BYE team at the end
  const isOdd = n % 2 !== 0;
  const numParticipants = isOdd ? n + 1 : n;
  const numRounds = numParticipants - 1;
  const half = numParticipants / 2;

  const matches: ScheduledMatchPair[] = [];
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();

  for (const team of teams) {
    leftCounts.set(team.team_id, 0);
    rightCounts.set(team.team_id, 0);
  }

  for (let r = 0; r < numRounds; r++) {
    // Fixed match: fixed team (numParticipants - 1) against team r
    const fixedIndex = numParticipants - 1;
    const oppIndex = r;

    const isFixedDummy = isOdd && fixedIndex === n;
    const isOppDummy = isOdd && oppIndex === n;

    if (!isFixedDummy && !isOppDummy) {
      // Alternate home/away for the fixed team
      const fixedTeam = teams[fixedIndex]!;
      const oppTeam = teams[oppIndex]!;

      let left: GroupTeamParticipant;
      let right: GroupTeamParticipant;

      if (r % 2 === 0) {
        // fixed team is away (Right)
        left = oppTeam;
        right = fixedTeam;
      } else {
        // fixed team is home (Left)
        left = fixedTeam;
        right = oppTeam;
      }

      matches.push({ round: r + 1, team_a: left, team_b: right });
      leftCounts.set(left.team_id, (leftCounts.get(left.team_id) || 0) + 1);
      rightCounts.set(right.team_id, (rightCounts.get(right.team_id) || 0) + 1);
    }

    // Rotating matches
    for (let k = 1; k < half; k++) {
      const idx1 = (r + k) % (numParticipants - 1);
      const idx2 = (r - k + (numParticipants - 1)) % (numParticipants - 1);

      const is1Dummy = isOdd && idx1 === n;
      const is2Dummy = isOdd && idx2 === n;

      if (is1Dummy || is2Dummy) {
        continue;
      }

      const team1 = teams[idx1]!;
      const team2 = teams[idx2]!;

      let left: GroupTeamParticipant;
      let right: GroupTeamParticipant;

      if (k % 2 === 1) {
        left = team1;
        right = team2;
      } else {
        left = team2;
        right = team1;
      }

      matches.push({ round: r + 1, team_a: left, team_b: right });
      leftCounts.set(left.team_id, (leftCounts.get(left.team_id) || 0) + 1);
      rightCounts.set(right.team_id, (rightCounts.get(right.team_id) || 0) + 1);
    }
  }

  // Strict assertion: |left - right| <= 1 for all teams
  for (const team of teams) {
    const left = leftCounts.get(team.team_id) || 0;
    const right = rightCounts.get(team.team_id) || 0;
    const diff = Math.abs(left - right);
    if (diff > 1) {
      throw new Error(
        `Side balance violation for team ${team.team_name} (${team.team_id}): Left=${left}, Right=${right}, Diff=${diff} > 1`
      );
    }
  }

  return matches;
}

/**
 * Generates and stores all group stage fixtures for a tournament.
 */
export async function generateGroupStageFixtures(
  db: Client,
  tournamentId: string
): Promise<Fixture[]> {
  // Retrieve groups for this tournament via group_draws
  const groupsResult = await db.execute({
    sql: `
      SELECT g.id, g.group_code
      FROM groups g
      JOIN group_draws gd ON g.draw_id = gd.id
      WHERE gd.tournament_id = ?
      ORDER BY g.display_order ASC
    `,
    args: [tournamentId],
  });

  if (groupsResult.rows.length === 0) {
    throw new Error('Tidak ada grup yang ditemukan. Jalankan draw terlebih dahulu.');
  }

  const generatedFixtures: Fixture[] = [];
  const now: ISODateString = new Date().toISOString();

  for (const gRow of groupsResult.rows) {
    const groupId = String(gRow.id ?? (gRow as { id?: unknown }).id);

    // Fetch members of this group
    const membersResult = await db.execute({
      sql: `
        SELECT t.id as team_id, t.team_name, gm.draw_position
        FROM group_members gm
        JOIN teams t ON gm.team_id = t.id
        WHERE gm.group_id = ?
        ORDER BY gm.draw_position ASC
      `,
      args: [groupId],
    });

    const participants: GroupTeamParticipant[] = membersResult.rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        team_id: String(row.team_id),
        team_name: String(row.team_name),
        draw_position: Number(row.draw_position),
      };
    });

    const scheduledMatches = generateBalancedRoundRobin(participants);

    for (const match of scheduledMatches) {
      const fixtureId: UUID = randomUUID();
      const roundCode = `ROUND_${match.round}`;

      const fixture: Fixture = {
        id: fixtureId,
        tournament_id: tournamentId,
        stage: 'GROUP',
        group_id: groupId,
        round_code: roundCode,
        team_a_id: match.team_a.team_id,
        team_b_id: match.team_b.team_id,
        left_side_team_id: match.team_a.team_id, // Assigned at fixture generation time (FR-COMP-013)
        scheduled_at: null,
        timezone: 'Asia/Jakarta',
        host_team_id: null,
        host_assignment_reason: 'DEFAULT_LEFT_SIDE',
        status: 'SCHEDULED',
        created_at: now,
        updated_at: now,
      };

      await db.execute({
        sql: `
          INSERT INTO fixtures (
            id, tournament_id, stage, group_id, round_code,
            team_a_id, team_b_id, left_side_team_id, scheduled_at,
            timezone, host_team_id, host_assignment_reason, status,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          fixture.id,
          fixture.tournament_id,
          fixture.stage,
          fixture.group_id,
          fixture.round_code,
          fixture.team_a_id,
          fixture.team_b_id,
          fixture.left_side_team_id,
          fixture.scheduled_at,
          fixture.timezone,
          fixture.host_team_id,
          fixture.host_assignment_reason,
          fixture.status,
          fixture.created_at,
          fixture.updated_at,
        ],
      });

      // Group stage fixtures consist of exactly 1 game
      const gameId: UUID = randomUUID();
      await db.execute({
        sql: `
          INSERT INTO games (
            id, fixture_id, series_id, game_number, status,
            team_a_score, team_b_score, winner_team_id, is_draw,
            is_walkover, walkover_type, evidence_status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          gameId,
          fixtureId,
          null,
          1,
          'SCHEDULED',
          null,
          null,
          null,
          0,
          0,
          'NONE',
          'PENDING',
          now,
          now,
        ],
      });

      generatedFixtures.push(fixture);
    }
  }

  return generatedFixtures;
}

/**
 * Generates Knockout Stage bracket pairings from qualified teams (FR-COMP-011, D-010, D-011).
 * Exactly 2 teams qualify per group: 1st place and 2nd place.
 * Knockout format: BO3 before final; BO5 for Grand Final.
 */
export async function generateKnockoutFixtures(
  db: Client,
  tournamentId: string,
  qualifiers: KnockoutQualifier[]
): Promise<{ fixtures: Fixture[]; series: Series[] }> {
  if (qualifiers.length < 2) {
    throw new Error('Minimal 2 tim yang lolos untuk membentuk bracket Knockout');
  }

  // Separate group winners and runners-up
  const winners = qualifiers.filter((q) => q.group_rank === 1);
  const runnersUp = qualifiers.filter((q) => q.group_rank === 2);

  if (winners.length !== runnersUp.length) {
    throw new Error('Jumlah juara grup (rank 1) harus sama dengan runner-up grup (rank 2)');
  }

  const numGroups = winners.length;
  const now: ISODateString = new Date().toISOString();
  const createdFixtures: Fixture[] = [];
  const createdSeries: Series[] = [];

  // Pair winners against adjacent group runners-up so no same-group rematch in first KO round:
  // Winner Group i vs Runner-up Group (i + 1) % numGroups
  // Winner is assigned left side (host recommendation)
  const firstRoundMatches: { team_a: KnockoutQualifier; team_b: KnockoutQualifier }[] = [];

  for (let i = 0; i < numGroups; i++) {
    const winner = winners[i]!;
    const runnerUpIndex = (i + 1) % numGroups;
    const runnerUp = runnersUp[runnerUpIndex]!;

    firstRoundMatches.push({
      team_a: winner,
      team_b: runnerUp,
    });
  }

  let roundCode = 'ROUND_OF_16';
  if (firstRoundMatches.length === 1) {
    roundCode = 'FINAL';
  } else if (firstRoundMatches.length === 2) {
    roundCode = 'SEMI_FINAL';
  } else if (firstRoundMatches.length === 4) {
    roundCode = 'QUARTER_FINAL';
  }

  for (const match of firstRoundMatches) {
    const fixtureId: UUID = randomUUID();
    const seriesId: UUID = randomUUID();

    const isGrandFinal = roundCode === 'FINAL';
    const seriesFormat = isGrandFinal ? 'BO5' : 'BO3';
    const targetWins = isGrandFinal ? 3 : 2;

    const fixture: Fixture = {
      id: fixtureId,
      tournament_id: tournamentId,
      stage: 'KNOCKOUT',
      group_id: null,
      round_code: roundCode,
      team_a_id: match.team_a.team_id,
      team_b_id: match.team_b.team_id,
      left_side_team_id: match.team_a.team_id,
      scheduled_at: null,
      timezone: 'Asia/Jakarta',
      host_team_id: null,
      host_assignment_reason: 'DEFAULT_LEFT_SIDE',
      status: 'SCHEDULED',
      created_at: now,
      updated_at: now,
    };

    const s: Series = {
      id: seriesId,
      fixture_id: fixtureId,
      format: seriesFormat,
      target_wins: targetWins,
      status: 'PENDING',
      winner_team_id: null,
      team_a_game_wins: 0,
      team_b_game_wins: 0,
      created_at: now,
      updated_at: now,
    };

    await db.execute({
      sql: `
        INSERT INTO fixtures (
          id, tournament_id, stage, group_id, round_code,
          team_a_id, team_b_id, left_side_team_id, scheduled_at,
          timezone, host_team_id, host_assignment_reason, status,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        fixture.id,
        fixture.tournament_id,
        fixture.stage,
        fixture.group_id,
        fixture.round_code,
        fixture.team_a_id,
        fixture.team_b_id,
        fixture.left_side_team_id,
        fixture.scheduled_at,
        fixture.timezone,
        fixture.host_team_id,
        fixture.host_assignment_reason,
        fixture.status,
        fixture.created_at,
        fixture.updated_at,
      ],
    });

    await db.execute({
      sql: `
        INSERT INTO series (
          id, fixture_id, format, target_wins, status,
          winner_team_id, team_a_game_wins, team_b_game_wins,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        s.id,
        s.fixture_id,
        s.format,
        s.target_wins,
        s.status,
        s.winner_team_id,
        s.team_a_game_wins,
        s.team_b_game_wins,
        s.created_at,
        s.updated_at,
      ],
    });

    createdFixtures.push(fixture);
    createdSeries.push(s);
  }

  return { fixtures: createdFixtures, series: createdSeries };
}

/**
 * Derives Knockout Stage qualifiers from final persisted group standings:
 * exactly the top 2 teams of every group (O-004, FR-COMP-011).
 * Rejects when any group has unresolved tied ranks at the qualifying cut.
 */
export async function deriveKnockoutQualifiers(
  db: Client,
  tournamentId: string
): Promise<KnockoutQualifier[]> {
  const groupsRes = await db.execute({
    sql: `
      SELECT DISTINCT g.id, g.group_code
      FROM groups g
      JOIN group_draws gd ON g.draw_id = gd.id
      WHERE gd.tournament_id = ?
      ORDER BY g.display_order ASC
    `,
    args: [tournamentId],
  });

  if (groupsRes.rows.length === 0) {
    throw new Error('Tidak ada grup yang ditemukan. Jalankan draw terlebih dahulu.');
  }

  const qualifiers: KnockoutQualifier[] = [];

  for (const gRow of groupsRes.rows) {
    const groupId = String((gRow as Record<string, unknown>).id);
    const groupCode = String((gRow as Record<string, unknown>).group_code);

    const standingsRes = await db.execute({
      sql: `
        SELECT s.team_id, t.team_name, s.points, s.goal_difference, s.goals_for
        FROM standings s
        JOIN teams t ON s.team_id = t.id
        WHERE s.group_id = ?
        ORDER BY s.points DESC, s.goal_difference DESC, s.goals_for DESC
      `,
      args: [groupId],
    });

    if (standingsRes.rows.length < 2) {
      throw new Error(
        `Klasemen grup ${groupCode} belum lengkap untuk menentukan kualifikasi knockout.`
      );
    }

    const first = standingsRes.rows[0] as unknown as Record<string, unknown>;
    const second = standingsRes.rows[1] as unknown as Record<string, unknown>;

    const firstKey = `${Number(first.points)}-${Number(first.goal_difference)}-${Number(first.goals_for)}`;
    const secondKey = `${Number(second.points)}-${Number(second.goal_difference)}-${Number(second.goals_for)}`;

    if (firstKey === secondKey) {
      throw new Error(
        `Peringkat 1 dan 2 di grup ${groupCode} masih seri penuh (poin, selisih gol, gol dicetak). ` +
        'Tidak dapat menentukan kualifikasi knockout secara adil. ' +
        'Panitia harus menyelesaikan seri tersebut terlebih dahulu (misal via pertandingan tambahan atau keputusan manual).'
      );
    }

    qualifiers.push({
      team_id: String(first.team_id),
      team_name: String(first.team_name),
      group_code: groupCode,
      group_rank: 1,
    });
    qualifiers.push({
      team_id: String(second.team_id),
      team_name: String(second.team_name),
      group_code: groupCode,
      group_rank: 2,
    });
  }

  return qualifiers;
}

/**
 * Retrieves fixtures for a tournament, optionally filtered by stage and group.
 */
export async function getFixtures(
  db: Client,
  tournamentId: string,
  options?: { stage?: 'GROUP' | 'KNOCKOUT'; groupId?: string }
): Promise<Fixture[]> {
  let sql = 'SELECT * FROM fixtures WHERE tournament_id = ?';
  const args: (string | number)[] = [tournamentId];

  if (options?.stage) {
    sql += ' AND stage = ?';
    args.push(options.stage);
  }
  if (options?.groupId) {
    sql += ' AND group_id = ?';
    args.push(options.groupId);
  }

  sql += ' ORDER BY created_at ASC';

  const result = await db.execute({ sql, args });
  return result.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      id: String(row.id),
      tournament_id: String(row.tournament_id),
      stage: row.stage as Fixture['stage'],
      group_id: row.group_id ? String(row.group_id) : null,
      round_code: row.round_code ? String(row.round_code) : null,
      team_a_id: String(row.team_a_id),
      team_b_id: String(row.team_b_id),
      left_side_team_id: String(row.left_side_team_id),
      scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
      timezone: String(row.timezone),
      host_team_id: row.host_team_id ? String(row.host_team_id) : null,
      host_assignment_reason: row.host_assignment_reason as Fixture['host_assignment_reason'],
      status: row.status as Fixture['status'],
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  });
}
