/**
 * Flash Peak TMS - Backend Report Validation Engine (Task 5.2)
 * 
 * Deterministic business validation layer (AI_PIPELINE.md §6, ARCHITECTURE.md §8).
 * Never trusts LLM totals — recomputes and validates all sums in authoritative backend code.
 * 
 * Validations enforced:
 * 1. Lineup count: Exactly 5 active players per side (1 GOALKEEPER, 4 OUTFIELD).
 * 2. Roster membership: Every player must be a registered member of that team in `players` table.
 * 3. Duplicate player detection: No player may appear more than once in a lineup or on both sides.
 * 4. Numeric validity: Scores, goals, assists, passes, defense, saves >= 0; ratings non-negative.
 * 5. Score consistency: Recalculated sum of player goals must match team score.
 * 6. Fixture context: Teams and game must strictly match fixture records.
 * 7. Goalkeeper saves mapping: Map summary DEFENSE to goalkeeper_saves for confirmed keepers (FR-GK-003).
 */

import type { Client } from '@libsql/client';
import type {
  ValidatedMatchData,
  Player,
  UUID,
} from '../shared/types/index.js';

export interface RawPlayerMatchStat {
  player_id?: UUID;
  nickname_raw: string;
  rating?: number | null;
  goals?: number | null;
  assists?: number | null;
  passes?: number | null;
  defense_raw?: number | null;
  goalkeeper_saves?: number | null;
}

export interface MatchValidationInput {
  fixture_id: UUID;
  game_id: UUID;
  team_a_id: UUID;
  team_b_id: UUID;
  team_a_score: number;
  team_b_score: number;
  team_a_players: RawPlayerMatchStat[];
  team_b_players: RawPlayerMatchStat[];
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  validatedData?: ValidatedMatchData;
  recalculatedScoreA: number;
  recalculatedScoreB: number;
}

/**
 * Normalizes a nickname for lookup comparison (NFC + trimmed + lowercased).
 */
function normalizeNickname(nick: string): string {
  return nick.normalize('NFC').trim().toLowerCase();
}

/**
 * Deterministically validates a match report against database records and game rules.
 */
export async function validateMatchReport(
  db: Client,
  input: MatchValidationInput
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Fixture & Game Context Checks
  const fixtureResult = await db.execute({
    sql: 'SELECT id, tournament_id, team_a_id, team_b_id, status FROM fixtures WHERE id = ?',
    args: [input.fixture_id],
  });

  if (fixtureResult.rows.length === 0) {
    errors.push(`Fixture not found: ${input.fixture_id}`);
    return {
      isValid: false,
      errors,
      warnings,
      recalculatedScoreA: 0,
      recalculatedScoreB: 0,
    };
  }

  const fixtureRow = fixtureResult.rows[0];
  const fixtureTeamAId = String(fixtureRow[2]);
  const fixtureTeamBId = String(fixtureRow[3]);

  if (input.team_a_id !== fixtureTeamAId || input.team_b_id !== fixtureTeamBId) {
    // If swapped, report clear error
    if (input.team_a_id === fixtureTeamBId && input.team_b_id === fixtureTeamAId) {
      errors.push(
        `Team sides are inverted compared to fixture: Team A expected ${fixtureTeamAId}, got ${input.team_a_id}`
      );
    } else {
      errors.push(
        `Teams in report (${input.team_a_id}, ${input.team_b_id}) do not match fixture teams (${fixtureTeamAId}, ${fixtureTeamBId})`
      );
    }
  }

  const gameResult = await db.execute({
    sql: 'SELECT id, fixture_id, status FROM games WHERE id = ?',
    args: [input.game_id],
  });

  if (gameResult.rows.length === 0) {
    errors.push(`Game not found: ${input.game_id}`);
  } else if (String(gameResult.rows[0][1]) !== input.fixture_id) {
    errors.push(`Game ${input.game_id} does not belong to fixture ${input.fixture_id}`);
  }

  // 2. Score Range Checks
  if (input.team_a_score < 0 || !Number.isInteger(input.team_a_score)) {
    errors.push(`Team A score must be a non-negative integer (got ${input.team_a_score})`);
  }
  if (input.team_b_score < 0 || !Number.isInteger(input.team_b_score)) {
    errors.push(`Team B score must be a non-negative integer (got ${input.team_b_score})`);
  }

  // 3. Player Counts per Side (Exactly 5 active players per side in lineup)
  if (input.team_a_players.length !== 5) {
    errors.push(
      `Team A must have exactly 5 players in the lineup (1 GK, 4 outfield), got ${input.team_a_players.length}`
    );
  }
  if (input.team_b_players.length !== 5) {
    errors.push(
      `Team B must have exactly 5 players in the lineup (1 GK, 4 outfield), got ${input.team_b_players.length}`
    );
  }

  // 4. Fetch registered rosters from DB
  const rosterResult = await db.execute({
    sql: `
      SELECT id, tournament_id, team_id, nickname_raw, nickname_nfc,
             nickname_search_key, position, roster_slot, roster_type, status
      FROM players
      WHERE team_id IN (?, ?) AND status = 'ACTIVE'
    `,
    args: [input.team_a_id, input.team_b_id],
  });

  const registeredPlayers: Player[] = rosterResult.rows.map((row) => ({
    id: String(row[0]),
    tournament_id: String(row[1]),
    team_id: String(row[2]),
    nickname_raw: String(row[3]),
    nickname_nfc: String(row[4]),
    nickname_search_key: String(row[5]),
    position: String(row[6]) as Player['position'],
    roster_slot: Number(row[7]),
    roster_type: String(row[8]) as Player['roster_type'],
    status: String(row[9]) as Player['status'],
    created_at: '',
    updated_at: '',
  }));

  const rosterA = registeredPlayers.filter((p) => p.team_id === input.team_a_id);
  const rosterB = registeredPlayers.filter((p) => p.team_id === input.team_b_id);

  // Helper to match a raw player to registered player
  function matchPlayer(raw: RawPlayerMatchStat, roster: Player[]): Player | null {
    if (raw.player_id) {
      const matchById = roster.find((p) => p.id === raw.player_id);
      if (matchById) return matchById;
    }

    const norm = normalizeNickname(raw.nickname_raw);

    // 1. Exact raw match
    const exact = roster.find((p) => p.nickname_raw === raw.nickname_raw);
    if (exact) return exact;

    // 2. NFC normalized match
    const nfcMatch = roster.find((p) => normalizeNickname(p.nickname_nfc) === norm);
    if (nfcMatch) return nfcMatch;

    // 3. Search key match
    const searchMatch = roster.find((p) => p.nickname_search_key === norm);
    if (searchMatch) return searchMatch;

    return null;
  }

  // 5. Validate Team A Lineup
  const resolvedTeamAPlayers: ValidatedMatchData['team_a_players'] = [];
  const seenPlayerIdsA = new Set<string>();
  let teamAGkCount = 0;
  let teamAOutfieldCount = 0;
  let sumGoalsA = 0;

  for (let idx = 0; idx < input.team_a_players.length; idx++) {
    const p = input.team_a_players[idx];
    const registered = matchPlayer(p, rosterA);

    if (!registered) {
      errors.push(
        `Team A player #${idx + 1} "${p.nickname_raw}" is not a registered active player on Team A`
      );
    } else {
      if (seenPlayerIdsA.has(registered.id)) {
        errors.push(`Duplicate player detected in Team A lineup: "${registered.nickname_raw}"`);
      }
      seenPlayerIdsA.add(registered.id);

      if (registered.position === 'GOALKEEPER') {
        teamAGkCount++;
      } else {
        teamAOutfieldCount++;
      }
    }

    // Validate numeric stats
    const goals = p.goals ?? 0;
    const assists = p.assists ?? 0;
    const passes = p.passes ?? 0;
    const defenseRaw = p.defense_raw ?? 0;
    let saves = p.goalkeeper_saves ?? null;

    if (goals < 0 || !Number.isInteger(goals)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid goals: ${goals}`);
    }
    if (assists < 0 || !Number.isInteger(assists)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid assists: ${assists}`);
    }
    if (passes < 0 || !Number.isInteger(passes)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid passes: ${passes}`);
    }
    if (defenseRaw < 0 || !Number.isInteger(defenseRaw)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid defense: ${defenseRaw}`);
    }
    if (p.rating !== null && p.rating !== undefined && (p.rating < 0 || isNaN(p.rating))) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid rating: ${p.rating}`);
    }

    // Map goalkeeper DEFENSE to saves if registered as GK and saves not explicitly specified
    if (registered && registered.position === 'GOALKEEPER') {
      if (saves === null) {
        saves = defenseRaw; // FR-GK-003: map summary DEFENSE to goalkeeper_saves
      }
    } else {
      // Outfield player saves should be null
      saves = null;
    }

    sumGoalsA += Math.max(0, goals);

    resolvedTeamAPlayers.push({
      player_id: registered ? registered.id : (p.player_id || ''),
      nickname_raw: p.nickname_raw,
      rating: p.rating ?? null,
      goals: Math.max(0, goals),
      assists: Math.max(0, assists),
      passes: Math.max(0, passes),
      defense_raw: Math.max(0, defenseRaw),
      goalkeeper_saves: saves,
    });
  }

  // 6. Validate Team B Lineup
  const resolvedTeamBPlayers: ValidatedMatchData['team_b_players'] = [];
  const seenPlayerIdsB = new Set<string>();
  let teamBGkCount = 0;
  let teamBOutfieldCount = 0;
  let sumGoalsB = 0;

  for (let idx = 0; idx < input.team_b_players.length; idx++) {
    const p = input.team_b_players[idx];
    const registered = matchPlayer(p, rosterB);

    if (!registered) {
      errors.push(
        `Team B player #${idx + 1} "${p.nickname_raw}" is not a registered active player on Team B`
      );
    } else {
      if (seenPlayerIdsB.has(registered.id)) {
        errors.push(`Duplicate player detected in Team B lineup: "${registered.nickname_raw}"`);
      }
      seenPlayerIdsB.add(registered.id);

      // Cross-team check
      if (seenPlayerIdsA.has(registered.id)) {
        errors.push(
          `Player "${registered.nickname_raw}" appears on BOTH Team A and Team B in the same match`
        );
      }

      if (registered.position === 'GOALKEEPER') {
        teamBGkCount++;
      } else {
        teamBOutfieldCount++;
      }
    }

    // Validate numeric stats
    const goals = p.goals ?? 0;
    const assists = p.assists ?? 0;
    const passes = p.passes ?? 0;
    const defenseRaw = p.defense_raw ?? 0;
    let saves = p.goalkeeper_saves ?? null;

    if (goals < 0 || !Number.isInteger(goals)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid goals: ${goals}`);
    }
    if (assists < 0 || !Number.isInteger(assists)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid assists: ${assists}`);
    }
    if (passes < 0 || !Number.isInteger(passes)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid passes: ${passes}`);
    }
    if (defenseRaw < 0 || !Number.isInteger(defenseRaw)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid defense: ${defenseRaw}`);
    }
    if (p.rating !== null && p.rating !== undefined && (p.rating < 0 || isNaN(p.rating))) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid rating: ${p.rating}`);
    }

    // Map goalkeeper DEFENSE to saves if registered as GK
    if (registered && registered.position === 'GOALKEEPER') {
      if (saves === null) {
        saves = defenseRaw; // FR-GK-003
      }
    } else {
      saves = null;
    }

    sumGoalsB += Math.max(0, goals);

    resolvedTeamBPlayers.push({
      player_id: registered ? registered.id : (p.player_id || ''),
      nickname_raw: p.nickname_raw,
      rating: p.rating ?? null,
      goals: Math.max(0, goals),
      assists: Math.max(0, assists),
      passes: Math.max(0, passes),
      defense_raw: Math.max(0, defenseRaw),
      goalkeeper_saves: saves,
    });
  }

  // 7. Check 1 GK + 4 Outfield composition (when all 5 players are registered)
  if (input.team_a_players.length === 5 && seenPlayerIdsA.size === 5) {
    if (teamAGkCount !== 1 || teamAOutfieldCount !== 4) {
      errors.push(
        `Team A lineup must contain exactly 1 GOALKEEPER and 4 OUTFIELD players (got ${teamAGkCount} GK, ${teamAOutfieldCount} outfield)`
      );
    }
  }

  if (input.team_b_players.length === 5 && seenPlayerIdsB.size === 5) {
    if (teamBGkCount !== 1 || teamBOutfieldCount !== 4) {
      errors.push(
        `Team B lineup must contain exactly 1 GOALKEEPER and 4 OUTFIELD players (got ${teamBGkCount} GK, ${teamBOutfieldCount} outfield)`
      );
    }
  }

  // 8. Recompute & Validate Score Consistency (ARCHITECTURE.md §8)
  // Backend recomputes individual goal sums and compares to team score
  if (input.team_a_score !== sumGoalsA) {
    errors.push(
      `Score inconsistency for Team A: team score is ${input.team_a_score}, but sum of individual player goals is ${sumGoalsA}`
    );
  }

  if (input.team_b_score !== sumGoalsB) {
    errors.push(
      `Score inconsistency for Team B: team score is ${input.team_b_score}, but sum of individual player goals is ${sumGoalsB}`
    );
  }

  const isValid = errors.length === 0;

  const validatedData: ValidatedMatchData | undefined = isValid
    ? {
        fixture_id: input.fixture_id,
        game_id: input.game_id,
        team_a_id: input.team_a_id,
        team_b_id: input.team_b_id,
        team_a_score: input.team_a_score,
        team_b_score: input.team_b_score,
        team_a_players: resolvedTeamAPlayers,
        team_b_players: resolvedTeamBPlayers,
      }
    : undefined;

  return {
    isValid,
    errors,
    warnings,
    validatedData,
    recalculatedScoreA: sumGoalsA,
    recalculatedScoreB: sumGoalsB,
  };
}
