/**
 * Flash Peak TMS - High-Performance Fuzzy Matching & Alias Dictionary
 *
 * Provides fast entity resolution and typo tolerance for Flash Peak tournament
 * teams (16 teams) and characters (21 characters). Supports common abbreviations,
 * acronyms, localized terms, and Levenshtein distance <= 2 for words >= 4 characters.
 */

export interface TeamEntity {
  name: string;
  group: string;
  aliases: string[];
}

export interface CharacterEntity {
  name: string;
  role?: string;
  aliases: string[];
}

// =============================================================================
// Authoritative Entity Catalogs
// =============================================================================

export const TEAMS: readonly TeamEntity[] = [
  {
    name: 'Kazekage',
    group: 'D',
    aliases: ['kazekage', 'kzkge', 'kge', 'kaze', 'kzk', 'kazekge', 'team kazekage'],
  },
  {
    name: 'Team Zodiac',
    group: 'D',
    aliases: ['team zodiac', 'zodiac', 'zdc', 'tz', 'zodiak', 'team zodiak', 'teamzodiac'],
  },
  {
    name: 'The Apostles Dominion',
    group: 'B',
    aliases: [
      'the apostles dominion',
      'the apostles',
      'apostles dominion',
      'apostles',
      'apostle',
      'apstl',
      'dominion',
      'theapostles',
      'apostlesdominion',
    ],
  },
  {
    name: 'Yakigami',
    group: 'B',
    aliases: ['yakigami', 'yaki', 'ykg', 'ykgm', 'yakigamy', 'team yakigami'],
  },
  {
    name: 'Jestre',
    group: 'B',
    aliases: ['jestre', 'jstr', 'jester', 'jestr', 'team jestre'],
  },
  {
    name: 'Astra Lumina Nova',
    group: 'B',
    aliases: [
      'astra lumina nova',
      'astra lumina',
      'astra nova',
      'atl nova',
      'atl',
      'aln',
      'lumina nova',
      'astralumina',
      'astranova',
      'astra',
      'lumina',
    ],
  },
  {
    name: '7Sins•BlueLock Inferno',
    group: 'D',
    aliases: [
      '7sins•bluelock inferno',
      '7sins bluelock inferno',
      '7sins inferno',
      'bluelock inferno',
      'inferno',
      'inf',
      '7sb inferno',
      '7s inferno',
      '7sb_inf',
      '7s_inf',
      '7sinsinferno',
    ],
  },
  {
    name: '7Sins•BlueLock Venom',
    group: 'A',
    aliases: [
      '7sins•bluelock venom',
      '7sins bluelock venom',
      '7sins venom',
      'bluelock venom',
      'venom',
      'vnm',
      '7sb venom',
      '7s venom',
      '7sb_vnm',
      '7s_vnm',
      '7sinsvenom',
    ],
  },
  {
    name: 'AVOID Prime',
    group: 'C',
    aliases: ['avoid prime', 'prime', 'ap', 'avd prime', 'avoidprime', 'avoid_prime'],
  },
  {
    name: 'AVOID Impact',
    group: 'C',
    aliases: ['avoid impact', 'impact', 'ai', 'avd impact', 'avoidimpact', 'avoid_impact'],
  },
  {
    name: 'Elite 8',
    group: 'C',
    aliases: ['elite 8', 'elite8', 'e8', 'elite eight', 'elite eight'],
  },
  {
    name: 'Hokage',
    group: 'D',
    aliases: ['hokage', 'hkg', 'hoka', 'team hokage'],
  },
  {
    name: 'Raikage',
    group: 'C',
    aliases: ['raikage', 'rkg', 'rai', 'team raikage'],
  },
  {
    name: 'Helix Moonbreaker',
    group: 'A',
    aliases: [
      'helix moonbreaker',
      'helix',
      'moonbreaker',
      'hmb',
      'hlx',
      'helix mb',
      'helixmoonbreaker',
    ],
  },
  {
    name: 'Agility Starlight',
    group: 'A',
    aliases: [
      'agility starlight',
      'agility',
      'starlight',
      'as',
      'ast',
      'agil',
      'agilitystarlight',
    ],
  },
  {
    name: 'Mizukage',
    group: 'A',
    aliases: ['mizukage', 'mzk', 'mkg', 'mizu', 'mizukge', 'team mizukage'],
  },
];

export const CHARACTERS: readonly CharacterEntity[] = [
  {
    name: 'Orion',
    role: 'ST',
    aliases: ['orion', 'orn', 'oryon', '奥利恩'],
  },
  {
    name: 'Hayato',
    role: 'CM',
    aliases: ['hayato', 'hyto', 'hayt', '夜神隼'],
  },
  {
    name: 'Andrew',
    role: 'CB',
    aliases: ['andrew', 'ndrw', 'andrw', 'andru', 'andre', '安德鲁'],
  },
  {
    name: 'Kelly',
    role: 'WF',
    aliases: ['kelly', 'kely', 'kel', 'klly', '凯莉'],
  },
  {
    name: 'Maxim',
    role: 'GK',
    aliases: ['maxim', 'maksim', 'max', 'mxm', '马克西姆'],
  },
  {
    name: 'Shirou',
    role: 'ST',
    aliases: ['shirou', 'shiru', 'shiro', 'shro', '士郎'],
  },
  {
    name: 'Rafael',
    role: 'ST',
    aliases: ['rafael', 'raphael', 'raf', 'rfl', '拉斐尔'],
  },
  {
    name: 'Moco',
    role: 'CM',
    aliases: ['moco', 'moko', 'mc', '莫科'],
  },
  {
    name: 'Ford',
    role: 'CB',
    aliases: ['ford', 'frd', '福特'],
  },
  {
    name: 'Homer',
    role: 'CM',
    aliases: ['homer', 'hmr', 'homr', '赫马'],
  },
  {
    name: 'Oscar',
    role: 'ST',
    aliases: ['oscar', 'oskar', 'osc', '奥斯卡'],
  },
  {
    name: 'Steffie',
    role: 'CB',
    aliases: ['steffie', 'stefie', 'steffi', 'stf', '史黛菲'],
  },
  {
    name: 'Tatsuya',
    role: 'WF',
    aliases: ['tatsuya', 'tatsu', 'ttsy', '达也'],
  },
  {
    name: 'Alvaro',
    role: 'CB',
    aliases: ['alvaro', 'alvr', 'alv'],
  },
  {
    name: 'Template',
    role: 'ST',
    aliases: ['template', 'tmpl', '模板'],
  },
  {
    name: 'Hassan',
    aliases: ['hassan', 'hasan', 'hsn'],
  },
  {
    name: 'Shuki',
    aliases: ['shuki', 'syuki', 'shk'],
  },
  {
    name: 'Kuroko',
    aliases: ['kuroko', 'krk'],
  },
  {
    name: 'Kurona',
    aliases: ['kurona', 'krn'],
  },
  {
    name: 'Charlie',
    aliases: ['charlie', 'charly', 'chrl'],
  },
  {
    name: 'Yuki',
    aliases: ['yuki', 'yk'],
  },
  // Additional known characters in universe for complete coverage
  {
    name: 'Raul',
    aliases: ['raul'],
  },
  {
    name: 'Damon',
    aliases: ['damon'],
  },
  {
    name: 'Brian',
    aliases: ['brian'],
  },
  {
    name: 'Victor',
    aliases: ['victor'],
  },
  {
    name: 'Bobby',
    aliases: ['bobby'],
  },
  {
    name: 'Karl',
    aliases: ['karl'],
  },
  {
    name: 'Biel',
    aliases: ['biel'],
  },
  {
    name: 'Alok',
    aliases: ['alok'],
  },
  {
    name: 'Chrono',
    aliases: ['chrono'],
  },
  {
    name: 'Kla',
    aliases: ['kla'],
  },
  {
    name: 'Wukong',
    aliases: ['wukong'],
  },
];

// Umbrella / family aliases that resolve to multiple teams
const UMBRELLA_TEAM_ALIASES: Record<string, string[]> = {
  '7sins': ['7Sins•BlueLock Inferno', '7Sins•BlueLock Venom'],
  bluelock: ['7Sins•BlueLock Inferno', '7Sins•BlueLock Venom'],
  '7sb': ['7Sins•BlueLock Inferno', '7Sins•BlueLock Venom'],
  avoid: ['AVOID Impact', 'AVOID Prime'],
  kage: ['Kazekage', 'Hokage', 'Raikage', 'Mizukage'],
};

// =============================================================================
// String Utilities & Levenshtein Algorithm
// =============================================================================

const ROW_BUFFER_1 = new Int32Array(128);
const ROW_BUFFER_2 = new Int32Array(128);

/**
 * Normalizes text for matching:
 * - Lowercases and strips accents/diacritics
 * - Normalizes punctuation and symbols to spaces
 * - Collapses consecutive spaces and trims
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  // Fast path for standard ASCII strings
  if (!/[\u0080-\uffff]/.test(text)) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compact normalization (removes all whitespace and symbols).
 */
export function compactText(text: string): string {
  if (!text) return '';
  if (!/[\u0080-\uffff]/.test(text)) {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * High-performance Wagner-Fischer Levenshtein distance with zero allocations and early-exit bounds.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  // Early exit if length difference exceeds max tolerated delta
  const lenDiff = Math.abs(aLen - bLen);
  if (lenDiff > 2) return lenDiff;

  if (bLen >= 127) {
    // Fallback for unusually long strings
    const prev = new Int32Array(bLen + 1);
    const curr = new Int32Array(bLen + 1);
    for (let j = 0; j <= bLen; j++) prev[j] = j;
    for (let i = 1; i <= aLen; i++) {
      curr[0] = i;
      const aCode = a.charCodeAt(i - 1);
      for (let j = 1; j <= bLen; j++) {
        const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= bLen; j++) prev[j] = curr[j];
    }
    return prev[bLen];
  }

  let prevRow = ROW_BUFFER_1;
  let currRow = ROW_BUFFER_2;

  for (let j = 0; j <= bLen; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    currRow[0] = i;
    const aCode = a.charCodeAt(i - 1);

    for (let j = 1; j <= bLen; j++) {
      const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,       // deletion
        currRow[j - 1] + 1,   // insertion
        prevRow[j - 1] + cost // substitution
      );
    }

    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[bLen];
}

// =============================================================================
// Inverted Index & Matchers
// =============================================================================

interface AliasEntry {
  alias: string;
  compact: string;
  canonicalNames: string[];
  isAbbreviation: boolean;
  length: number;
}

class EntityMatcher {
  private exactMap = new Map<string, string[]>();
  private compactMap = new Map<string, string[]>();
  private longAliases: AliasEntry[] = [];
  private cache = new Map<string, string[]>();

  constructor(
    entities: readonly { name: string; aliases: string[] }[],
    umbrellaAliases: Record<string, string[]> = {}
  ) {
    // 1. Index umbrella aliases
    for (const [alias, names] of Object.entries(umbrellaAliases)) {
      const norm = normalizeText(alias);
      const comp = compactText(alias);
      if (norm) this.exactMap.set(norm, [...names]);
      if (comp) this.compactMap.set(comp, [...names]);
    }

    // 2. Index entity-specific aliases
    for (const entity of entities) {
      const allAliases = new Set<string>();
      allAliases.add(normalizeText(entity.name));
      for (const a of entity.aliases) {
        const norm = normalizeText(a);
        if (norm) allAliases.add(norm);
      }

      for (const alias of allAliases) {
        const comp = compactText(alias);
        const existingNorm = this.exactMap.get(alias) || [];
        if (!existingNorm.includes(entity.name)) {
          existingNorm.push(entity.name);
          this.exactMap.set(alias, existingNorm);
        }

        const existingComp = this.compactMap.get(comp) || [];
        if (!existingComp.includes(entity.name)) {
          existingComp.push(entity.name);
          this.compactMap.set(comp, existingComp);
        }

        // Candidates for typo tolerance (length >= 4)
        if (alias.length >= 4) {
          this.longAliases.push({
            alias,
            compact: comp,
            canonicalNames: [entity.name],
            isAbbreviation: false,
            length: alias.length,
          });
        }
      }
    }
  }

  /**
   * Matches a raw query string against the entity catalog.
   * Returns a deduplicated array of canonical names sorted by match confidence.
   */
  public match(rawQuery: string): string[] {
    const cached = this.cache.get(rawQuery);
    if (cached) return cached;

    const query = normalizeText(rawQuery);
    if (!query) {
      this.cache.set(rawQuery, []);
      return [];
    }

    const compQuery = compactText(query);
    const matchedNames: string[] = [];
    const seen = new Set<string>();

    const addMatches = (names: string[]) => {
      for (const name of names) {
        if (!seen.has(name)) {
          seen.add(name);
          matchedNames.push(name);
        }
      }
    };

    const finish = (result: string[]): string[] => {
      if (this.cache.size >= 1000) {
        this.cache.clear();
      }
      this.cache.set(rawQuery, result);
      return result;
    };

    // Phase 1: Whole-query exact match (or compact match)
    if (this.exactMap.has(query)) {
      addMatches(this.exactMap.get(query)!);
      return finish(matchedNames);
    }
    if (this.compactMap.has(compQuery)) {
      addMatches(this.compactMap.get(compQuery)!);
      return finish(matchedNames);
    }

    // Phase 2: Whole-query typo tolerance
    if (query.length >= 4) {
      const maxAllowedDist = query.length >= 6 ? 2 : 1;
      const candidates: Array<{ name: string; dist: number }> = [];
      for (const entry of this.longAliases) {
        if (Math.abs(query.length - entry.length) <= maxAllowedDist) {
          const dist = levenshteinDistance(query, entry.alias);
          if (dist <= maxAllowedDist) {
            for (const name of entry.canonicalNames) {
              candidates.push({ name, dist });
            }
          }
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => a.dist - b.dist);
        addMatches(candidates.map((c) => c.name));
        return finish(matchedNames);
      }
    }

    // Phase 3: Token and n-gram phrase matching (for multi-word queries / sentences)
    const tokens = query.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      // 3A: Check 3-gram and 2-gram multi-word phrases first
      for (let len = Math.min(tokens.length, 3); len >= 2; len--) {
        for (let i = 0; i <= tokens.length - len; i++) {
          const phrase = tokens.slice(i, i + len).join(' ');
          const compPhrase = compactText(phrase);

          if (this.exactMap.has(phrase)) {
            addMatches(this.exactMap.get(phrase)!);
          } else if (this.compactMap.has(compPhrase)) {
            addMatches(this.compactMap.get(compPhrase)!);
          } else if (phrase.length >= 4) {
            for (const entry of this.longAliases) {
              if (Math.abs(phrase.length - entry.length) <= 2) {
                const dist = levenshteinDistance(phrase, entry.alias);
                if (dist <= 2) {
                  addMatches(entry.canonicalNames);
                }
              }
            }
          }
        }
      }

      // 3B: Check individual tokens
      for (const token of tokens) {
        // Skip common stop-words
        if (isStopWord(token)) continue;

        if (this.exactMap.has(token)) {
          addMatches(this.exactMap.get(token)!);
        } else if (token.length >= 4) {
          // Typo tolerance on individual tokens (require dist <= 1 for 4-5 chars, dist <= 2 for 6+ chars)
          const maxAllowedDist = token.length >= 6 ? 2 : 1;
          const tokenCandidates: Array<{ name: string; dist: number }> = [];
          for (const entry of this.longAliases) {
            if (Math.abs(token.length - entry.length) <= maxAllowedDist) {
              const dist = levenshteinDistance(token, entry.alias);
              if (dist <= maxAllowedDist) {
                for (const name of entry.canonicalNames) {
                  tokenCandidates.push({ name, dist });
                }
              }
            }
          }
          tokenCandidates.sort((a, b) => a.dist - b.dist);
          addMatches(tokenCandidates.map((c) => c.name));
        }
      }
    }

    return finish(matchedNames);
  }
}

function isStopWord(token: string): boolean {
  const STOP_WORDS = new Set([
    'vs', 'versus', 'dan', 'and', 'lawan', 'jadwal', 'score', 'skor', 'hasil',
    'ronde', 'round', 'grup', 'group', 'tim', 'team', 'di', 'ke', 'dari', 'siapa',
    'kapan', 'main', 'tanding', 'kiper', 'roster', 'lineup', 'nanti', 'malam',
    'bocoran', 'cara', 'counter', 'buat', 'untuk', 'sama', 'dengan',
    'halo', 'hai', 'hello', 'omak', 'peak', 'pagi', 'siang', 'sore',
    'apa', 'aja', 'siap', 'oke', 'iya', 'nggak', 'gak', 'bisa', 'dong', 'bang',
    'bro', 'min', 'besok', 'bsk', 'kemarin', 'lusa', 'hari', 'ini', 'itu', 'ada',
    'makasih', 'makasi', 'mksih', 'terima', 'kasih', 'thanks', 'thx', 'info', 'infonya', 'inpo', 'inponya', 'ya', 'yah'
  ]);
  return STOP_WORDS.has(token);
}

// Initialized singletons
const TEAM_MATCHER = new EntityMatcher(TEAMS, UMBRELLA_TEAM_ALIASES);
const CHARACTER_MATCHER = new EntityMatcher(CHARACTERS);

// =============================================================================
// Exported API
// =============================================================================

/**
 * Matches a query string to Flash Peak tournament team entities.
 * Supports abbreviations (kge, kzkge, zdc, tz, apstl, yaki, jstr, atl nova, inf, vnm, ap, ai, e8, hkg, rkg, hmb)
 * and Levenshtein typo tolerance <= 2 on words >= 4 chars.
 */
export function matchTeams(query: string): string[] {
  return TEAM_MATCHER.match(query);
}

/**
 * Matches a query string to Flash Peak character entities.
 * Supports abbreviations (hmr, ndrw, frd, orn, hyto, klly, mxm, shro, rfl, mc, osc, stf, ttsy, alv)
 * and Levenshtein typo tolerance <= 2 on words >= 4 chars.
 */
export function matchCharacters(query: string): string[] {
  return CHARACTER_MATCHER.match(query);
}

/**
 * Returns the best (single) matched team, or null if no match found.
 */
export function findBestTeamMatch(query: string): string | null {
  const matches = matchTeams(query);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Returns the best (single) matched character, or null if no match found.
 */
export function findBestCharacterMatch(query: string): string | null {
  const matches = matchCharacters(query);
  return matches.length > 0 ? matches[0] : null;
}
