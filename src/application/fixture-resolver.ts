/**
 * Flash Peak TMS - Fixture Resolution Service (Application Layer)
 * 
 * Resolves incoming WhatsApp match report messages to active tournament fixtures:
 * 1. Explicit Caption / Text match (Highest Priority)
 *    - Detects mentioned team names, abbreviations, and codes in captions via word-boundary regex
 *    - Evaluates explicit winner declarations ('pemenang', 'menang', 'win', 'juara')
 * 2. Identity-based Auto-Lock (Fallback when caption has no team name)
 *    - Resolves verified sender delegate to their registered team
 *    - Finds the team's earliest active scheduled fixture
 * 3. Fallback for organizer or unattached submissions
 *    - Returns the earliest scheduled fixture in the active tournament
 */

import type { Client } from '@libsql/client';
import type { IdentityResolver } from '../identity/resolver.js';
import type { NormalizedMessage } from '../whatsapp/types.js';

export interface MatchedFixtureResult {
  id: string;
  team_a_id: string;
  submitting_team_id?: string;
}

const KNOWN_TEAM_ALIASES: Record<string, string[]> = {
  '7sins•bluelock venom': ['7sb', '7sb venom', 'bluelock venom', 'venom'],
  '7sins•bluelock inferno': ['7sb', '7sb inferno', 'bluelock inferno', 'inferno'],
  'astra lumina nova': ['atl', 'atl nova', 'astra', 'lumina', 'nova'],
  'the apostles dominion': ['dom', 'apostles', 'dominion', 'apostle'],
  'agility starlight': ['agl', 'agility', 'starlight'],
  'avoid prime': ['avo', 'avoid', 'prime', 'avp'],
  'avoid impact': ['avo', 'avoid', 'impact', 'avi'],
  'helix moonbreaker': ['moon', 'helix', 'moonbreaker', 'hlx'],
  'elite 8': ['e8', 'elite', 'elite8', 'elite 8'],
  'team zodiac': ['zod', 'zodiac'],
  'hokage': ['hok', 'hokage'],
  'kazekage': ['kzk', 'kazekage'],
  'mizukage': ['miz', 'mizukage'],
  'raikage': ['rai', 'raikage'],
  'yakigami': ['yak', 'yakigami'],
  'jestre': ['jst', 'jestre'],
};

function getTeamAliases(teamName: string, teamCode: string | null): string[] {
  const aliases = new Set<string>();
  const lowerName = teamName.toLowerCase().trim();
  aliases.add(lowerName);

  if (teamCode && teamCode.trim()) {
    aliases.add(teamCode.trim().toLowerCase());
  }

  // Check dictionary of known team aliases
  const known = KNOWN_TEAM_ALIASES[lowerName];
  if (known) {
    for (const a of known) {
      aliases.add(a.toLowerCase());
    }
  }

  // Split tokens by spaces, bullets (•), dashes, underscores, slashes
  const tokens = lowerName
    .split(/[\s•\-_/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const stopWords = new Set(['the', 'team', 'fc', 'club', 'esports', 'gaming']);

  for (const token of tokens) {
    if (token.length >= 4 && !stopWords.has(token)) {
      aliases.add(token);
    }
    if (teamCode && teamCode.trim()) {
      aliases.add(`${teamCode.trim().toLowerCase()} ${token}`);
    }
  }

  return Array.from(aliases);
}

function detectWinnerTeamId(
  team1: { id: string; matchedAliases: string[] },
  team2: { id: string; matchedAliases: string[] },
  caption: string
): string | null {
  const lowerCaption = caption.toLowerCase();

  // 1. Direct prefix winner declaration, e.g. "win 7sb venom", "menang agility", "pemenang: atl"
  let bestT1Len = 0;
  for (const alias of team1.matchedAliases) {
    const esc = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:pemenang|menang|win|winner|juara)[:\\s]+${esc}(?:$|\\s|[^a-zA-Z0-9])`, 'i');
    if (pattern.test(lowerCaption) && alias.length > bestT1Len) {
      bestT1Len = alias.length;
    }
  }

  let bestT2Len = 0;
  for (const alias of team2.matchedAliases) {
    const esc = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:pemenang|menang|win|winner|juara)[:\\s]+${esc}(?:$|\\s|[^a-zA-Z0-9])`, 'i');
    if (pattern.test(lowerCaption) && alias.length > bestT2Len) {
      bestT2Len = alias.length;
    }
  }

  if (bestT1Len > bestT2Len) return team1.id;
  if (bestT2Len > bestT1Len) return team2.id;
  if (bestT1Len > 0 && bestT1Len === bestT2Len) return team1.id;

  // 2. Postfix winner declaration, e.g. "7sb venom menang", "agility win"
  let postT1Len = 0;
  for (const alias of team1.matchedAliases) {
    const esc = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\s|[^a-zA-Z0-9])${esc}[:\\s]+(?:pemenang|menang|win|winner|juara)(?:$|\\s|[^a-zA-Z0-9])`, 'i');
    if (pattern.test(lowerCaption) && alias.length > postT1Len) {
      postT1Len = alias.length;
    }
  }

  let postT2Len = 0;
  for (const alias of team2.matchedAliases) {
    const esc = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\s|[^a-zA-Z0-9])${esc}[:\\s]+(?:pemenang|menang|win|winner|juara)(?:$|\\s|[^a-zA-Z0-9])`, 'i');
    if (pattern.test(lowerCaption) && alias.length > postT2Len) {
      postT2Len = alias.length;
    }
  }

  if (postT1Len > postT2Len) return team1.id;
  if (postT2Len > postT1Len) return team2.id;

  return null;
}

/**
 * AUDIT-VERIFY-T4 (21 Nov 2026): the BO1 group-stage evidence pipeline must
 * never target a KNOCKOUT fixture. Knockout series are BO3/BO5 managed by the
 * dedicated !kogame per-game pipeline (ko-evidence-pipeline.ts); a plain photo
 * without a !kogame caption used to resolve to an active knockout fixture here
 * and produced a parallel BO1 draft for a series that already has its own
 * state machine. All queries below filter stage = 'GROUP'.
 */
export async function resolveFixtureForMessage(
  db: Client,
  identityResolver: IdentityResolver,
  message: NormalizedMessage
): Promise<MatchedFixtureResult | null> {
  const captionText = (message.caption || message.text_body || '').trim();

  // Pre-resolve sender identity so we know the sender's team if verified
  let senderTeamId: string | null = null;
  try {
    const resolvedIdentity = await identityResolver.resolveIdentity(
      message.sender_raw_address,
      message.chat_id
    );

    if (resolvedIdentity.status === 'VERIFIED' && resolvedIdentity.team) {
      senderTeamId = resolvedIdentity.team.id;
    }
  } catch (err) {
    console.warn('[FixtureResolver] Error resolving identity for fixture lookup:', err);
  }

  // 1. Explicit Caption / Text match (Highest Priority)
  if (captionText) {
    const teamsRes = await db.execute({
      sql: `
        SELECT t.id, t.team_name, t.team_code
        FROM teams t
        JOIN tournaments tr ON t.tournament_id = tr.id
        WHERE tr.status = 'ACTIVE'
      `,
      args: [],
    });

    interface MatchedCandidate {
      id: string;
      team_name: string;
      matchedAliases: string[];
    }

    const candidateTeams: MatchedCandidate[] = [];
    for (const row of teamsRes.rows) {
      const tId = String(row.id ?? row[0]);
      const tName = String(row.team_name ?? row[1]);
      const tCode = row.team_code ? String(row.team_code) : (row[2] ? String(row[2]) : null);

      const aliases = getTeamAliases(tName, tCode);
      const matchedAliases: string[] = [];
      for (const alias of aliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|\\s|[^a-zA-Z0-9])${escaped}($|\\s|[^a-zA-Z0-9])`, 'i');
        if (pattern.test(captionText)) {
          matchedAliases.push(alias);
        }
      }

      if (matchedAliases.length > 0) {
        matchedAliases.sort((a, b) => b.length - a.length);
        candidateTeams.push({ id: tId, team_name: tName, matchedAliases });
      }
    }

    // Discard any candidate whose matched aliases are strictly subsumed by another candidate's compound matches
    const filteredTeams = candidateTeams.filter((candidate) => {
      const isSubsumed = candidateTeams.some((other) => {
        if (other.id === candidate.id) return false;
        return candidate.matchedAliases.every((candAlias) =>
          other.matchedAliases.some(
            (otherAlias) => otherAlias.length > candAlias.length && otherAlias.includes(candAlias)
          )
        );
      });
      return !isSubsumed;
    });

    if (filteredTeams.length >= 2) {
      let matchedFixtureRow: any = null;
      let fixtureTeam1: MatchedCandidate | null = null;
      let fixtureTeam2: MatchedCandidate | null = null;

      for (let i = 0; i < filteredTeams.length; i++) {
        for (let j = i + 1; j < filteredTeams.length; j++) {
          const t1 = filteredTeams[i];
          const t2 = filteredTeams[j];
          const fRes = await db.execute({
            sql: `
              SELECT f.id, f.team_a_id, f.team_b_id
              FROM fixtures f
              JOIN tournaments tr ON f.tournament_id = tr.id
              WHERE tr.status = 'ACTIVE'
                AND f.stage = 'GROUP'
                AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
                AND ((f.team_a_id = ? AND f.team_b_id = ?) OR (f.team_a_id = ? AND f.team_b_id = ?))
              ORDER BY f.round_code ASC, f.created_at ASC
              LIMIT 1
            `,
            args: [t1.id, t2.id, t2.id, t1.id],
          });
          if (fRes.rows.length > 0 && fRes.rows[0]) {
            matchedFixtureRow = fRes.rows[0];
            fixtureTeam1 = t1;
            fixtureTeam2 = t2;
            break;
          }
        }
        if (matchedFixtureRow) break;
      }

      if (matchedFixtureRow && fixtureTeam1 && fixtureTeam2) {
        let winnerId = detectWinnerTeamId(fixtureTeam1, fixtureTeam2, captionText);
        if (!winnerId) {
          if (senderTeamId === fixtureTeam2.id) {
            winnerId = fixtureTeam2.id;
          } else {
            winnerId = fixtureTeam1.id;
          }
        }
        return {
          id: String(matchedFixtureRow.id ?? matchedFixtureRow[0]),
          team_a_id: String(matchedFixtureRow.team_a_id ?? matchedFixtureRow[1]),
          submitting_team_id: winnerId,
        };
      }
    }

    if (filteredTeams.length >= 1) {
      const winnerTeam = filteredTeams[0];
      const matchedFixture = await db.execute({
        sql: `
          SELECT f.id, f.team_a_id
          FROM fixtures f
          JOIN tournaments tr ON f.tournament_id = tr.id
          WHERE tr.status = 'ACTIVE'
            AND f.stage = 'GROUP'
            AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
            AND (f.team_a_id = ? OR f.team_b_id = ?)
          ORDER BY f.round_code ASC, f.created_at ASC
          LIMIT 1
        `,
        args: [winnerTeam.id, winnerTeam.id],
      });
      if (matchedFixture.rows.length > 0 && matchedFixture.rows[0]) {
        const mRow = matchedFixture.rows[0];
        return {
          id: String(mRow.id ?? mRow[0]),
          team_a_id: String(mRow.team_a_id ?? mRow[1]),
          submitting_team_id: winnerTeam.id,
        };
      }
    }
  }

  // 2. Identity-based Auto-Lock (Fallback when caption has no team name)
  if (senderTeamId) {
    const teamFixture = await db.execute({
      sql: `
        SELECT f.id, f.team_a_id
        FROM fixtures f
        JOIN tournaments t ON f.tournament_id = t.id
        WHERE t.status = 'ACTIVE'
          AND f.stage = 'GROUP'
          AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
          AND (f.team_a_id = ? OR f.team_b_id = ?)
        ORDER BY f.round_code ASC, f.created_at ASC
        LIMIT 1
      `,
      args: [senderTeamId, senderTeamId],
    });
    if (teamFixture.rows.length > 0 && teamFixture.rows[0]) {
      const row = teamFixture.rows[0];
      return {
        id: String(row.id ?? row[0]),
        team_a_id: String(row.team_a_id ?? row[1]),
        submitting_team_id: senderTeamId,
      };
    }
  }

  // 3. Fallback for organizer or unattached submissions: first scheduled match in active tournament
  const fallback = await db.execute({
    sql: `
      SELECT f.id, f.team_a_id
      FROM fixtures f
      JOIN tournaments tr ON f.tournament_id = tr.id
      WHERE tr.status = 'ACTIVE'
        AND f.stage = 'GROUP'
        AND f.status IN ('SCHEDULED', 'IN_PROGRESS')
      ORDER BY f.round_code ASC, f.created_at ASC
      LIMIT 1
    `,
    args: [],
  });

  if (fallback.rows.length > 0 && fallback.rows[0]) {
    const fbRow = fallback.rows[0];
    return {
      id: String(fbRow.id ?? fbRow[0]),
      team_a_id: String(fbRow.team_a_id ?? fbRow[1]),
    };
  }

  return null;
}
