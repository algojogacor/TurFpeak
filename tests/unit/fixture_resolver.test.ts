/**
 * Flash Peak TMS - Fixture Resolver Unit Tests
 *
 * Verifies enhanced team matching supporting team codes, abbreviations,
 * partial names, tokens, prefix disambiguation, and winner detection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import { resolveFixtureForMessage } from '../../src/application/fixture-resolver.js';
import { IdentityResolver } from '../../src/identity/resolver.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

describe('Fixture Resolver with Enhanced Team Matching', () => {
  let db: Client;
  let identityResolver: IdentityResolver;
  const tournamentId = 'tour-resolver-test';

  const teamVenomId = 'team-venom-id';
  const teamInfernoId = 'team-inferno-id';
  const teamAgilityId = 'team-agility-id';
  const teamAstraId = 'team-astra-id';
  const teamApostlesId = 'team-apostles-id';
  const teamAvoidPrimeId = 'team-avoid-prime-id';
  const teamAvoidImpactId = 'team-avoid-impact-id';

  const fixVenomAgility = 'fix-venom-agility';
  const fixAstraApostles = 'fix-astra-apostles';
  const fixAvoidDerby = 'fix-avoid-derby';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    identityResolver = new IdentityResolver(db);

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Resolver Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });

    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, team_code, registration_status, created_at, updated_at)
            VALUES (?, ?, '7Sins•BlueLock Venom', '7SB', 'VERIFIED', ?, ?),
                   (?, ?, '7Sins•BlueLock Inferno', '7SB', 'VERIFIED', ?, ?),
                   (?, ?, 'Agility Starlight', 'AGL', 'VERIFIED', ?, ?),
                   (?, ?, 'Astra Lumina Nova', 'ATL', 'VERIFIED', ?, ?),
                   (?, ?, 'The Apostles Dominion', 'DOM', 'VERIFIED', ?, ?),
                   (?, ?, 'AVOID Prime', 'AVO', 'VERIFIED', ?, ?),
                   (?, ?, 'AVOID Impact', 'AVO', 'VERIFIED', ?, ?)`,
      args: [
        teamVenomId, tournamentId, now, now,
        teamInfernoId, tournamentId, now, now,
        teamAgilityId, tournamentId, now, now,
        teamAstraId, tournamentId, now, now,
        teamApostlesId, tournamentId, now, now,
        teamAvoidPrimeId, tournamentId, now, now,
        teamAvoidImpactId, tournamentId, now, now,
      ],
    });

    // Fixtures
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', 'ROUND_3', ?, ?, ?, 'SCHEDULED', ?, ?),
                   (?, ?, 'GROUP', 'ROUND_3', ?, ?, ?, 'SCHEDULED', ?, ?),
                   (?, ?, 'GROUP', 'ROUND_3', ?, ?, ?, 'SCHEDULED', ?, ?)`,
      args: [
        fixVenomAgility, tournamentId, teamVenomId, teamAgilityId, teamVenomId, now, now,
        fixAstraApostles, tournamentId, teamAstraId, teamApostlesId, teamAstraId, now, now,
        fixAvoidDerby, tournamentId, teamAvoidPrimeId, teamAvoidImpactId, teamAvoidPrimeId, now, now,
      ],
    });
  });

  function createMsg(caption: string | null, sender = 'unknown@lid'): NormalizedMessage {
    return {
      id: 'msg-' + Math.random(),
      provider_message_key: 'key-' + Math.random(),
      chat_id: 'chat-group-1',
      sender_raw_address: sender,
      sender_normalized_address: sender,
      message_type: 'IMAGE',
      text_body: caption,
      caption,
      message_timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
    } as unknown as NormalizedMessage;
  }

  it('resolves abbreviation "7SB Venom vs Agility win 7SB venom" to Venom vs Agility with Venom winner', async () => {
    const msg = createMsg('7SB Venom vs Agility win 7SB venom');
    const res = await resolveFixtureForMessage(db, identityResolver, msg);

    expect(res).not.toBeNull();
    expect(res?.id).toBe(fixVenomAgility);
    expect(res?.submitting_team_id).toBe(teamVenomId);
  });

  it('resolves "ATL Nova vs Apostles" to Astra Lumina Nova vs The Apostles Dominion', async () => {
    const msg = createMsg('ATL Nova vs Apostles');
    const res = await resolveFixtureForMessage(db, identityResolver, msg);

    expect(res).not.toBeNull();
    expect(res?.id).toBe(fixAstraApostles);
  });

  it('resolves "Astra vs Apostles win Apostles" with Apostles winner', async () => {
    const msg = createMsg('Astra vs Apostles win Apostles');
    const res = await resolveFixtureForMessage(db, identityResolver, msg);

    expect(res).not.toBeNull();
    expect(res?.id).toBe(fixAstraApostles);
    expect(res?.submitting_team_id).toBe(teamApostlesId);
  });

  it('resolves "AVOID Prime vs AVOID Impact" without ambiguity between shared prefixes', async () => {
    const msg = createMsg('AVOID Prime vs AVOID Impact win AVOID Impact');
    const res = await resolveFixtureForMessage(db, identityResolver, msg);

    expect(res).not.toBeNull();
    expect(res?.id).toBe(fixAvoidDerby);
    expect(res?.submitting_team_id).toBe(teamAvoidImpactId);
  });

  it('resolves single team mention "Venom menang" to Venom fixture with Venom winner', async () => {
    const msg = createMsg('Venom menang 6-4');
    const res = await resolveFixtureForMessage(db, identityResolver, msg);

    expect(res).not.toBeNull();
    expect(res?.id).toBe(fixVenomAgility);
    expect(res?.submitting_team_id).toBe(teamVenomId);
  });

  it('falls back to identity auto-lock when caption is empty and delegate is verified', async () => {
    const delegateId = 'del-venom';
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
            VALUES (?, 'Venom Rep', 'ACTIVE', ?, ?)`,
      args: [delegateId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, address_type, raw_address, is_primary, verified_at, created_at)
            VALUES ('wi-1', ?, 'LID', '77584306069587@lid', 1, ?, ?)`,
      args: [delegateId, now, now],
    });
    await db.execute({
      sql: `UPDATE teams SET delegate_id = ? WHERE id = ?`,
      args: [delegateId, teamVenomId],
    });

    const msg = createMsg(null, '77584306069587@lid');
    const res = await resolveFixtureForMessage(db, identityResolver, msg);

    expect(res).not.toBeNull();
    expect(res?.id).toBe(fixVenomAgility);
    expect(res?.submitting_team_id).toBe(teamVenomId);
  });
});
