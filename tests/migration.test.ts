import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';

describe('Database Migrations (001_initial.sql + later versioned migrations)', () => {
  let db: Client;

  beforeEach(() => {
    // In-memory isolated SQLite instance for each test
    db = createClient({
      url: ':memory:',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('successfully applies all pending migrations and records them in _migrations', async () => {
    const result = await runMigrations(db);

    expect(result.applied).toContain('001_initial.sql');
    expect(result.skipped).toEqual([]);

    // Check _migrations table: every migration file in the directory is applied
    const migrationRows = await db.execute('SELECT id, name FROM _migrations');
    expect(migrationRows.rows.length).toBe(result.applied.length);
    expect(migrationRows.rows.map((r) => String(r[0]))).toContain('001_initial');

    // Query sqlite_master to verify tables were created
    const tablesResult = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tableNames = tablesResult.rows.map((r) => String(r[0]));

    const expectedTables = [
      '_migrations',
      'approvals',
      'audit_events',
      'bot_instances',
      'corrections',
      'delegates',
      'fixtures',
      'games',
      'goalkeeper_reports',
      'group_draws',
      'group_members',
      'groups',
      'inbound_messages',
      'ko_game_evidence',
      'media_assets',
      'player_game_stats',
      'players',
      'provider_usage',
      'report_media',
      'report_sessions',
      'report_versions',
      'series',
      'standings',
      'teams',
      'tournaments',
      'whatsapp_identities',
    ];

    for (const expectedTable of expectedTables) {
      expect(tableNames).toContain(expectedTable);
    }
  });

  it('is idempotent on repeated runs', async () => {
    // First run applies the full pending set
    const firstRun = await runMigrations(db);
    expect(firstRun.applied.length).toBeGreaterThan(0);
    expect(firstRun.applied).toContain('001_initial.sql');

    // Second run applies nothing; everything is skipped
    const secondRun = await runMigrations(db);
    expect(secondRun.applied.length).toBe(0);
    expect(secondRun.skipped).toContain('001_initial.sql');
    expect(secondRun.skipped).toEqual(firstRun.applied);
  });

  it('enforces table foreign key constraints when inserting related rows', async () => {
    await runMigrations(db);

    // Attempting to insert a team with a non-existent tournament_id should fail
    await expect(
      db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES ('t-1', 'non-existent-tourney', 'Team Alpha', 'PENDING', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`,
        args: [],
      })
    ).rejects.toThrow();

    // Now insert valid tournament first
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at)
            VALUES ('tourney-1', 'Flash Peak Championship', 'REGISTRATION', '1.0', '{}', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`,
      args: [],
    });

    // Valid insertion should succeed
    const validInsert = await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES ('t-1', 'tourney-1', 'Team Alpha', 'PENDING', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`,
      args: [],
    });
    expect(validInsert.rowsAffected).toBe(1);
  });

  it('007_ko_roster_replacement preserves existing player_game_stats and goalkeeper_reports while enabling REPLACED status', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    // Apply 001..006 manually first
    await db.execute(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const f of files.filter((x) => !x.startsWith('007_'))) {
      await db.executeMultiple(fs.readFileSync(path.join(migrationsDir, f), 'utf-8'));
      await db.execute({
        sql: `INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)`,
        args: [path.basename(f, '.sql'), f, '2026-11-25T00:00:00.000Z'],
      });
    }

    const now = '2026-11-25T00:00:00.000Z';
    await db.execute(`INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES ('t1', 'Cup', 'ACTIVE', '1.0', '{}', '${now}', '${now}')`);
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES ('team-a', 't1', 'Team A', 'VERIFIED', '${now}', '${now}')`);
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES ('team-b', 't1', 'Team B', 'VERIFIED', '${now}', '${now}')`);
    await db.execute(`INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at) VALUES ('p-gk', 't1', 'team-a', 'OldGK', 'OldGK', 'oldgk', 'GOALKEEPER', 1, 'STARTER', 'ACTIVE', '${now}', '${now}')`);
    await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES ('fx-1', 't1', 'GROUP', 'team-a', 'team-b', 'team-a', 'COMPLETED', '${now}', '${now}')`);
    await db.execute(`INSERT INTO games (id, fixture_id, game_number, status, team_a_score, team_b_score, winner_team_id, is_draw, is_walkover, walkover_type, evidence_status, created_at, updated_at) VALUES ('g-1', 'fx-1', 1, 'COMPLETED', 2, 0, 'team-a', 0, 0, 'NONE', 'VERIFIED', '${now}', '${now}')`);
    await db.execute(`INSERT INTO report_sessions (id, fixture_id, game_id, submitting_team_id, status, last_message_at, debounce_due_at, created_at, updated_at) VALUES ('rs-1', 'fx-1', 'g-1', 'team-a', 'DRAFT_READY', '${now}', '${now}', '${now}', '${now}')`);
    await db.execute(`INSERT INTO report_versions (id, report_session_id, fixture_id, version_number, status, extraction_json, validated_data_json, provenance, created_by, created_at) VALUES ('rv-1', 'rs-1', 'fx-1', 1, 'LOCKED', '{}', '{}', 'AI', 'test', '${now}')`);
    await db.execute(`INSERT INTO inbound_messages (id, provider_message_key, chat_id, sender_raw_address, message_timestamp, received_at, message_type, raw_metadata_json, created_at) VALUES ('im-1', 'pmk-1', 'g@g.us', '123@s.whatsapp.net', '${now}', '${now}', 'IMAGE', '{}', '${now}')`);
    await db.execute(`INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at) VALUES ('ma-1', 'FLASHPEAK_VM_MEDIA', 'k1', 'GOALKEEPER_DETAIL', 'image/png', 100, 'abc', 'PRIVATE', 'STORED', 'im-1', '${now}')`);
    await db.execute(`INSERT INTO player_game_stats (id, game_id, player_id, team_id, rating, goals, assists, passes, defense_raw, goalkeeper_saves, source_report_version_id, is_award_eligible, created_at) VALUES ('pgs-1', 'g-1', 'p-gk', 'team-a', 8.5, 0, 1, 10, 5, 6, 'rv-1', 1, '${now}')`);
    await db.execute(`INSERT INTO goalkeeper_reports (id, game_id, player_id, team_id, detail_media_asset_id, score_left, score_right, cross_screen_match_status, award_eligible, created_at) VALUES ('gkr-1', 'g-1', 'p-gk', 'team-a', 'ma-1', 2, 0, 'UNIQUE', 1, '${now}')`);

    // Apply 007
    const res = await runMigrations(db);
    expect(res.applied).toContain('007_ko_roster_replacement.sql');

    // Verify zero rows lost in stats & gk reports!
    const pgsCount = await db.execute('SELECT COUNT(*) as c FROM player_game_stats');
    const gkrCount = await db.execute('SELECT COUNT(*) as c FROM goalkeeper_reports');
    expect(Number(pgsCount.rows[0].c)).toBe(1);
    expect(Number(gkrCount.rows[0].c)).toBe(1);

    // Archive p-gk as REPLACED and insert NewGK at the same slot 1!
    await db.execute(`UPDATE players SET status = 'REPLACED' WHERE id = 'p-gk'`);
    await db.execute(`INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at) VALUES ('p-gk-new', 't1', 'team-a', 'NewGK', 'NewGK', 'newgk', 'GOALKEEPER', 1, 'STARTER', 'ACTIVE', '${now}', '${now}')`);

    // Second ACTIVE player at slot 1 must still fail unique index
    await expect(
      db.execute(`INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at) VALUES ('p-gk-dup', 't1', 'team-a', 'DupGK', 'DupGK', 'dupgk', 'GOALKEEPER', 1, 'STARTER', 'ACTIVE', '${now}', '${now}')`)
    ).rejects.toThrow();

    // Foreign keys must still be ON after 007
    await expect(
      db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES ('t-bad', 'missing', 'Bad', 'PENDING', '${now}', '${now}')`)
    ).rejects.toThrow();
  });
});
