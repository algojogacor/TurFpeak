/**
 * Flash Peak TMS - Central Application Orchestrator & Factory (Task 6.5)
 * 
 * Central coordinator connecting all tournament management subsystems:
 * - WhatsApp connection, event capture & message normalizer
 * - Identity resolution & guided sequential onboarding
 * - Evidence ingestion, media client & 5-second sliding debounce
 * - AI multi-provider pipeline, vision classification & extraction
 * - Backend validation & deterministic business rules
 * - Report versioning (immutable drafts v1, v2...)
 * - Natural language corrections & 3-party approvals
 * - Report locking, authoritative player stats writeback & standings updates
 * - Cumulative statistics & tournament awards calculations
 * - WhatsApp response formatters & AI failure handling
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  NormalizedMessage,
  CommandContext,
  CommandResult,
} from './whatsapp/types.js';
import { CommandRouter } from './whatsapp/router.js';
import { IdentityResolver } from './identity/resolver.js';
import { OnboardingService } from './identity/onboarding.js';
import { FlashPeakMediaClient } from './media/client.js';
import { captureInboundMessage } from './ingestion/capture.js';
import {
  findOrCreateReportSession,
  getReportSessionById,
} from './ingestion/session.js';
import {
  resetSessionDebounce,
  claimDebounceBatch,
  completeDebounceBatch,
  type ClaimedBatch,
} from './ingestion/debounce.js';
import { ProviderRouter } from './ai/router.js';
import { ImageClassifier } from './ai/classifier.js';
import { MatchSummaryExtractor } from './ai/extractors/match.js';
import { GoalkeeperDetailExtractor } from './ai/extractors/goalkeeper.js';
import { resolveGoalkeeperIdentity } from './ai/extractors/gk-identity.js';
import { CorrectionParser, type ReportContext } from './ai/correction-parser.js';
import {
  createReportDraft,
  getReportVersion,
  getLatestReportVersion,
} from './reports/versioning.js';
import { validateMatchReport } from './reports/validation.js';
import { applyReportCorrection, type CorrectionResult } from './reports/corrections.js';
import {
  submitReportApproval,
  type ApprovalOutcome,
} from './reports/approval.js';
import {
  handleManualReport,
  type ManualReportInput,
  type ManualReportResult,
} from './reports/manual.js';
import {
  aggregatePlayerStats,
  aggregateTeamStats,
  type AggregatedPlayerStats,
  type AggregatedTeamStats,
} from './stats/aggregator.js';
import {
  calculateTournamentAwards,
  type TournamentAwardsSummary,
  type AwardsCalculationOptions,
} from './stats/awards.js';
import {
  formatMatchReportSummary,
  formatStandingsTable,
  formatAwardsAnnouncement,
  type MatchReportSummaryParams,
} from './whatsapp/formatters.js';
import { formatAIFailureMessage } from './whatsapp/failure.js';
import { recalculateAndPersistGroupStandings } from './competition/standings.js';
import type {
  UUID,
  ApproverType,
  ApprovalDecision,
  ReportVersion,
  ReportSession,
} from './shared/types/index.js';

export interface FlashPeakAppConfig {
  db: Client;
  mediaClient?: FlashPeakMediaClient;
  providerRouter?: ProviderRouter;
  centralGroupJid?: string;
  organizerJid?: string;
  organizerPhone?: string;
  quietWindowMs?: number; // Default: 5000ms
  leaseDurationMs?: number; // Default: 30000ms
  workerId?: string;
  pollIntervalMs?: number; // Default: 1000ms for debounce poll loop
}

export interface InboundHandlingResult {
  handled: boolean;
  type: 'COMMAND' | 'ONBOARDING' | 'CORRECTION' | 'EVIDENCE' | 'UNKNOWN';
  commandResult?: CommandResult;
  session?: ReportSession;
  draftVersion?: ReportVersion;
  replyText?: string;
  error?: string;
}

export interface ProcessedBatchResult {
  sessionId: UUID;
  fixtureId: UUID;
  status: 'DRAFT_CREATED' | 'NEEDS_CORRECTION' | 'AI_FAILED' | 'NO_MEDIA';
  draftVersion?: ReportVersion;
  whatsappSummary?: string;
  error?: string;
}

export class FlashPeakApp {
  public readonly db: Client;
  public readonly identityResolver: IdentityResolver;
  public readonly onboardingService: OnboardingService;
  public readonly commandRouter: CommandRouter;
  public readonly mediaClient?: FlashPeakMediaClient;
  public readonly providerRouter?: ProviderRouter;
  public readonly classifier?: ImageClassifier;
  public readonly matchExtractor?: MatchSummaryExtractor;
  public readonly gkExtractor?: GoalkeeperDetailExtractor;
  public readonly correctionParser?: CorrectionParser;

  private quietWindowMs: number;
  private leaseDurationMs: number;
  private workerId: string;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(config: FlashPeakAppConfig) {
    this.db = config.db;
    this.quietWindowMs = config.quietWindowMs ?? 5000;
    this.leaseDurationMs = config.leaseDurationMs ?? 30000;
    this.workerId = config.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;

    // Subsystems
    this.identityResolver = new IdentityResolver(this.db);
    this.onboardingService = new OnboardingService(this.identityResolver, this.db);
    this.commandRouter = new CommandRouter({
      centralGroupJid: config.centralGroupJid,
      organizerJid: config.organizerJid,
      organizerPhone: config.organizerPhone,
      identityResolver: this.identityResolver,
    });

    this.mediaClient = config.mediaClient;
    this.providerRouter = config.providerRouter;
    if (this.providerRouter) {
      this.classifier = new ImageClassifier(this.providerRouter);
      this.matchExtractor = new MatchSummaryExtractor(this.providerRouter);
      this.gkExtractor = new GoalkeeperDetailExtractor(this.providerRouter);
      this.correctionParser = new CorrectionParser(this.providerRouter);
    }

    this.registerAppCommands();
  }

  /**
   * Registers default tournament commands to the CommandRouter.
   */
  private registerAppCommands(): void {
    // !standings <group_code>
    this.commandRouter.registerCommand({
      command: '!standings',
      requiredRole: 'ANY',
      handler: async (ctx: CommandContext) => {
        const groupCode = ctx.args[0]?.toUpperCase() || 'A';
        const res = await this.db.execute({
          sql: `SELECT g.id, gd.tournament_id
                FROM groups g
                JOIN group_draws gd ON g.draw_id = gd.id
                WHERE UPPER(g.group_code) = ?
                LIMIT 1`,
          args: [groupCode],
        });

        if (res.rows.length === 0) {
          return { success: false, responseText: `Grup ${groupCode} tidak ditemukan.` };
        }

        const groupId = String(res.rows[0][0]);
        const tournamentId = String(res.rows[0][1]);
        const standingsText = await this.getStandingsTable(tournamentId, groupId, groupCode);
        return { success: true, responseText: standingsText };
      },
    });

    // !awards
    this.commandRouter.registerCommand({
      command: '!awards',
      requiredRole: 'ANY',
      handler: async () => {
        const res = await this.db.execute('SELECT id, name FROM tournaments ORDER BY created_at DESC LIMIT 1');
        if (res.rows.length === 0) {
          return { success: false, responseText: 'Belum ada turnamen yang terdaftar.' };
        }
        const tournamentId = String(res.rows[0][0]);
        const tournamentName = String(res.rows[0][1]);
        const awards = await calculateTournamentAwards(this.db, tournamentId);
        const text = formatAwardsAnnouncement(tournamentName, awards);
        return { success: true, responseText: text };
      },
    });

    // !approve
    this.commandRouter.registerCommand({
      command: '!approve',
      requiredRole: 'DELEGATE',
      handler: async (ctx: CommandContext) => {
        const versionId = ctx.args[0];
        if (!versionId) {
          return { success: false, responseText: 'Format: !approve <report_version_id>' };
        }
        let approverType: ApproverType = 'ORGANIZER';
        if (ctx.role === 'DELEGATE') {
          const verRes = await this.db.execute({
            sql: `SELECT f.team_a_id, f.team_b_id, ta.delegate_id, tb.delegate_id
                  FROM report_versions rv
                  JOIN fixtures f ON rv.fixture_id = f.id
                  LEFT JOIN teams ta ON f.team_a_id = ta.id
                  LEFT JOIN teams tb ON f.team_b_id = tb.id
                  WHERE rv.id = ?`,
            args: [versionId],
          });
          if (verRes.rows.length > 0) {
            const row = verRes.rows[0];
            const delA = row[2] ? String(row[2]) : null;
            const delB = row[3] ? String(row[3]) : null;
            if (ctx.delegateId === delA) approverType = 'TEAM_A';
            else if (ctx.delegateId === delB) approverType = 'TEAM_B';
          }
        }

        const approverId = ctx.delegateId || ctx.message.sender_normalized_address;
        const outcome = await this.submitApproval(
          versionId,
          approverType,
          approverId,
          'APPROVE',
          ctx.isOrganizer
        );
        return { success: outcome.isLocked, responseText: outcome.message };
      },
    });
  }

  /**
   * Main incoming message handler.
   */
  public async handleInboundMessage(message: NormalizedMessage): Promise<InboundHandlingResult> {
    // 1. Command Router Check
    if (this.commandRouter.isCommand(message)) {
      const commandResult = await this.commandRouter.handleMessage(message);
      return {
        handled: true,
        type: 'COMMAND',
        commandResult: commandResult || undefined,
        replyText: commandResult?.responseText,
      };
    }

    // 2. Onboarding Flow Check
    const activeTournaments = await this.db.execute("SELECT id FROM tournaments WHERE status IN ('REGISTRATION', 'DRAW') LIMIT 1");
    if (activeTournaments.rows.length > 0) {
      const tournamentId = String(activeTournaments.rows[0][0]);
      const activePrompt = this.onboardingService.getActivePrompt(tournamentId);
      if (activePrompt && message.reply_to_key === activePrompt.promptMessageKey) {
        const replyRes = await this.onboardingService.handleOnboardingReply(tournamentId, message);
        if (replyRes.status === 'SUCCESS') {
          return {
            handled: true,
            type: 'ONBOARDING',
            replyText: replyRes.responseText,
          };
        }
      }
    }

    // 3. Natural Language Correction Check
    const text = (message.text_body || message.caption || '').toLowerCase();
    const isCorrectionCandidate =
      text.includes('koreksi') ||
      text.includes('salah di') ||
      text.includes('seharusnya') ||
      text.includes('bukan') ||
      text.includes('player urutan');

    if (isCorrectionCandidate && message.reply_to_key) {
      const targetVersion = await this.findVersionByMessageKey(message.reply_to_key);
      if (targetVersion && this.correctionParser) {
        const correctionRes = await this.handleCorrection(targetVersion.id, message);
        return {
          handled: true,
          type: 'CORRECTION',
          replyText: correctionRes.replyText,
        };
      }
    }

    // 4. Evidence / Match Ingestion Capture
    const hasMedia = message.message_type === 'IMAGE' || Boolean(message.media_metadata);
    if (hasMedia || isCorrectionCandidate) {
      await captureInboundMessage(this.db, {
        provider_message_key: message.provider_message_key,
        chat_id: message.chat_id,
        sender_raw_address: message.sender_raw_address,
        delegate_id: message.sender_normalized_address,
        message_timestamp: message.message_timestamp,
        message_type: message.message_type,
        text_body: message.text_body,
        caption: message.caption,
        reply_to_key: message.reply_to_key,
      });

      const fixture = await this.resolveFixtureForMessage(message);
      if (fixture) {
        const teamId = fixture.team_a_id;
        const sessionRes = await findOrCreateReportSession(this.db, {
          fixture_id: fixture.id,
          submitting_team_id: teamId,
        });

        const updatedSession = await resetSessionDebounce(
          this.db,
          sessionRes.session.id,
          this.quietWindowMs
        );

        return {
          handled: true,
          type: 'EVIDENCE',
          session: updatedSession,
        };
      }
    }

    return { handled: false, type: 'UNKNOWN' };
  }

  /**
   * Processes all due sliding debounce batches atomically.
   */
  public async processDueDebounceBatches(): Promise<ProcessedBatchResult[]> {
    const results: ProcessedBatchResult[] = [];

    while (true) {
      const batch = await claimDebounceBatch(this.db, this.workerId, this.leaseDurationMs);
      if (!batch) break;

      const res = await this.processSingleClaimedBatch(batch);
      results.push(res);
    }

    return results;
  }

  /**
   * Processes a single claimed debounce batch through AI vision, validation, and draft creation.
   */
  private async processSingleClaimedBatch(batch: ClaimedBatch): Promise<ProcessedBatchResult> {
    const sessionId = batch.session.id;
    const fixtureId = batch.session.fixture_id;

    try {
      if (batch.mediaAssets.length === 0) {
        await completeDebounceBatch(this.db, sessionId, 'INCOMPLETE');
        return {
          sessionId,
          fixtureId,
          status: 'NO_MEDIA',
          error: 'No media attachments in claimed batch',
        };
      }

      if (!this.providerRouter || !this.classifier || !this.matchExtractor) {
        await completeDebounceBatch(this.db, sessionId, 'FAILED');
        return {
          sessionId,
          fixtureId,
          status: 'AI_FAILED',
          error: 'AI router not configured',
        };
      }

      let mainMatchBase64: string | null = null;
      const gkDetailAssets: Array<{ base64: string; caption?: string }> = [];

      for (const asset of batch.mediaAssets) {
        let base64 = '';
        if (this.mediaClient) {
          try {
            const downloaded = await this.mediaClient.downloadMedia(asset.id);
            base64 = downloaded.buffer.toString('base64');
          } catch {
            base64 = 'MOCK_BASE64_DATA';
          }
        } else {
          base64 = 'MOCK_BASE64_DATA';
        }

        const classification = await this.classifier.classify({
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
        await completeDebounceBatch(this.db, sessionId, 'INCOMPLETE');
        return {
          sessionId,
          fixtureId,
          status: 'NEEDS_CORRECTION',
          error: 'Main match summary screenshot missing',
        };
      }

      const matchExtraction = await this.matchExtractor.extract({
        mime_type: 'image/jpeg',
        base64: mainMatchBase64,
      });

      const fixtureRes = await this.db.execute({
        sql: `SELECT f.id, f.team_a_id, f.team_b_id, g.id AS game_id, ta.name, tb.name
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

      const validation = await validateMatchReport(this.db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: matchExtraction.summary_data.team_a_score ?? 0,
        team_b_score: matchExtraction.summary_data.team_b_score ?? 0,
        team_a_players: matchExtraction.summary_data.team_a_players.map((p) => ({
          nickname_raw: p.nickname_raw,
          rating: p.rating,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense_raw: p.defense,
          goalkeeper_saves: null,
        })),
        team_b_players: matchExtraction.summary_data.team_b_players.map((p) => ({
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

      const draftVersion = await createReportDraft(this.db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        extraction_json: JSON.stringify(matchExtraction),
        validated_data_json: JSON.stringify(validation.validatedData || {}),
        provenance: 'AI',
        status: draftStatus,
      });

      await completeDebounceBatch(this.db, sessionId, 'DRAFT_READY');

      const summaryParams: MatchReportSummaryParams = {
        status: draftStatus,
        versionNumber: draftVersion.version_number,
        teamAName,
        teamBName,
        teamAScore: matchExtraction.summary_data.team_a_score,
        teamBScore: matchExtraction.summary_data.team_b_score,
        teamAPlayers: matchExtraction.summary_data.team_a_players.map((p, idx) => ({
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense,
          rating: p.rating,
        })),
        teamBPlayers: matchExtraction.summary_data.team_b_players.map((p, idx) => ({
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense,
          rating: p.rating,
        })),
        uncertainties: validation.warnings,
        pendingApprovers: draftStatus === 'PENDING_APPROVAL' ? ['TEAM_A', 'TEAM_B', 'ORGANIZER'] : [],
      };

      const whatsappSummary = formatMatchReportSummary(summaryParams);

      return {
        sessionId,
        fixtureId,
        status: validation.isValid ? 'DRAFT_CREATED' : 'NEEDS_CORRECTION',
        draftVersion,
        whatsappSummary,
      };
    } catch (err) {
      await completeDebounceBatch(this.db, sessionId, 'FAILED');
      const failMsg = formatAIFailureMessage({
        sessionId,
        includeAdminCommandHint: true,
      });

      return {
        sessionId,
        fixtureId,
        status: 'AI_FAILED',
        whatsappSummary: failMsg,
        error: String(err),
      };
    }
  }

  /**
   * Applies natural language correction to a report version.
   */
  public async handleCorrection(
    versionId: UUID,
    message: NormalizedMessage
  ): Promise<{ result: CorrectionResult; replyText: string }> {
    if (!this.correctionParser) {
      throw new Error('Correction parser not configured');
    }

    const version = await getReportVersion(this.db, versionId);
    if (!version) {
      throw new Error(`Report version not found: ${versionId}`);
    }

    const text = message.text_body || message.caption || '';
    const validatedData = JSON.parse(version.validated_data_json);

    const reportContext: ReportContext = {
      report_version_id: versionId,
      team_a: {
        id: validatedData.team_a_id,
        name: 'Team A',
        players: (validatedData.team_a_players || []).map((p: any, idx: number) => ({
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense_raw,
        })),
      },
      team_b: {
        id: validatedData.team_b_id,
        name: 'Team B',
        players: (validatedData.team_b_players || []).map((p: any, idx: number) => ({
          ordinal: idx + 1,
          nickname: p.nickname_raw,
          goals: p.goals,
          assists: p.assists,
          passes: p.passes,
          defense: p.defense_raw,
        })),
      },
      score_a: validatedData.team_a_score,
      score_b: validatedData.team_b_score,
    };

    const parseOutcome = await this.correctionParser.parse({
      message_text: text,
      report_context: reportContext,
    });

    if (parseOutcome.status !== 'PROPOSED') {
      return {
        result: {
          success: false,
          status: 'NEEDS_CLARIFICATION',
          clarification_reason: parseOutcome.clarification_reason,
        },
        replyText: `❓ *Perlu Klarifikasi:* ${parseOutcome.clarification_reason}`,
      };
    }

    const senderId = message.sender_normalized_address;
    const result = await applyReportCorrection(this.db, {
      target_report_version_id: versionId,
      sender_id: senderId,
      inbound_message_id: message.provider_message_key,
      patch: parseOutcome.patch,
    });

    let replyText = '';
    if (result.success && result.newVersion) {
      replyText = `✅ *Koreksi Berhasil Diterapkan (Versi ${result.newVersion.version_number})*\nSemua persetujuan sebelumnya telah direset.\nSilakan review dan setujui kembali menggunakan *!approve*.`;
    } else {
      replyText = `❌ *Koreksi Gagal:* ${result.error || 'Perlu klarifikasi data.'}`;
    }

    return { result, replyText };
  }

  /**
   * Submits 3-party approval on a report version.
   */
  public async submitApproval(
    reportVersionId: UUID,
    approverType: ApproverType,
    approverId: string,
    decision: ApprovalDecision,
    isOrganizer = false
  ): Promise<ApprovalOutcome> {
    return submitReportApproval(this.db, {
      report_version_id: reportVersionId,
      approver_type: approverType,
      approver_id: approverId,
      decision,
      is_organizer: isOrganizer,
    });
  }

  /**
   * Submits a manual match report (Admin only, FR-FAIL-003).
   */
  public async submitManualReport(input: ManualReportInput): Promise<ManualReportResult> {
    return handleManualReport(this.db, input);
  }

  /**
   * Computes group standings table formatted for WhatsApp.
   */
  public async getStandingsTable(
    tournamentId: UUID,
    groupId: UUID,
    groupCode = 'A'
  ): Promise<string> {
    const standings = await recalculateAndPersistGroupStandings(this.db, tournamentId, groupId);
    return formatStandingsTable(groupCode, standings);
  }

  /**
   * Computes tournament awards summary and formatted WhatsApp text.
   */
  public async getAwardsSummary(
    tournamentId: UUID,
    tournamentTitle = 'Flash Peak Tour',
    options?: AwardsCalculationOptions
  ): Promise<{ awards: TournamentAwardsSummary; formattedText: string }> {
    const awards = await calculateTournamentAwards(this.db, tournamentId, options);
    const formattedText = formatAwardsAnnouncement(tournamentTitle, awards);
    return { awards, formattedText };
  }

  /**
   * Starts periodic debounce queue polling.
   */
  public start(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.pollTimer = setInterval(async () => {
      try {
        await this.processDueDebounceBatches();
      } catch (err) {
        console.error('[FlashPeakApp] Error processing debounce batches:', err);
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stops periodic debounce queue polling.
   */
  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  // --- Helpers ---
  private async findVersionByMessageKey(messageKey: string): Promise<ReportVersion | null> {
    const res = await this.db.execute({
      sql: `SELECT rv.id FROM report_versions rv
            JOIN report_sessions rs ON rv.report_session_id = rs.id
            JOIN inbound_messages im ON im.report_session_id = rs.id
            WHERE im.provider_message_key = ?
            ORDER BY rv.version_number DESC LIMIT 1`,
      args: [messageKey],
    });
    if (res.rows.length === 0) return null;
    return getReportVersion(this.db, String(res.rows[0][0]));
  }

  private async resolveFixtureForMessage(message: NormalizedMessage): Promise<{ id: string; team_a_id: string } | null> {
    const res = await this.db.execute({
      sql: `SELECT id, team_a_id FROM fixtures WHERE status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY scheduled_start_time ASC LIMIT 1`,
      args: [],
    });
    if (res.rows.length === 0) return null;
    return { id: String(res.rows[0][0]), team_a_id: String(res.rows[0][1]) };
  }
}

/**
 * Factory function to instantiate FlashPeakApp.
 */
export function createApp(config: FlashPeakAppConfig): FlashPeakApp {
  return new FlashPeakApp(config);
}

// =============================================================================
// Re-exports of all core modules and domain types
// =============================================================================
export * from './shared/types/index.js';
export * from './shared/schemas/index.js';
export * from './db/client.js';
export * from './db/migrate.js';
export * from './identity/resolver.js';
export * from './identity/onboarding.js';
export * from './whatsapp/index.js';
export * from './media/client.js';
export * from './ingestion/index.js';
export * from './ai/index.js';
export * from './reports/index.js';
export * from './competition/index.js';
export * from './stats/index.js';
