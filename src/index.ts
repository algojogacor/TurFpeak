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
  CommandContext,
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
import { CorrectionParser, type ReportContext } from './ai/correction-parser.js';
import {
  createReportDraft,
  getReportVersion,
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
  calculateTournamentAwards,
  type TournamentAwardsSummary,
  type AwardsCalculationOptions,
} from './stats/awards.js';
import { createTournament } from './competition/tournament.js';
import {
  prepareDraw,
  revealNext,
} from './competition/draw.js';
import { generateGroupStageFixtures } from './competition/fixtures.js';
import {
  formatMatchReportSummary,
  formatStandingsTable,
  formatAwardsAnnouncement,
  formatDrawRevealStep,
  formatDrawCompletedSummary,
  formatFixturesSchedule,
  type MatchReportSummaryParams,
  type CompletedDrawGroup,
  type FixtureScheduleDisplayItem,
} from './whatsapp/formatters.js';
import { formatAIFailureMessage } from './whatsapp/failure.js';
import { recalculateAndPersistGroupStandings } from './competition/standings.js';
import type {
  UUID,
  ApproverType,
  ApprovalDecision,
  ReportVersion,
  ReportSession,
  DrawResultGroupAssignment,
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

    // !schedule / !jadwal
    const scheduleHandler = async () => {
      const tRes = await this.db.execute('SELECT id, name FROM tournaments WHERE status NOT IN ("COMPLETED", "ARCHIVED") ORDER BY created_at DESC LIMIT 1');
      if (tRes.rows.length === 0) {
        return { success: false, responseText: '⚠️ Belum ada turnamen aktif.' };
      }
      const tournamentId = String(tRes.rows[0].id ?? tRes.rows[0][0]);
      const tournamentName = String(tRes.rows[0].name ?? tRes.rows[0][1]);

      const fixturesRes = await this.db.execute({
        sql: `
          SELECT f.round_code, g.group_code, ta.team_name as team_a_name, tb.team_name as team_b_name, tl.team_name as host_name
          FROM fixtures f
          JOIN groups g ON f.group_id = g.id
          JOIN teams ta ON f.team_a_id = ta.id
          JOIN teams tb ON f.team_b_id = tb.id
          LEFT JOIN teams tl ON f.left_side_team_id = tl.id
          WHERE f.tournament_id = ?
          ORDER BY g.group_code ASC, f.round_code ASC
        `,
        args: [tournamentId],
      });

      if (fixturesRes.rows.length === 0) {
        return { success: false, responseText: '⚠️ Jadwal pertandingan belum dibuat. Jalankan *!draw* terlebih dahulu.' };
      }

      const scheduleItems: FixtureScheduleDisplayItem[] = fixturesRes.rows.map((r) => ({
        roundCode: String(r.round_code),
        groupCode: String(r.group_code),
        teamAName: String(r.team_a_name),
        teamBName: String(r.team_b_name),
        leftSideHostName: String(r.host_name || r.team_a_name),
      }));

      const scheduleMsg = formatFixturesSchedule(tournamentName, scheduleItems);
      return { success: true, responseText: scheduleMsg };
    };

    this.commandRouter.registerCommand({
      command: 'schedule',
      requiredRole: 'ANY',
      allowedInDm: true,
      allowedInGroup: true,
      description: 'Menampilkan jadwal pertandingan resmi turnamen',
      handler: scheduleHandler,
    });

    this.commandRouter.registerCommand({
      command: 'jadwal',
      requiredRole: 'ANY',
      allowedInDm: true,
      allowedInGroup: true,
      description: 'Menampilkan jadwal pertandingan resmi turnamen',
      handler: scheduleHandler,
    });

    // !approve
    this.commandRouter.registerCommand({
      command: '!approve',
      requiredRole: 'DELEGATE',
      handler: async (ctx: CommandContext) => {
        let versionId = ctx.args[0];
        if (!versionId && ctx.message.reply_to_key) {
          const ver = await this.findVersionByMessageKey(ctx.message.reply_to_key);
          if (ver) versionId = ver.id;
        }
        if (!versionId) {
          const latestVer = await this.db.execute(`
            SELECT rv.id FROM report_versions rv
            JOIN fixtures f ON rv.fixture_id = f.id
            JOIN tournaments t ON f.tournament_id = t.id
            WHERE t.status = 'ACTIVE' AND rv.status IN ('PENDING_APPROVAL', 'NEEDS_CORRECTION')
            ORDER BY rv.created_at DESC LIMIT 1
          `);
          if (latestVer.rows.length > 0) {
            versionId = String(latestVer.rows[0].id ?? latestVer.rows[0][0]);
          }
        }
        if (!versionId) {
          return {
            success: false,
            responseText: '⚠️ Balas/kutip pesan draf laporan pertandingan dengan *!approve*, atau ketik: `!approve <id>`',
          };
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

    // !createtournament <tournament_name>
    this.commandRouter.registerCommand({
      command: '!createtournament',
      requiredRole: 'ORGANIZER',
      allowedInDm: true,
      allowedInGroup: true,
      handler: async (ctx: CommandContext) => {
        const name = ctx.rawArgs.trim();
        if (!name) {
          return {
            success: false,
            responseText: '⚠️ Format: *!createtournament <Nama Turnamen>*\nContoh: `!createtournament Flash Peak Championship Season 1`',
          };
        }

        try {
          const tournament = await createTournament(this.db, {
            name,
            format: 'GROUP_AND_KNOCKOUT',
          });

          return {
            success: true,
            responseText: [
              `🏆 *TURNAMEN BERHASIL DIBUAT*`,
              `──────────────────────────────`,
              `📌 *Nama:* ${tournament.name}`,
              `🆔 *ID:* \`${tournament.id}\``,
              `📊 *Format:* Babak Grup + Knockout (D-008)`,
              `⚙️ *Status:* DRAFT / REGISTRATION`,
              ``,
              `Pendaftaran tim dibuka. Panitia & delegasi dapat mendaftarkan tim ke turnamen ini.`,
            ].join('\n'),
          };
        } catch (err: any) {
          return {
            success: false,
            responseText: `❌ Gagal membuat turnamen: ${err.message || String(err)}`,
          };
        }
      },
    });

    // !draw [tournament_id]
    this.commandRouter.registerCommand({
      command: '!draw',
      requiredRole: 'ORGANIZER',
      allowedInDm: true,
      allowedInGroup: true,
      handler: async (ctx: CommandContext) => {
        let tournamentId = ctx.args[0]?.trim();
        let tournamentName = '';

        if (tournamentId) {
          const tRes = await this.db.execute({
            sql: `SELECT id, name, status FROM tournaments WHERE id = ?`,
            args: [tournamentId],
          });
          if (tRes.rows.length === 0) {
            return {
              success: false,
              responseText: `⚠️ Turnamen dengan ID \`${tournamentId}\` tidak ditemukan.`,
            };
          }
          tournamentName = String(tRes.rows[0].name);
        } else {
          const tRes = await this.db.execute(`
            SELECT id, name, status
            FROM tournaments
            ORDER BY created_at DESC
            LIMIT 1
          `);
          if (tRes.rows.length === 0) {
            return {
              success: false,
              responseText: '⚠️ Belum ada turnamen yang terdaftar di sistem.',
            };
          }
          tournamentId = String(tRes.rows[0].id);
          tournamentName = String(tRes.rows[0].name);
        }

        try {
          // Prepare the draw (or resume existing draw)
          const draw = await prepareDraw(this.db, tournamentId);

          if (draw.status === 'COMPLETED') {
            const groupsRes = await this.db.execute({
              sql: `SELECT g.group_code, t.id as team_id, t.team_name, gm.draw_position
                    FROM groups g
                    JOIN group_members gm ON g.id = gm.group_id
                    JOIN teams t ON gm.team_id = t.id
                    WHERE g.draw_id = ?
                    ORDER BY g.group_code ASC, gm.draw_position ASC`,
              args: [draw.id],
            });
            const grpMap: Record<string, { teamId: string; teamName: string }[]> = {};
            for (const r of groupsRes.rows) {
              const code = String(r.group_code);
              if (!grpMap[code]) grpMap[code] = [];
              grpMap[code].push({ teamId: String(r.team_id), teamName: String(r.team_name) });
            }
            const completedGroups: CompletedDrawGroup[] = Object.entries(grpMap).map(([k, v]) => ({
              groupCode: k,
              teams: v,
            }));
            const summary = formatDrawCompletedSummary(
              tournamentName,
              completedGroups,
              draw.commitment_hash || undefined
            );
            return {
              success: true,
              responseText: `ℹ️ Pengundian grup untuk turnamen ini sudah selesai sebelumnya.\n\n${summary}`,
            };
          }

          // Initial start announcement
          const assignment = JSON.parse(draw.result_json || '[]') as DrawResultGroupAssignment[];
          const totalTeamsInDraw = assignment.reduce((acc, g) => acc + g.teams.length, 0);

          if (this.sender) {
            await this.sender.sendText(
              ctx.message.chat_id,
              `🎲 *MEMULAI PENGUNDIAN GRUP — ${tournamentName.toUpperCase()}*\nTotal: ${totalTeamsInDraw} Tim\nHarap tunggu, hasil undian akan diungkap secara langsung...`
            );
          }

          // Progressive reveal loop (reveal team by team)
          while (true) {
            const step = await revealNext(this.db, draw.id);
            if (step.is_complete || !step.item) {
              break;
            }

            if (this.sender) {
              const revealMsg = formatDrawRevealStep({
                tournamentTitle: tournamentName,
                stepIndex: step.revealed_count,
                totalSteps: step.total_teams,
                teamName: step.item.team_name,
                groupCode: step.item.group_code,
                seedReveal: step.seed_reveal || undefined,
              });
              await this.sender.sendText(ctx.message.chat_id, revealMsg);
              // Pacing delay between team reveals (2500ms)
              await new Promise((r) => setTimeout(r, 2500));
            }
          }

          // Generate balanced round-robin group fixtures
          await generateGroupStageFixtures(this.db, tournamentId);

          // Transition tournament status to ACTIVE
          await this.db.execute({
            sql: `UPDATE tournaments SET status = 'ACTIVE', updated_at = ? WHERE id = ?`,
            args: [new Date().toISOString(), tournamentId],
          });

          // Send completed draw summary
          const completedGroups: CompletedDrawGroup[] = assignment.map((g) => ({
            groupCode: g.group_code,
            teams: g.teams.map((t) => ({ teamId: t.team_id, teamName: t.team_name })),
          }));
          const summaryMsg = formatDrawCompletedSummary(
            tournamentName,
            completedGroups,
            draw.commitment_hash || undefined
          );

          if (this.sender) {
            await this.sender.sendText(ctx.message.chat_id, summaryMsg);
          }

          // Pathway #11: Fixture Schedule Announcement
          const fixturesRes = await this.db.execute({
            sql: `
              SELECT f.round_code, g.group_code, ta.team_name as team_a_name, tb.team_name as team_b_name, tl.team_name as host_name
              FROM fixtures f
              JOIN groups g ON f.group_id = g.id
              JOIN teams ta ON f.team_a_id = ta.id
              JOIN teams tb ON f.team_b_id = tb.id
              LEFT JOIN teams tl ON f.left_side_team_id = tl.id
              WHERE f.tournament_id = ?
              ORDER BY g.group_code ASC, f.round_code ASC
            `,
            args: [tournamentId],
          });

          const scheduleItems: FixtureScheduleDisplayItem[] = fixturesRes.rows.map((r) => ({
            roundCode: String(r.round_code),
            groupCode: String(r.group_code),
            teamAName: String(r.team_a_name),
            teamBName: String(r.team_b_name),
            leftSideHostName: String(r.host_name || r.team_a_name),
          }));

          const scheduleMsg = formatFixturesSchedule(tournamentName, scheduleItems);

          if (this.sender) {
            await this.sender.sendText(ctx.message.chat_id, scheduleMsg);
          }

          return {
            success: true,
            responseText: this.sender
              ? '✅ Pengundian grup dan jadwal pertandingan babak grup telah berhasil disiarkan!'
              : `${summaryMsg}\n\n${scheduleMsg}`,
          };
        } catch (err: any) {
          return {
            success: false,
            responseText: `⚠️ Gagal menjalankan undian: ${err.message || String(err)}`,
          };
        }
      },
    });

    // !addteam <team_name>
    this.commandRouter.registerCommand({
      command: 'addteam',
      requiredRole: 'ORGANIZER',
      allowedInDm: true,
      allowedInGroup: true,
      description: 'Mendaftarkan tim baru ke turnamen',
      handler: async (ctx: CommandContext) => {
        const teamName = ctx.rawArgs.trim();
        if (!teamName) {
          return {
            success: false,
            responseText: '⚠️ Format: *!addteam <Nama Tim>*\nContoh: `!addteam Garuda FC`',
          };
        }

        const tRes = await this.db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
        if (tRes.rows.length === 0) {
          return {
            success: false,
            responseText: '⚠️ Belum ada turnamen yang dibuat. Buat dulu dengan *!createtournament <Nama Turnamen>*.',
          };
        }
        const tourneyId = String(tRes.rows[0].id);
        const tourneyName = String(tRes.rows[0].name);

        // Check if team with this name already exists in this tournament
        const existRes = await this.db.execute({
          sql: 'SELECT id FROM teams WHERE tournament_id = ? AND LOWER(team_name) = LOWER(?)',
          args: [tourneyId, teamName],
        });
        if (existRes.rows.length > 0) {
          return {
            success: false,
            responseText: `⚠️ Tim *${teamName}* sudah terdaftar di turnamen *${tourneyName}*.`,
          };
        }

        const teamId = randomUUID();
        const now = new Date().toISOString();
        await this.db.execute({
          sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
                VALUES (?, ?, ?, 'PENDING', ?, ?)`,
          args: [teamId, tourneyId, teamName, now, now],
        });

        const cntRes = await this.db.execute({
          sql: 'SELECT COUNT(*) as cnt FROM teams WHERE tournament_id = ?',
          args: [tourneyId],
        });
        const count = Number(cntRes.rows[0].cnt);

        return {
          success: true,
          responseText: [
            `✅ Tim *${teamName}* berhasil didaftarkan ke *${tourneyName}*!`,
            `📊 Total tim terdaftar: *${count} tim*`,
            count >= 8
              ? `\n🎉 *Kuota minimal (8 tim) terpenuhi!* Panitia dapat mengetik *!onboarding* di grup ini untuk memulai verifikasi delegasi resmi masing-masing tim.`
              : `\n💡 _Tambahkan ${8 - count} tim lagi untuk memenuhi syarat minimal 8 tim sebelum pengundian grup._`,
          ].join('\n'),
        };
      },
    });

    // !onboarding
    this.commandRouter.registerCommand({
      command: 'onboarding',
      requiredRole: 'ORGANIZER',
      allowedInDm: false,
      allowedInGroup: true,
      description: 'Memulai verifikasi delegasi resmi tim secara bertahap di grup',
      handler: async (ctx: CommandContext) => {
        const tRes = await this.db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
        if (tRes.rows.length === 0) {
          return { success: false, responseText: '⚠️ Belum ada turnamen yang dibuat.' };
        }
        const tourneyId = String(tRes.rows[0].id);

        const promptResult = await this.onboardingService.getNextOnboardingPrompt(tourneyId);

        if (promptResult.status === 'NO_TEAMS') {
          return {
            success: false,
            responseText: '⚠️ Belum ada tim yang didaftarkan. Gunakan *!addteam <Nama Tim>* terlebih dahulu.',
          };
        }

        if (promptResult.status === 'COMPLETED') {
          return {
            success: true,
            responseText: '✅ Seluruh tim telah memiliki delegasi terverifikasi! Turnamen siap untuk tahap *!draw*.',
          };
        }

        if (promptResult.status === 'PROMPT_READY' && promptResult.promptText && promptResult.team) {
          if (this.sender) {
            const sentKey = await this.sender.sendText(ctx.message.chat_id, promptResult.promptText);
            this.onboardingService.setActivePrompt(tourneyId, promptResult.team.id, sentKey);
            return { success: true };
          } else {
            return { success: true, responseText: promptResult.promptText };
          }
        }

        return { success: false, responseText: 'Status onboarding tidak diketahui.' };
      },
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

      const fixture = await this.resolveFixtureForMessage(message);
      let sessionId: string | null = null;
      let session: ReportSession | undefined;

      if (fixture) {
        const teamId = fixture.team_a_id;
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

    const resolved = await this.identityResolver.resolveIdentity(message.sender_raw_address);
    const senderId = resolved?.delegate?.id || message.sender_normalized_address;

    // Ensure inbound message is recorded in database
    let inboundMsgId = message.id;
    const msgRow = await this.db.execute({
      sql: 'SELECT id FROM inbound_messages WHERE provider_message_key = ? LIMIT 1',
      args: [message.provider_message_key],
    });
    if (msgRow.rows.length > 0) {
      inboundMsgId = String(msgRow.rows[0][0]);
    } else {
      const captured = await captureInboundMessage(this.db, {
        provider_message_key: message.provider_message_key,
        chat_id: message.chat_id,
        sender_raw_address: message.sender_raw_address,
        delegate_id: resolved?.delegate?.id || null,
        message_timestamp: message.message_timestamp,
        message_type: message.message_type,
        text_body: message.text_body,
        caption: message.caption,
        reply_to_key: message.reply_to_key,
        report_session_id: version.report_session_id,
      });
      inboundMsgId = captured.message.id;
    }

    const result = await applyReportCorrection(this.db, {
      target_report_version_id: versionId,
      sender_id: senderId,
      inbound_message_id: inboundMsgId,
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
        const batchResults = await this.processDueDebounceBatches();
        for (const res of batchResults) {
          if (res.whatsappSummary && this.sender) {
            const destChat = res.targetChatId || this.centralGroupJid;
            if (destChat) {
              const sentKey = await this.sender.sendText(destChat, res.whatsappSummary);
              if (sentKey && res.sessionId) {
                try {
                  await this.db.execute({
                    sql: `INSERT OR IGNORE INTO inbound_messages (id, report_session_id, provider_message_key, chat_id, sender_raw_address, sender_normalized_address, address_type, is_from_me, message_type, text_body, message_timestamp, received_at)
                          VALUES (?, ?, ?, ?, 'bot@s.whatsapp.net', 'bot@s.whatsapp.net', 'JID', 1, 'TEXT', ?, ?, ?)`,
                    args: [
                      randomUUID(),
                      res.sessionId,
                      sentKey,
                      destChat,
                      res.whatsappSummary,
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

  private async resolveFixtureForMessage(_message: NormalizedMessage): Promise<{ id: string; team_a_id: string } | null> {
    const res = await this.db.execute({
      sql: `SELECT id, team_a_id FROM fixtures WHERE status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY scheduled_at ASC LIMIT 1`,
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
