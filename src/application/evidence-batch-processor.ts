/**
 * Flash Peak TMS - Evidence Batch Processor (Application Layer)
 * 
 * Coordinates the end-to-end evidence batch processing pipeline:
 * - Downloads media assets from Flash Peak media service
 * - Runs multi-provider AI vision classification (MAIN_MATCH_SUMMARY vs INDIVIDUAL_PLAYER_DETAIL)
 * - Extracts match scoreboard statistics via MatchSummaryExtractor
 * - Identifies explicit winner declaration in captions and performs Team A/B score and player swapping
 * - Validates extracted match data against backend deterministic business rules
 * - Creates immutable draft version (v1) in report_versions table
 * - Formats user-facing match report summary for WhatsApp
 * - Handles AI outages gracefully with standardized participant notifications
 * - Updates atomic debounce batch lifecycle state
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Client } from '@libsql/client';
import type { ClaimedBatch } from '../ingestion/debounce.js';
import { completeDebounceBatch } from '../ingestion/debounce.js';
import type { FlashPeakMediaClient } from '../media/client.js';
import type { ProviderRouter } from '../ai/router.js';
import type { ImageClassifier } from '../ai/classifier.js';
import type { MatchSummaryExtractor } from '../ai/extractors/match.js';
import { validateMatchReport } from '../reports/validation.js';
import { createReportDraft } from '../reports/versioning.js';
import {
  formatMatchReportSummary,
  type MatchReportSummaryParams,
} from '../whatsapp/formatters.js';
import { formatAIFailureMessage } from '../whatsapp/failure.js';
import type { UUID, ReportVersion } from '../shared/types/index.js';

export interface ProcessedBatchResult {
  sessionId: UUID;
  fixtureId: UUID;
  targetChatId?: string;
  status: 'DRAFT_CREATED' | 'NEEDS_CORRECTION' | 'AI_FAILED' | 'NO_MEDIA';
  draftVersion?: ReportVersion;
  whatsappSummary?: string;
  error?: string;
}

export interface EvidenceBatchProcessorDeps {
  db: Client;
  mediaClient?: FlashPeakMediaClient;
  providerRouter?: ProviderRouter;
  classifier?: ImageClassifier;
  matchExtractor?: MatchSummaryExtractor;
  centralGroupJid?: string;
}

export async function processClaimedBatch(
  deps: EvidenceBatchProcessorDeps,
  batch: ClaimedBatch
): Promise<ProcessedBatchResult> {
  const { db, mediaClient, providerRouter, classifier, matchExtractor, centralGroupJid } = deps;
  const sessionId = batch.session.id;
  const fixtureId = batch.session.fixture_id;

  const chatRes = await db.execute({
    sql: 'SELECT chat_id FROM inbound_messages WHERE report_session_id = ? ORDER BY message_timestamp DESC LIMIT 1',
    args: [sessionId],
  });
  const targetChatId = chatRes.rows.length > 0 && chatRes.rows[0][0]
    ? String(chatRes.rows[0][0])
    : centralGroupJid;

  try {
    if (batch.mediaAssets.length === 0) {
      await completeDebounceBatch(db, sessionId, 'INCOMPLETE');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'NO_MEDIA',
        whatsappSummary: '⚠️ Bukti foto pertandingan tidak terdeteksi atau gagal diunduh. Silakan kirim ulang screenshot skor akhir pertandingan.',
        error: 'No media attachments in claimed batch',
      };
    }

    if (!providerRouter || !classifier || !matchExtractor) {
      await completeDebounceBatch(db, sessionId, 'FAILED');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'AI_FAILED',
        error: 'AI router not configured',
      };
    }

    let mainMatchBase64: string | null = null;
    const gkDetailAssets: Array<{ base64: string; caption?: string }> = [];

    for (const asset of batch.mediaAssets) {
      let base64 = '';
      if (mediaClient) {
        try {
          const filename = path.basename(asset.storage_key);
          const remoteId = filename.split('.')[0] || asset.id;
          const downloaded = await mediaClient.downloadMedia(remoteId, asset.sha256);
          base64 = downloaded.buffer.toString('base64');
        } catch (dlErr) {
          console.error(`[AI] Failed to download media asset ${asset.id}:`, dlErr);
          base64 = 'MOCK_BASE64_DATA';
        }
      } else {
        base64 = 'MOCK_BASE64_DATA';
      }

      const classification = await classifier.classify({
        mime_type: asset.mime_type,
        base64,
      });

      if (classification.screen_type === 'MAIN_MATCH_SUMMARY' && !mainMatchBase64) {
        mainMatchBase64 = base64;
      } else if (classification.screen_type === 'INDIVIDUAL_PLAYER_DETAIL') {
        gkDetailAssets.push({ base64 });
      }
    }

    if (!mainMatchBase64) {
      await completeDebounceBatch(db, sessionId, 'INCOMPLETE');
      return {
        sessionId,
        fixtureId,
        targetChatId,
        status: 'NEEDS_CORRECTION',
        error: 'Main match summary screenshot missing',
      };
    }

    const matchExtraction = await matchExtractor.extract({
      mime_type: 'image/jpeg',
      base64: mainMatchBase64,
    });

    const fixtureRes = await db.execute({
      sql: `SELECT f.id, f.team_a_id, f.team_b_id, g.id AS game_id, ta.team_name, tb.team_name
            FROM fixtures f
            LEFT JOIN games g ON g.fixture_id = f.id
            LEFT JOIN teams ta ON f.team_a_id = ta.id
            LEFT JOIN teams tb ON f.team_b_id = tb.id
            WHERE f.id = ? LIMIT 1`,
      args: [fixtureId],
    });

    if (fixtureRes.rows.length === 0) {
      throw new Error(`Fixture not found: ${fixtureId}`);
    }

    const fRow = fixtureRes.rows[0];
    const teamAId = String(fRow[1]);
    const teamBId = String(fRow[2]);
    const gameId = fRow[3] ? String(fRow[3]) : randomUUID();
    const teamAName = String(fRow[4] || 'Tim A');
    const teamBName = String(fRow[5] || 'Tim B');

    const sessionRowRes = await db.execute({
      sql: `SELECT submitting_team_id FROM report_sessions WHERE id = ? LIMIT 1`,
      args: [sessionId],
    });
    let submittingTeamId = sessionRowRes.rows.length > 0 ? String(sessionRowRes.rows[0][0]) : null;

    // Check if any message in the debounce batch explicitly specified a winning team
    for (const msg of batch.messages) {
      const text = (msg.caption || msg.text_body || '').trim().toLowerCase();
      if (!text) continue;
      const bName = teamBName.toLowerCase();
      const aName = teamAName.toLowerCase();
      const bMatch = text.includes(bName);
      const aMatch = text.includes(aName);

      if (bMatch && !aMatch) {
        submittingTeamId = teamBId;
        await db.execute({
          sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
          args: [teamBId, sessionId],
        });
        break;
      } else if (aMatch && !bMatch) {
        submittingTeamId = teamAId;
        await db.execute({
          sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
          args: [teamAId, sessionId],
        });
        break;
      } else if (aMatch && bMatch) {
        const bWinPattern = new RegExp(`(pemenang|menang|win|juara)[:\\s]+${bName}|${bName}[:\\s]+(menang|win)`, 'i');
        if (bWinPattern.test(text)) {
          submittingTeamId = teamBId;
          await db.execute({
            sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
            args: [teamBId, sessionId],
          });
          break;
        }
      }
    }

    const isSubmittingTeamB = Boolean(submittingTeamId && submittingTeamId === teamBId);

    const rawTeamAScore = matchExtraction.summary_data.team_a_score ?? 0;
    const rawTeamBScore = matchExtraction.summary_data.team_b_score ?? 0;
    const teamAScore = isSubmittingTeamB ? rawTeamBScore : rawTeamAScore;
    const teamBScore = isSubmittingTeamB ? rawTeamAScore : rawTeamBScore;

    const rawPlayersForA = isSubmittingTeamB
      ? matchExtraction.summary_data.team_b_players
      : matchExtraction.summary_data.team_a_players;
    const rawPlayersForB = isSubmittingTeamB
      ? matchExtraction.summary_data.team_a_players
      : matchExtraction.summary_data.team_b_players;

    const validation = await validateMatchReport(db, {
      fixture_id: fixtureId,
      game_id: gameId,
      team_a_id: teamAId,
      team_b_id: teamBId,
      team_a_score: teamAScore,
      team_b_score: teamBScore,
      team_a_players: rawPlayersForA.map((p) => ({
        nickname_raw: p.nickname_raw,
        rating: p.rating,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense_raw: p.defense,
        goalkeeper_saves: null,
      })),
      team_b_players: rawPlayersForB.map((p) => ({
        nickname_raw: p.nickname_raw,
        rating: p.rating,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense_raw: p.defense,
        goalkeeper_saves: null,
      })),
    });

    const draftStatus = validation.isValid ? 'PENDING_APPROVAL' : 'NEEDS_CORRECTION';

    const draftVersion = await createReportDraft(db, {
      report_session_id: sessionId,
      fixture_id: fixtureId,
      extraction_json: JSON.stringify(matchExtraction),
      validated_data_json: JSON.stringify(validation.validatedData || {}),
      provenance: 'AI',
      status: draftStatus,
    });

    await completeDebounceBatch(db, sessionId, 'DRAFT_READY');

    const summaryParams: MatchReportSummaryParams = {
      status: draftStatus,
      versionNumber: draftVersion.version_number,
      teamAName,
      teamBName,
      teamAScore,
      teamBScore,
      teamAPlayers: rawPlayersForA.map((p, idx) => {
        const valRating = validation.validatedData?.team_a_players?.[idx]?.rating;
        let r = valRating !== undefined && valRating !== null ? valRating : p.rating;
        if (r !== null && r !== undefined && r > 10.0) {
          r = Number((r / 10).toFixed(1));
        }
        return {
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense,
          rating: r,
        };
      }),
      teamBPlayers: rawPlayersForB.map((p, idx) => {
        const valRating = validation.validatedData?.team_b_players?.[idx]?.rating;
        let r = valRating !== undefined && valRating !== null ? valRating : p.rating;
        if (r !== null && r !== undefined && r > 10.0) {
          r = Number((r / 10).toFixed(1));
        }
        return {
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense,
          rating: r,
        };
      }),
      uncertainties: validation.warnings,
      pendingApprovers: draftStatus === 'PENDING_APPROVAL' ? ['TEAM_A', 'TEAM_B', 'ORGANIZER'] : [],
    };

    const whatsappSummary = formatMatchReportSummary(summaryParams);

    return {
      sessionId,
      fixtureId,
      targetChatId,
      status: validation.isValid ? 'DRAFT_CREATED' : 'NEEDS_CORRECTION',
      draftVersion,
      whatsappSummary,
    };
  } catch (err) {
    await completeDebounceBatch(db, sessionId, 'FAILED');
    const failMsg = formatAIFailureMessage({
      sessionId,
      includeAdminCommandHint: true,
    });

    return {
      sessionId,
      fixtureId,
      targetChatId,
      status: 'AI_FAILED',
      whatsappSummary: failMsg,
      error: String(err),
    };
  }
}
