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
import path from 'node:path';
import type { Client } from '@libsql/client';
import type {
  NormalizedMessage,
  CommandResult,
} from './whatsapp/types.js';
import { CommandRouter } from './whatsapp/router.js';
import { WhatsAppSender } from './whatsapp/sender.js';
import { IdentityResolver } from './identity/resolver.js';
import { OnboardingService } from './identity/onboarding.js';
import { FlashPeakMediaClient } from './media/client.js';
import { captureInboundMessage } from './ingestion/capture.js';
import {
  findOrCreateReportSession,
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
import { CorrectionParser } from './ai/correction-parser.js';
import {
  createReportDraft,
  getReportVersion,
} from './reports/versioning.js';
import { validateMatchReport } from './reports/validation.js';
import type { CorrectionResult } from './reports/corrections.js';
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
  calculateTournamentAwards,
  type TournamentAwardsSummary,
  type AwardsCalculationOptions,
} from './stats/awards.js';
import { registerTournamentCommands } from './application/tournament-commands.js';
import { resolveFixtureForMessage } from './application/fixture-resolver.js';
import { handleReportCorrection } from './application/report-correction-coordinator.js';
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
  sender?: WhatsAppSender;
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
  targetChatId?: string;
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
  public readonly centralGroupJid?: string;
  public sender?: WhatsAppSender;

  private quietWindowMs: number;
  private leaseDurationMs: number;
  private workerId: string;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(config: FlashPeakAppConfig) {
    this.db = config.db;
    this.centralGroupJid = config.centralGroupJid;
    this.sender = config.sender;
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

  public setSender(sender: WhatsAppSender): void {
    this.sender = sender;
  }

  /**
   * Registers default tournament commands to the CommandRouter.
   */
  private registerAppCommands(): void {
    const self = this;
    registerTournamentCommands(this.commandRouter, {
      db: this.db,
      identityResolver: this.identityResolver,
      onboardingService: this.onboardingService,
      get sender() {
        return self.sender;
      },
      getStandingsTable: this.getStandingsTable.bind(this),
      submitApproval: this.submitApproval.bind(this),
      findVersionByMessageKey: this.findVersionByMessageKey.bind(this),
    });
  }

  /**
   * Main incoming message handler.
   */
  public async handleInboundMessage(
    message: NormalizedMessage,
    mediaBuffer?: Buffer | null
  ): Promise<InboundHandlingResult> {
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
    const activeTournaments = await this.db.execute("SELECT id FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1");
    if (activeTournaments.rows.length > 0) {
      const tournamentId = String(activeTournaments.rows[0].id ?? activeTournaments.rows[0][0]);
      const activePrompt = this.onboardingService.getActivePrompt(tournamentId);
      if (activePrompt && message.reply_to_key === activePrompt.promptMessageKey) {
        const replyRes = await this.onboardingService.handleOnboardingReply(tournamentId, message);
        if (replyRes.status === 'SUCCESS') {
          // If there is a next pending team to prompt, send it sequentially after 2s
          if (replyRes.nextPrompt?.promptText && replyRes.nextPrompt.team && this.sender) {
            const nextPrompt = replyRes.nextPrompt;
            setTimeout(async () => {
              try {
                if (this.sender && nextPrompt.promptText && nextPrompt.team) {
                  const nextKey = await this.sender.sendText(message.chat_id, nextPrompt.promptText);
                  this.onboardingService.setActivePrompt(tournamentId, nextPrompt.team.id, nextKey);
                }
              } catch (err) {
                console.error('[Onboarding] Error sending next sequential prompt:', err);
              }
            }, 2000);
          }
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
    if (
      message.chat_id.endsWith('@broadcast') ||
      message.chat_id === 'status@broadcast' ||
      message.chat_id.endsWith('@newsletter')
    ) {
      return { handled: false, type: 'UNKNOWN' };
    }

    const hasMedia = message.message_type === 'IMAGE' || Boolean(message.media_metadata) || Boolean(mediaBuffer);
    if ((hasMedia && message.message_type === 'IMAGE') || isCorrectionCandidate) {
      const resolvedIdentity = await this.identityResolver.resolveIdentity(message.sender_raw_address);
      const delegateId = resolvedIdentity?.delegate?.id || null;

      const fixture = await resolveFixtureForMessage(this.db, this.identityResolver, message);
      let sessionId: string | null = null;
      let session: ReportSession | undefined;

      if (fixture) {
        const teamId = fixture.submitting_team_id || resolvedIdentity?.team?.id || fixture.team_a_id;
        const sessionRes = await findOrCreateReportSession(this.db, {
          fixture_id: fixture.id,
          submitting_team_id: teamId,
        });
        sessionId = sessionRes.session.id;
      }

      const captureRes = await captureInboundMessage(this.db, {
        provider_message_key: message.provider_message_key,
        chat_id: message.chat_id,
        sender_raw_address: message.sender_raw_address,
        delegate_id: delegateId,
        message_timestamp: message.message_timestamp,
        message_type: message.message_type,
        text_body: message.text_body,
        caption: message.caption,
        reply_to_key: message.reply_to_key,
        report_session_id: sessionId,
      });

      // Persist binary media into Flash Peak media service & Turso media_assets table
      if (mediaBuffer && this.mediaClient) {
        try {
          const originalName = message.media_metadata?.fileName || `${message.provider_message_key}.jpg`;
          const mime = message.media_metadata?.mimetype || 'image/jpeg';
          const asset = await this.mediaClient.uploadMedia({
            buffer: mediaBuffer,
            filename: originalName,
            mimeType: mime,
            mediaRole: 'MAIN_MATCH',
            sourceMessageId: captureRes.message.id,
            uploadedByDelegateId: delegateId,
          });
          console.log(`[Media] Uploaded asset '${asset.id}' (${mediaBuffer.length} bytes) for message ${captureRes.message.id}`);
        } catch (uploadErr) {
          console.error('[Media] Failed to upload media asset to media service:', uploadErr);
        }
      }

      if (sessionId) {
        session = await resetSessionDebounce(
          this.db,
          sessionId,
          this.quietWindowMs
        );

        return {
          handled: true,
          type: 'EVIDENCE',
          session,
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

    const chatRes = await this.db.execute({
      sql: 'SELECT chat_id FROM inbound_messages WHERE report_session_id = ? ORDER BY message_timestamp DESC LIMIT 1',
      args: [sessionId],
    });
    const targetChatId = chatRes.rows.length > 0 && chatRes.rows[0][0]
      ? String(chatRes.rows[0][0])
      : this.centralGroupJid;

    try {
      if (batch.mediaAssets.length === 0) {
        await completeDebounceBatch(this.db, sessionId, 'INCOMPLETE');
        return {
          sessionId,
          fixtureId,
          targetChatId,
          status: 'NO_MEDIA',
          whatsappSummary: '⚠️ Bukti foto pertandingan tidak terdeteksi atau gagal diunduh. Silakan kirim ulang screenshot skor akhir pertandingan.',
          error: 'No media attachments in claimed batch',
        };
      }

      if (!this.providerRouter || !this.classifier || !this.matchExtractor) {
        await completeDebounceBatch(this.db, sessionId, 'FAILED');
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
        if (this.mediaClient) {
          try {
            const filename = path.basename(asset.storage_key);
            const remoteId = filename.split('.')[0] || asset.id;
            const downloaded = await this.mediaClient.downloadMedia(remoteId, asset.sha256);
            base64 = downloaded.buffer.toString('base64');
          } catch (dlErr) {
            console.error(`[AI] Failed to download media asset ${asset.id}:`, dlErr);
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
          targetChatId,
          status: 'NEEDS_CORRECTION',
          error: 'Main match summary screenshot missing',
        };
      }

      const matchExtraction = await this.matchExtractor.extract({
        mime_type: 'image/jpeg',
        base64: mainMatchBase64,
      });

      const fixtureRes = await this.db.execute({
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

      const sessionRowRes = await this.db.execute({
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
          await this.db.execute({
            sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
            args: [teamBId, sessionId],
          });
          break;
        } else if (aMatch && !bMatch) {
          submittingTeamId = teamAId;
          await this.db.execute({
            sql: `UPDATE report_sessions SET submitting_team_id = ? WHERE id = ?`,
            args: [teamAId, sessionId],
          });
          break;
        } else if (aMatch && bMatch) {
          const bWinPattern = new RegExp(`(pemenang|menang|win|juara)[:\\s]+${bName}|${bName}[:\\s]+(menang|win)`, 'i');
          if (bWinPattern.test(text)) {
            submittingTeamId = teamBId;
            await this.db.execute({
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

      const validation = await validateMatchReport(this.db, {
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
      await completeDebounceBatch(this.db, sessionId, 'FAILED');
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

    return handleReportCorrection(
      {
        db: this.db,
        correctionParser: this.correctionParser,
        identityResolver: this.identityResolver,
      },
      versionId,
      message
    );
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
        const batchResults = await this.processDueDebounceBatches();
        for (const res of batchResults) {
          if (res.whatsappSummary && this.sender) {
            const destChat = res.targetChatId || this.centralGroupJid;
            if (destChat) {
              const sentKey = await this.sender.sendText(destChat, res.whatsappSummary);
              if (sentKey && res.sessionId) {
                try {
                  await this.db.execute({
                    sql: `INSERT OR IGNORE INTO inbound_messages (
                            id, report_session_id, provider_message_key, chat_id,
                            sender_raw_address, message_type, text_body,
                            message_timestamp, received_at, raw_metadata_json, created_at
                          ) VALUES (?, ?, ?, ?, 'bot@s.whatsapp.net', 'TEXT', ?, ?, ?, '{}', ?)`,
                    args: [
                      randomUUID(),
                      res.sessionId,
                      sentKey,
                      destChat,
                      res.whatsappSummary,
                      new Date().toISOString(),
                      new Date().toISOString(),
                      new Date().toISOString(),
                    ],
                  });
                } catch (persistErr) {
                  console.warn('[FlashPeakApp] Could not bind outbound summary message key:', persistErr);
                }
              }
            }
          }
        }
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
