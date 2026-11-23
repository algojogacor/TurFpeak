/**
 * Flash Peak TMS - Unit Tests for Omak Peak Fuzzy Matching & Alias Dictionary
 *
 * Validates:
 * - All 16 tournament teams matched accurately
 * - All 21 character entities matched accurately
 * - Mandatory abbreviation resolution (kge, kzkge, zdc, tz, apstl, yaki, jstr, atl nova, inf, vnm, ap, ai, e8, hkg, rkg, hmb, hmr, ndrw)
 * - Typo tolerance with Levenshtein distance <= 2 on words >= 4 characters
 * - Strict rejection of non-matching queries and typos on short words (< 4 chars)
 * - Multi-entity sentence parsing ("kzkge vs zdc", "andrew dan ford")
 * - Sub-millisecond execution performance across batch lookups
 */

import { describe, it, expect } from 'vitest';
import {
  matchTeams,
  matchCharacters,
  findBestTeamMatch,
  findBestCharacterMatch,
  levenshteinDistance,
  normalizeText,
  TEAMS,
  CHARACTERS,
} from '../../src/application/omak-peak-fuzzy.js';

describe('omak-peak-fuzzy module', () => {
  describe('Levenshtein distance algorithm', () => {
    it('computes exact distance for standard cases', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
      expect(levenshteinDistance('andrew', 'andrew')).toBe(0);
      expect(levenshteinDistance('andrw', 'andrew')).toBe(1);
      expect(levenshteinDistance('andreww', 'andrew')).toBe(1);
      expect(levenshteinDistance('zodiak', 'zodiac')).toBe(1);
      expect(levenshteinDistance('', 'abc')).toBe(3);
      expect(levenshteinDistance('abc', '')).toBe(3);
    });

    it('early-exits when length difference exceeds 2', () => {
      expect(levenshteinDistance('a', 'abcde')).toBeGreaterThan(2);
    });
  });

  describe('normalizeText', () => {
    it('normalizes case, punctuation, and multiple spaces', () => {
      expect(normalizeText('  7Sins•BlueLock  Venom! ')).toBe('7sins bluelock venom');
      expect(normalizeText('Team-Zodiac / TZ')).toBe('team zodiac tz');
      expect(normalizeText('Kazekage...')).toBe('kazekage');
      expect(normalizeText('')).toBe('');
    });
  });

  describe('All 16 Tournament Teams matching', () => {
    it('contains exactly 16 authoritative tournament teams', () => {
      expect(TEAMS).toHaveLength(16);
      const teamNames = TEAMS.map((t) => t.name);
      expect(teamNames).toContain('Kazekage');
      expect(teamNames).toContain('Team Zodiac');
      expect(teamNames).toContain('The Apostles Dominion');
      expect(teamNames).toContain('Yakigami');
      expect(teamNames).toContain('Jestre');
      expect(teamNames).toContain('Astra Lumina Nova');
      expect(teamNames).toContain('7Sins•BlueLock Inferno');
      expect(teamNames).toContain('7Sins•BlueLock Venom');
      expect(teamNames).toContain('AVOID Prime');
      expect(teamNames).toContain('AVOID Impact');
      expect(teamNames).toContain('Elite 8');
      expect(teamNames).toContain('Hokage');
      expect(teamNames).toContain('Raikage');
      expect(teamNames).toContain('Helix Moonbreaker');
      expect(teamNames).toContain('Agility Starlight');
      expect(teamNames).toContain('Mizukage');
    });

    it('resolves every team by its exact canonical name', () => {
      for (const team of TEAMS) {
        const result = matchTeams(team.name);
        expect(result).toContain(team.name);
      }
    });
  });

  describe('Mandatory team abbreviations resolution', () => {
    it('resolves kge to Kazekage', () => {
      expect(matchTeams('kge')).toContain('Kazekage');
    });

    it('resolves kzkge to Kazekage', () => {
      expect(matchTeams('kzkge')).toEqual(['Kazekage']);
    });

    it('resolves zdc to Team Zodiac', () => {
      expect(matchTeams('zdc')).toEqual(['Team Zodiac']);
    });

    it('resolves tz to Team Zodiac', () => {
      expect(matchTeams('tz')).toEqual(['Team Zodiac']);
    });

    it('resolves apstl to The Apostles Dominion', () => {
      expect(matchTeams('apstl')).toEqual(['The Apostles Dominion']);
    });

    it('resolves yaki to Yakigami', () => {
      expect(matchTeams('yaki')).toEqual(['Yakigami']);
    });

    it('resolves jstr to Jestre', () => {
      expect(matchTeams('jstr')).toEqual(['Jestre']);
    });

    it('resolves atl nova to Astra Lumina Nova', () => {
      expect(matchTeams('atl nova')).toEqual(['Astra Lumina Nova']);
    });

    it('resolves inf to 7Sins•BlueLock Inferno', () => {
      expect(matchTeams('inf')).toEqual(['7Sins•BlueLock Inferno']);
    });

    it('resolves vnm to 7Sins•BlueLock Venom', () => {
      expect(matchTeams('vnm')).toEqual(['7Sins•BlueLock Venom']);
    });

    it('resolves ap to AVOID Prime', () => {
      expect(matchTeams('ap')).toEqual(['AVOID Prime']);
    });

    it('resolves ai to AVOID Impact', () => {
      expect(matchTeams('ai')).toEqual(['AVOID Impact']);
    });

    it('resolves e8 to Elite 8', () => {
      expect(matchTeams('e8')).toEqual(['Elite 8']);
    });

    it('resolves hkg to Hokage', () => {
      expect(matchTeams('hkg')).toEqual(['Hokage']);
    });

    it('resolves rkg to Raikage', () => {
      expect(matchTeams('rkg')).toEqual(['Raikage']);
    });

    it('resolves hmb to Helix Moonbreaker', () => {
      expect(matchTeams('hmb')).toEqual(['Helix Moonbreaker']);
    });
  });

  describe('All 21 Characters matching', () => {
    it('contains at least 21 authoritative character entities', () => {
      expect(CHARACTERS.length).toBeGreaterThanOrEqual(21);
      const names = CHARACTERS.map((c) => c.name);
      const expected21 = [
        'Orion',
        'Hayato',
        'Andrew',
        'Kelly',
        'Maxim',
        'Shirou',
        'Rafael',
        'Moco',
        'Ford',
        'Homer',
        'Oscar',
        'Steffie',
        'Tatsuya',
        'Alvaro',
        'Template',
        'Hassan',
        'Shuki',
        'Kuroko',
        'Kurona',
        'Charlie',
        'Yuki',
      ];
      for (const name of expected21) {
        expect(names).toContain(name);
      }
    });

    it('resolves all 21 characters by canonical name', () => {
      const expected21 = [
        'Orion',
        'Hayato',
        'Andrew',
        'Kelly',
        'Maxim',
        'Shirou',
        'Rafael',
        'Moco',
        'Ford',
        'Homer',
        'Oscar',
        'Steffie',
        'Tatsuya',
        'Alvaro',
        'Template',
        'Hassan',
        'Shuki',
        'Kuroko',
        'Kurona',
        'Charlie',
        'Yuki',
      ];
      for (const name of expected21) {
        const matches = matchCharacters(name);
        expect(matches).toContain(name);
      }
    });
  });

  describe('Mandatory character abbreviations resolution', () => {
    it('resolves ndrw to Andrew', () => {
      expect(matchCharacters('ndrw')).toEqual(['Andrew']);
    });

    it('resolves hmr to Homer', () => {
      expect(matchCharacters('hmr')).toEqual(['Homer']);
    });

    it('resolves frd to Ford', () => {
      expect(matchCharacters('frd')).toEqual(['Ford']);
    });

    it('resolves orn to Orion', () => {
      expect(matchCharacters('orn')).toEqual(['Orion']);
    });

    it('resolves hyto to Hayato', () => {
      expect(matchCharacters('hyto')).toEqual(['Hayato']);
    });

    it('resolves klly to Kelly', () => {
      expect(matchCharacters('klly')).toEqual(['Kelly']);
    });

    it('resolves mxm to Maxim', () => {
      expect(matchCharacters('mxm')).toEqual(['Maxim']);
    });

    it('resolves shro to Shirou', () => {
      expect(matchCharacters('shro')).toEqual(['Shirou']);
    });

    it('resolves rfl to Rafael', () => {
      expect(matchCharacters('rfl')).toEqual(['Rafael']);
    });

    it('resolves mc to Moco', () => {
      expect(matchCharacters('mc')).toEqual(['Moco']);
    });

    it('resolves osc to Oscar', () => {
      expect(matchCharacters('osc')).toEqual(['Oscar']);
    });

    it('resolves stf to Steffie', () => {
      expect(matchCharacters('stf')).toEqual(['Steffie']);
    });

    it('resolves ttsy to Tatsuya', () => {
      expect(matchCharacters('ttsy')).toEqual(['Tatsuya']);
    });

    it('resolves alv to Alvaro', () => {
      expect(matchCharacters('alv')).toEqual(['Alvaro']);
    });
  });

  describe('Levenshtein typo tolerance (<= 2 on words >= 4 chars)', () => {
    describe('Teams typo tolerance', () => {
      it('matches kazekag (dist 1) -> Kazekage', () => {
        expect(matchTeams('kazekag')).toContain('Kazekage');
      });

      it('matches kazekagee (dist 1) -> Kazekage', () => {
        expect(matchTeams('kazekagee')).toContain('Kazekage');
      });

      it('matches zodiak (dist 1) -> Team Zodiac', () => {
        expect(matchTeams('zodiak')).toContain('Team Zodiac');
      });

      it('matches apstles (dist 1) -> The Apostles Dominion', () => {
        expect(matchTeams('apstles')).toContain('The Apostles Dominion');
      });

      it('matches infrno (dist 1) -> 7Sins•BlueLock Inferno', () => {
        expect(matchTeams('infrno')).toContain('7Sins•BlueLock Inferno');
      });

      it('matches venomm (dist 1) -> 7Sins•BlueLock Venom', () => {
        expect(matchTeams('venomm')).toContain('7Sins•BlueLock Venom');
      });

      it('matches moonbraker (dist 1) -> Helix Moonbreaker', () => {
        expect(matchTeams('moonbraker')).toContain('Helix Moonbreaker');
      });

      it('matches mizukg (dist 2) -> Mizukage', () => {
        expect(matchTeams('mizukg')).toContain('Mizukage');
      });

      it('matches starlightt (dist 1) -> Agility Starlight', () => {
        expect(matchTeams('starlightt')).toContain('Agility Starlight');
      });
    });

    describe('Characters typo tolerance', () => {
      it('matches andreww (dist 1) -> Andrew', () => {
        expect(matchCharacters('andreww')).toContain('Andrew');
      });

      it('matches homerr (dist 1) -> Homer', () => {
        expect(matchCharacters('homerr')).toContain('Homer');
      });

      it('matches tatsuyaa (dist 1) -> Tatsuya', () => {
        expect(matchCharacters('tatsuyaa')).toContain('Tatsuya');
      });

      it('matches oryon (dist 1) -> Orion', () => {
        expect(matchCharacters('oryon')).toContain('Orion');
      });

      it('matches shirouu (dist 1) -> Shirou', () => {
        expect(matchCharacters('shirouu')).toContain('Shirou');
      });

      it('matches rafaell (dist 1) -> Rafael', () => {
        expect(matchCharacters('rafaell')).toContain('Rafael');
      });

      it('matches steffyy (dist 2) -> Steffie', () => {
        expect(matchCharacters('steffyy')).toContain('Steffie');
      });

      it('matches osckar (dist 1) -> Oscar', () => {
        expect(matchCharacters('osckar')).toContain('Oscar');
      });

      it('matches kelley (dist 1) -> Kelly', () => {
        expect(matchCharacters('kelley')).toContain('Kelly');
      });

      it('matches alvaroo (dist 1) -> Alvaro', () => {
        expect(matchCharacters('alvaroo')).toContain('Alvaro');
      });
    });
  });

  describe('Rejection of invalid queries and short-word typos (< 4 chars)', () => {
    it('returns empty array for empty string and whitespace', () => {
      expect(matchTeams('')).toEqual([]);
      expect(matchTeams('   ')).toEqual([]);
      expect(matchCharacters('')).toEqual([]);
      expect(matchCharacters('   ')).toEqual([]);
    });

    it('returns empty array for pure gibberish', () => {
      expect(matchTeams('xyz987qwer')).toEqual([]);
      expect(matchCharacters('xyz987qwer')).toEqual([]);
    });

    it('does NOT apply typo tolerance to short words (< 4 chars)', () => {
      // "ax" is 1 char away from "ap", but < 4 chars so typo tolerance must NOT trigger
      expect(matchTeams('ax')).toEqual([]);
      expect(matchTeams('e9')).toEqual([]);
      expect(matchTeams('ui')).toEqual([]);
      // "mx" is 1 char away from "mc", but < 4 chars
      expect(matchCharacters('mx')).toEqual([]);
      expect(matchCharacters('xd')).toEqual([]);
    });
  });

  describe('Multi-entity and sentence parsing', () => {
    it('extracts multiple teams from a match matchup phrase', () => {
      const result = matchTeams('jadwal kzkge vs zdc');
      expect(result).toContain('Kazekage');
      expect(result).toContain('Team Zodiac');
    });

    it('extracts team from natural language query', () => {
      const result = matchTeams('siapa lawan hmb nanti malam?');
      expect(result).toContain('Helix Moonbreaker');
    });

    it('extracts multiple characters from tactical query', () => {
      const result = matchCharacters('cara counter andrew dan ford');
      expect(result).toContain('Andrew');
      expect(result).toContain('Ford');
    });

    it('extracts multiple characters from roster query', () => {
      const result = matchCharacters('bocoran skill tatsuya dan kelly');
      expect(result).toContain('Tatsuya');
      expect(result).toContain('Kelly');
    });

    it('resolves umbrella team aliases to multiple teams', () => {
      const sins = matchTeams('7sins');
      expect(sins).toContain('7Sins•BlueLock Inferno');
      expect(sins).toContain('7Sins•BlueLock Venom');

      const avoid = matchTeams('avoid');
      expect(avoid).toContain('AVOID Impact');
      expect(avoid).toContain('AVOID Prime');
    });
  });

  describe('Helper findBest functions', () => {
    it('returns single best team or null', () => {
      expect(findBestTeamMatch('kzkge')).toBe('Kazekage');
      expect(findBestTeamMatch('nonexistentteam')).toBeNull();
    });

    it('returns single best character or null', () => {
      expect(findBestCharacterMatch('ndrw')).toBe('Andrew');
      expect(findBestCharacterMatch('nonexistentchar')).toBeNull();
    });
  });

  describe('High performance benchmark', () => {
    it('executes 5,000 fuzzy lookups in under 150ms', () => {
      const queries = [
        'kzkge',
        'zdc',
        'ndrw',
        'hmr',
        'jadwal kzkge vs zdc',
        'andreww',
        'infrno',
        'atl nova',
        'yaki',
        'siapa lawan hmb',
      ];

      const start = performance.now();
      for (let i = 0; i < 5000; i++) {
        const q = queries[i % queries.length];
        matchTeams(q);
        matchCharacters(q);
      }
      const elapsed = performance.now() - start;

      // 5,000 double-queries (10,000 total calls) should easily execute under 150ms
      expect(elapsed).toBeLessThan(150);
    });
  });
});
