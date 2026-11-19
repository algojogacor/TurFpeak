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
} from './ingestion/debounce.js';
import { ProviderRouter } from './ai/router.js';
import { ImageClassifier } from './ai/classifier.js';
import { MatchSummaryExtractor } from './ai/extractors/match.js';
import { GoalkeeperDetailExtractor } from './ai/extractors/goalkeeper.js';
import { CorrectionParser } from './ai/correction-parser.js';
import {
  getReportVersion,
} from './reports/versioning.js';
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
import { ManualReportSessionManager } from './application/manual-report-session.js';
import {
  WoClaimSessionManager,
  parseWoClaimIntent,
  resolveFixtureForWoClaim,
  type PendingWoClaim,
} from './application/wo-claim-session.js';
import {
  calculateTournamentAwards,
  type TournamentAwardsSummary,
  type AwardsCalculationOptions,
} from './stats/awards.js';
import { registerTournamentCommands } from './application/tournament-commands.js';
import { MatchdayService } from './application/matchday-service.js';
import { resolveFixtureForMessage } from './application/fixture-resolver.js';
import { handleReportCorrection } from './application/report-correction-coordinator.js';
import {
  processClaimedBatch,
  type ProcessedBatchResult,
} from './application/evidence-batch-processor.js';
import {
  formatStandingsTable,
  formatAwardsAnnouncement,
} from './whatsapp/formatters.js';
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
  type: 'COMMAND' | 'ONBOARDING' | 'CORRECTION' | 'EVIDENCE' | 'WO_CLAIM' | 'UNKNOWN';
  commandResult?: CommandResult;
  session?: ReportSession;
  draftVersion?: ReportVersion;
  replyText?: string;
  error?: string;
  mentions?: string[];
}

export type { ProcessedBatchResult };

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
  public readonly manualReportSession: ManualReportSessionManager;
  public readonly woClaimSession: WoClaimSessionManager;
  public readonly matchdayService: MatchdayService;
  public readonly centralGroupJid?: string;
  public sender?: WhatsAppSender;

  private quietWindowMs: number;
  private leaseDurationMs: number;
  private workerId: string;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private lastMatchdayCheck = 0;

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
    this.manualReportSession = new ManualReportSessionManager();
    this.woClaimSession = new WoClaimSessionManager();
    this.matchdayService = new MatchdayService({
      db: this.db,
      sender: this.sender,
      centralGroupJid: this.centralGroupJid,
    });
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
    this.matchdayService.setSender(sender);
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
      manualReportSession: this.manualReportSession,
      woClaimSession: this.woClaimSession,
      matchdayService: this.matchdayService,
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
    const rawMsgText = (message.text_body || message.caption || '').trim();

    // 1. Command Router & Prefix '!' Handler
    // In group chats, any user-intended bot interaction MUST start with '!'
    if (this.commandRouter.isCommand(message)) {
      const parsed = this.commandRouter.parseCommand(message);

      // If registered command keyword (e.g. !help, !ping, !schedule, !standings, !ok, !batal, !claimwo, !roster), execute via router
      if (parsed && this.commandRouter.hasCommand(parsed.command)) {
        const commandResult = await this.commandRouter.handleMessage(message);
        return {
          handled: true,
          type: 'COMMAND',
          commandResult: commandResult || undefined,
          replyText: commandResult?.responseText,
        };
      }

      // If not a registered command keyword, check for Natural Language intents prefixed with '!'
      // e.g. "!kita klaim wo ya, musuh ga aktif sesuai jadwal janjian"
      // or "!klaim wo match 1 karena lawan tidak hadir 15 menit"
      const textAfterPrefix = rawMsgText.slice(1).trim();
      const woIntent = parseWoClaimIntent(textAfterPrefix);

      if (woIntent.isGeneralQuestion) {
        return {
          handled: true,
          type: 'WO_CLAIM',
          replyText: [
            'ℹ️ *KETENTUAN KLAIM WALKOVER (WO):*',
            '• Klaim WO diajukan dengan awalan tanda seru (*!*), contoh: _"!klaim WO untuk Match 1 karena lawan tidak hadir 15 menit"_',
            '• Sertakan alasan yang jelas saat melapor.',
            '• Setiap klaim WO akan diverifikasi dan wajib disahkan oleh Panitia turnamen via *!ok*.',
            '• Tim pemenang WO memperoleh skor 3–0 (+3 poin).',
            '💡 Ketik *!rule* untuk melihat regulasi lengkap turnamen.',
          ].join('\n'),
        };
      }

      if (woIntent.isWoClaim) {
        // Validation: Must include a clear reason
        if (!woIntent.hasReason) {
          return {
            handled: true,
            type: 'WO_CLAIM',
            replyText: [
              '⚠️ *PENGAJUAN KLAIM WALKOVER (WO)*',
              '',
              'Mohon sertakan alasan klaim WO yang jelas agar dapat diverifikasi oleh Panitia.',
              '',
              '📌 *Contoh format pelaporan:*',
              '• _"!klaim WO untuk Match 1 karena lawan tidak hadir setelah toleransi 15 menit."_',
              '• _"!klaim WO lawan [Nama Tim] karena menolak membuat room pertandingan."_',
            ].join('\n'),
          };
        }

        // Resolve reporting delegate & fixture
        const resolution = await this.identityResolver.resolveIdentity(
          message.sender_raw_address,
          message.chat_id
        );
        const reportingDelegateId =
          resolution.status === 'VERIFIED' && resolution.delegate
            ? resolution.delegate.id
            : null;

        const fixRes = await resolveFixtureForWoClaim(
          this.db,
          reportingDelegateId,
          textAfterPrefix,
          woIntent
        );

        if (fixRes.error) {
          return {
            handled: true,
            type: 'WO_CLAIM',
            replyText: fixRes.error,
          };
        }

        if (fixRes.fixture && fixRes.reportingTeam && fixRes.forfeitingTeam && fixRes.tournamentId && fixRes.tournamentName) {
          const claim: PendingWoClaim = {
            id: randomUUID(),
            chatId: message.chat_id,
            fixtureId: fixRes.fixture.id,
            tournamentId: fixRes.tournamentId,
            tournamentName: fixRes.tournamentName,
            groupId: fixRes.fixture.group_id || null,
            stage: fixRes.fixture.stage,
            roundCode: fixRes.fixture.round_code || null,
            teamAName: fixRes.fixture.team_a_name,
            teamBName: fixRes.fixture.team_b_name,
            reportingTeamId: fixRes.reportingTeam.id,
            reportingTeamName: fixRes.reportingTeam.name,
            forfeitingTeamId: fixRes.forfeitingTeam.id,
            forfeitingTeamName: fixRes.forfeitingTeam.name,
            reason: woIntent.extractedReason || 'Lawan tidak hadir / forfeit',
            reportedByAddress: message.sender_raw_address,
            reportedByDelegateId: reportingDelegateId,
            createdAt: Date.now(),
            expiresAt: Date.now() + 15 * 60 * 1000,
          };

          this.woClaimSession.stagePendingClaim(claim);

          const organizerPhone =
            (this.commandRouter as any).organizerPhone || process.env.WA_ORGANIZER_PHONE || '';
          const promptText = this.woClaimSession.formatClaimPrompt(claim, organizerPhone);

          const rawOrgJid =
            (this.commandRouter as any).organizerJid ||
            process.env.WA_ORGANIZER_JID ||
            (organizerPhone ? `${organizerPhone.replace(/\D/g, '')}@s.whatsapp.net` : '');
          const organizerJid = rawOrgJid.split(',')[0].trim();
          const mentions = organizerJid ? [organizerJid] : [];

          return {
            handled: true,
            type: 'WO_CLAIM',
            replyText: promptText,
            mentions,
          };
        }
      }

      // If text starts with '!' but is neither a known command nor a known NL intent,
      // dispatch to router for UNKNOWN_COMMAND handling
      const commandResult = await this.commandRouter.handleMessage(message);
      return {
        handled: true,
        type: 'COMMAND',
        commandResult: commandResult || undefined,
        replyText: commandResult?.responseText,
      };
    }

    // 1.5 Pending Manual Report Confirmation / Correction Check
    if (this.manualReportSession.hasPending(message.chat_id, message.sender_normalized_address)) {
      const normText = rawMsgText.toLowerCase();
      const isConfirm = ['ok', 'ya', 'confirm', '!ok', '!confirm', 'lanjut', 'benar', 'sudah benar'].includes(normText);

      if (isConfirm) {
        const organizerId = message.sender_normalized_address || 'ORGANIZER';
        const confirmRes = await this.manualReportSession.confirmPending(
          this.db,
          message.chat_id,
          organizerId
        );
        return {
          handled: true,
          type: 'COMMAND',
          replyText: confirmRes.success ? confirmRes.replyText : confirmRes.error,
        };
      }

      const isCorrection =
        normText.includes('bukan') ||
        normText.includes('koreksi') ||
        normText.includes('ganti') ||
        normText.includes('gol a') ||
        normText.includes('gol b') ||
        normText.includes('tim a') ||
        normText.includes('tim b') ||
        normText.startsWith('a:') ||
        normText.startsWith('b:');

      if (isCorrection) {
        const organizerId = message.sender_normalized_address || 'ORGANIZER';
        const correctionRes = this.manualReportSession.applyCorrection(
          message.chat_id,
          organizerId,
          rawMsgText
        );
        return {
          handled: true,
          type: 'COMMAND',
          replyText: correctionRes.success ? correctionRes.updatedPrompt : correctionRes.error,
        };
      }
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

      const res = await processClaimedBatch(
        {
          db: this.db,
          mediaClient: this.mediaClient,
          providerRouter: this.providerRouter,
          classifier: this.classifier,
          matchExtractor: this.matchExtractor,
          centralGroupJid: this.centralGroupJid,
        },
        batch
      );
      results.push(res);
    }

    return results;
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

      // Check matchday schedule (cutoff & reminders) every ~30 seconds
      const now = Date.now();
      if (now - this.lastMatchdayCheck >= 30000) {
        this.lastMatchdayCheck = now;
        try {
          await this.matchdayService.processDailyCutoff();
          await this.matchdayService.checkAndSendReminders();
        } catch (mErr) {
          console.error('[FlashPeakApp] Error in matchday scheduler:', mErr);
        }
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
