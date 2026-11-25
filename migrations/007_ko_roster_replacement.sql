-- =============================================================================
-- Migration: 007_ko_roster_replacement.sql
-- Description: Support KO phase roster replacement by adding 'REPLACED' status
--              and scoping slot uniqueness to non-replaced players so historical
--              group-stage stats/awards remain intact (no ON DELETE CASCADE).
-- =============================================================================

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE players_new (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    nickname_raw TEXT NOT NULL,
    nickname_nfc TEXT NOT NULL,
    nickname_search_key TEXT NOT NULL,
    position TEXT NOT NULL CHECK (position IN ('GOALKEEPER', 'OUTFIELD')),
    roster_slot INTEGER NOT NULL CHECK (roster_slot BETWEEN 1 AND 10),
    roster_type TEXT NOT NULL CHECK (roster_type IN ('STARTER', 'SUBSTITUTE')),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'INELIGIBLE', 'REPLACED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT uq_player_tournament_nickname UNIQUE (tournament_id, nickname_nfc)
);

INSERT INTO players_new (
    id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key,
    position, roster_slot, roster_type, status, created_at, updated_at
)
SELECT
    id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key,
    position, roster_slot, roster_type, status, created_at, updated_at
FROM players;

DROP TABLE players;

ALTER TABLE players_new RENAME TO players;

CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_search_key ON players(tournament_id, nickname_search_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_active_team_slot
    ON players(team_id, roster_slot)
    WHERE status != 'REPLACED';

COMMIT;

PRAGMA foreign_keys = ON;
