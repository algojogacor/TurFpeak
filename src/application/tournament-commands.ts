/**
 * Flash Peak TMS - Tournament Command Handlers (Application Layer)
 * 
 * Registers and coordinates all tournament management WhatsApp command use cases:
 * - !standings: Current group standings tables
 * - !awards: Authoritative tournament awards summary
 * - !schedule / !jadwal: Balanced group stage fixture schedules
 * - !approve: Three-party match report consensus approvals
 * - !createtournament: Tournament registration opening
 * - !draw: Cryptographic draw with live progressive team reveals
 * - !addteam: Team roster pre-registration
 * - !onboarding: Interactive sequential delegate verification
 * - !manualreport: Admin manual match report fallback (FR-FAIL-003, FR-FAIL-004, FR-FAIL-005)
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { CommandRouter } from '../whatsapp/router.js';
import type { CommandContext } from '../whatsapp/types.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import type { IdentityResolver } from '../identity/resolver.js';
import type { OnboardingService } from '../identity/onboarding.js';
import type { MatchdayService } from './matchday-service.js';
import { createTournament } from '../competition/tournament.js';
import { prepareDraw, revealNext } from '../competition/draw.js';
import { generateGroupStageFixtures } from '../competition/fixtures.js';
import { calculateTournamentAwards } from '../stats/awards.js';
import { handleSingleForfeit } from '../competition/walkover.js';
import { recalculateAndPersistGroupStandings } from '../competition/standings.js';
import { handleManualReport } from '../reports/manual.js';
import type { RawPlayerMatchStat } from '../reports/validation.js';
import {
  formatAwardsAnnouncement,
  formatDrawCompletedSummary,
  formatDrawRevealStep,
  formatFixturesSchedule,
  formatMatchReportSummary,
  type CompletedDrawGroup,
  type FixtureScheduleDisplayItem,
} from '../whatsapp/formatters.js';
import {
  parseQuickReport,
  matchScorerToRoster,
  buildLineupWithScorers,
} from '../reports/manual-parser.js';
import type { ManualReportSessionManager, MatchedScorerDetail, PendingManualReport } from './manual-report-session.js';
import type { WoClaimSessionManager } from './wo-claim-session.js';
import type {
  ApproverType,
  ApprovalDecision,
  DrawResultGroupAssignment,
  Player,
  ReportVersion,
  UUID,
} from '../shared/types/index.js';
import type { ApprovalOutcome } from '../reports/approval.js';

export interface TournamentCommandDeps {
  db: Client;
  identityResolver: IdentityResolver;
  onboardingService: OnboardingService;
  manualReportSession: ManualReportSessionManager;
  matchdayService?: MatchdayService;
  woClaimSession?: WoClaimSessionManager;
  sender?: WhatsAppSender;
  getStandingsTable: (tournamentId: UUID, groupId: UUID, groupCode?: string) => Promise<string>;
  submitApproval: (
    reportVersionId: UUID,
    approverType: ApproverType,
    approverId: string,
    decision: ApprovalDecision,
    isOrganizer?: boolean
  ) => Promise<ApprovalOutcome>;
  findVersionByMessageKey: (messageKey: string) => Promise<ReportVersion | null>;
}

export function registerTournamentCommands(
  router: CommandRouter,
  deps: TournamentCommandDeps
): void {
  const { db } = deps;

  // !standings <group_code>
  router.registerCommand({
    command: 'standings',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan tabel klasemen turnamen terkini per grup (contoh: !standings A)',
    handler: async (ctx: CommandContext) => {
      const groupCode = ctx.args[0]?.toUpperCase() || 'A';
      const res = await db.execute({
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
      const standingsText = await deps.getStandingsTable(tournamentId, groupId, groupCode);
      return { success: true, responseText: standingsText };
    },
  });

  // !awards
  router.registerCommand({
    command: 'awards',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan daftar perolehan penghargaan turnamen (Juara, Top Scorer, Best GK)',
    handler: async () => {
      const res = await db.execute('SELECT id, name FROM tournaments ORDER BY created_at DESC LIMIT 1');
      if (res.rows.length === 0) {
        return { success: false, responseText: 'Belum ada turnamen yang terdaftar.' };
      }
      const tournamentId = String(res.rows[0][0]);
      const tournamentName = String(res.rows[0][1]);
      const awards = await calculateTournamentAwards(db, tournamentId);
      const text = formatAwardsAnnouncement(tournamentName, awards);
      return { success: true, responseText: text };
    },
  });

  // !schedule / !jadwal [hari ini | tim | grup]
  const scheduleHandler = async (ctx?: CommandContext) => {
    const rawFilter = (ctx?.rawArgs || '').trim().toLowerCase();

    // 1. If asking about today / active matchday (e.g. "!jadwal hari ini apa", "!jadwal hari ini", "!jadwal sekarang")
    const isTodayQuery =
      rawFilter.includes('hari ini') ||
      rawFilter.includes('today') ||
      rawFilter.includes('sekarang') ||
      rawFilter.includes('ronde ini') ||
      rawFilter.includes('saat ini');

    if (isTodayQuery && deps.matchdayService) {
      const matchdayStatus = await deps.matchdayService.formatMatchdayStatus();
      return {
        success: true,
        responseText: matchdayStatus,
      };
    }

    const tRes = await db.execute("SELECT id, name FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1");
    if (tRes.rows.length === 0) {
      return { success: false, responseText: '⚠️ Belum ada turnamen aktif.' };
    }
    const tournamentId = String(tRes.rows[0].id ?? tRes.rows[0][0]);
    const tournamentName = String(tRes.rows[0].name ?? tRes.rows[0][1]);

    const fixturesRes = await db.execute({
      sql: `
        SELECT 
          f.round_code, 
          g.group_code, 
          ta.team_name as team_a_name, 
          tb.team_name as team_b_name, 
          tl.team_name as host_name,
          (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = ta.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_a_address,
          (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = tb.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_b_address
        FROM fixtures f
        LEFT JOIN groups g ON f.group_id = g.id
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

    const mentionsSet = new Set<string>();
    let scheduleItems: FixtureScheduleDisplayItem[] = fixturesRes.rows.map((r: any) => {
      const rawAddrA = r.delegate_a_address ? String(r.delegate_a_address) : null;
      const rawAddrB = r.delegate_b_address ? String(r.delegate_b_address) : null;

      let phoneA: string | null = null;
      let jidA: string | null = null;
      if (rawAddrA) {
        jidA = jidNormalizedUser(rawAddrA);
        phoneA = jidA.replace(/@.*$/, '');
        mentionsSet.add(jidA);
      }

      let phoneB: string | null = null;
      let jidB: string | null = null;
      if (rawAddrB) {
        jidB = jidNormalizedUser(rawAddrB);
        phoneB = jidB.replace(/@.*$/, '');
        mentionsSet.add(jidB);
      }

      return {
        roundCode: String(r.round_code),
        groupCode: r.group_code ? String(r.group_code) : '-',
        teamAName: String(r.team_a_name),
        teamBName: String(r.team_b_name),
        leftSideHostName: String(r.host_name || r.team_a_name),
        teamADelegatePhone: phoneA,
        teamBDelegatePhone: phoneB,
        teamADelegateJid: jidA,
        teamBDelegateJid: jidB,
      };
    });

    // 2. Filter by specific team or group if specified
    if (rawFilter && !isTodayQuery) {
      const groupMatch = rawFilter.match(/\b(?:grup|group)\s*([a-z0-9]+)\b/i);
      if (groupMatch && groupMatch[1]) {
        const targetGroup = groupMatch[1].toUpperCase();
        scheduleItems = scheduleItems.filter((item) => item.groupCode?.toUpperCase() === targetGroup);
      } else {
        const cleanFilter = rawFilter.replace(/^(jadwal|schedule|main|lawan)\s*/i, '').trim();
        if (cleanFilter.length >= 2) {
          scheduleItems = scheduleItems.filter(
            (item) =>
              item.teamAName.toLowerCase().includes(cleanFilter) ||
              item.teamBName.toLowerCase().includes(cleanFilter)
          );
        }
      }

      if (scheduleItems.length === 0) {
        return {
          success: false,
          responseText: `⚠️ Tidak ditemukan jadwal pertandingan untuk kriteria "${rawFilter}". Ketik *!schedule* untuk melihat semua jadwal.`,
        };
      }
    }

    const scheduleMsg = formatFixturesSchedule(tournamentName, scheduleItems);
    return {
      success: true,
      responseText: scheduleMsg,
      metadata: {
        mentions: Array.from(mentionsSet),
      },
    };
  };

  router.registerCommand({
    command: 'schedule',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan jadwal pertandingan resmi turnamen',
    handler: scheduleHandler,
  });

  router.registerCommand({
    command: 'jadwal',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan jadwal pertandingan resmi turnamen',
    handler: scheduleHandler,
  });

  // !approve
  router.registerCommand({
    command: 'approve',
    requiredRole: 'DELEGATE',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengesahkan draf laporan pertandingan (Reply draf skor atau ketik !approve <id>)',
    handler: async (ctx: CommandContext) => {
      let versionId = ctx.args[0];
      if (!versionId && ctx.message.reply_to_key) {
        const ver = await deps.findVersionByMessageKey(ctx.message.reply_to_key);
        if (ver) versionId = ver.id;
      }
      if (!versionId) {
        const latestVer = await db.execute(`
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
        const verRes = await db.execute({
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
      const outcome = await deps.submitApproval(
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
  router.registerCommand({
    command: 'createtournament',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membuat turnamen baru format grup + gugur (Admin only)',
    handler: async (ctx: CommandContext) => {
      const name = ctx.rawArgs.trim();
      if (!name) {
        return {
          success: false,
          responseText: '⚠️ Format: *!createtournament <Nama Turnamen>*\nContoh: `!createtournament Flash Peak Championship Season 1`',
        };
      }

      try {
        const tournament = await createTournament(db, {
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
  router.registerCommand({
    command: 'draw',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengundi pembagian grup secara acak dan membuat jadwal pertandingan (Admin only)',
    handler: async (ctx: CommandContext) => {
      let tournamentId = ctx.args[0]?.trim();
      let tournamentName = '';

      if (tournamentId) {
        const tRes = await db.execute({
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
        const tRes = await db.execute(`
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
        const draw = await prepareDraw(db, tournamentId);

        if (draw.status === 'COMPLETED') {
          const groupsRes = await db.execute({
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

        if (deps.sender) {
          await deps.sender.sendText(
            ctx.message.chat_id,
            `🎲 *MEMULAI PENGUNDIAN GRUP — ${tournamentName.toUpperCase()}*\nTotal: ${totalTeamsInDraw} Tim\nHarap tunggu, hasil undian akan diungkap secara langsung...`
          );
        }

        // Progressive reveal loop (reveal team by team)
        while (true) {
          const step = await revealNext(db, draw.id);
          if (step.is_complete || !step.item) {
            break;
          }

          if (deps.sender) {
            const revealMsg = formatDrawRevealStep({
              tournamentTitle: tournamentName,
              stepIndex: step.revealed_count,
              totalSteps: step.total_teams,
              teamName: step.item.team_name,
              groupCode: step.item.group_code,
              seedReveal: step.seed_reveal || undefined,
            });
            await deps.sender.sendText(ctx.message.chat_id, revealMsg);
            // Pacing delay between team reveals (2500ms)
            await new Promise((r) => setTimeout(r, 2500));
          }
        }

        // Generate balanced round-robin group fixtures
        await generateGroupStageFixtures(db, tournamentId);

        // Transition tournament status to ACTIVE
        await db.execute({
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

        if (deps.sender) {
          await deps.sender.sendText(ctx.message.chat_id, summaryMsg);
        }

        // Pathway #11: Fixture Schedule Announcement
        const fixturesRes = await db.execute({
          sql: `
            SELECT 
              f.round_code, 
              g.group_code, 
              ta.team_name as team_a_name, 
              tb.team_name as team_b_name, 
              tl.team_name as host_name,
              (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = ta.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_a_address,
              (SELECT raw_address FROM whatsapp_identities WHERE delegate_id = tb.delegate_id ORDER BY is_primary DESC, created_at ASC LIMIT 1) as delegate_b_address
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

        const mentionsSet = new Set<string>();
        const scheduleItems: FixtureScheduleDisplayItem[] = fixturesRes.rows.map((r: any) => {
          const rawAddrA = r.delegate_a_address ? String(r.delegate_a_address) : null;
          const rawAddrB = r.delegate_b_address ? String(r.delegate_b_address) : null;

          let phoneA: string | null = null;
          let jidA: string | null = null;
          if (rawAddrA) {
            jidA = jidNormalizedUser(rawAddrA);
            phoneA = jidA.replace(/@.*$/, '');
            mentionsSet.add(jidA);
          }

          let phoneB: string | null = null;
          let jidB: string | null = null;
          if (rawAddrB) {
            jidB = jidNormalizedUser(rawAddrB);
            phoneB = jidB.replace(/@.*$/, '');
            mentionsSet.add(jidB);
          }

          return {
            roundCode: String(r.round_code),
            groupCode: String(r.group_code),
            teamAName: String(r.team_a_name),
            teamBName: String(r.team_b_name),
            leftSideHostName: String(r.host_name || r.team_a_name),
            teamADelegatePhone: phoneA,
            teamBDelegatePhone: phoneB,
            teamADelegateJid: jidA,
            teamBDelegateJid: jidB,
          };
        });

        const scheduleMsg = formatFixturesSchedule(tournamentName, scheduleItems);

        if (deps.sender) {
          await deps.sender.sendText(ctx.message.chat_id, scheduleMsg, {
            mentions: Array.from(mentionsSet),
          });
        }

        return {
          success: true,
          responseText: deps.sender
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
  router.registerCommand({
    command: 'addteam',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mendaftarkan tim baru ke turnamen (Admin only)',
    handler: async (ctx: CommandContext) => {
      const teamName = ctx.rawArgs.trim();
      if (!teamName) {
        return {
          success: false,
          responseText: '⚠️ Format: *!addteam <Nama Tim>*\nContoh: `!addteam Garuda FC`',
        };
      }

      const tRes = await db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
      if (tRes.rows.length === 0) {
        return {
          success: false,
          responseText: '⚠️ Belum ada turnamen yang dibuat. Buat dulu dengan *!createtournament <Nama Turnamen>*.',
        };
      }
      const tourneyId = String(tRes.rows[0].id);
      const tourneyName = String(tRes.rows[0].name);

      // Check if team with this name already exists in this tournament
      const existRes = await db.execute({
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
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, 'PENDING', ?, ?)`,
        args: [teamId, tourneyId, teamName, now, now],
      });

      const cntRes = await db.execute({
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
  router.registerCommand({
    command: 'onboarding',
    requiredRole: 'ORGANIZER',
    allowedInDm: false,
    allowedInGroup: true,
    description: 'Memulai verifikasi delegasi resmi tim di grup secara bertahap (Admin only)',
    handler: async (ctx: CommandContext) => {
      const tRes = await db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
      if (tRes.rows.length === 0) {
        return { success: false, responseText: '⚠️ Belum ada turnamen yang dibuat.' };
      }
      const tourneyId = String(tRes.rows[0].id);

      const promptResult = await deps.onboardingService.getNextOnboardingPrompt(tourneyId);

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
        if (deps.sender) {
          const sentKey = await deps.sender.sendText(ctx.message.chat_id, promptResult.promptText);
          deps.onboardingService.setActivePrompt(tourneyId, promptResult.team.id, sentKey);
          return { success: true };
        } else {
          return { success: true, responseText: promptResult.promptText };
        }
      }

      return { success: false, responseText: 'Status onboarding tidak diketahui.' };
    },
  });

  // !manualreport
  router.registerCommand({
    command: 'manualreport',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membuat draf laporan pertandingan manual saat AI terkendala (Admin only)',
    handler: async (ctx: CommandContext) => {
      const trimmed = ctx.rawArgs.trim();

      // 1. Full JSON Format (No guessing needed, direct execution)
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          const fixtureId = parsed.fixture_id;
          const gameId = parsed.game_id;
          const scoreA = Number(parsed.team_a_score);
          const scoreB = Number(parsed.team_b_score);
          const notes = parsed.notes;
          const teamAPlayers: RawPlayerMatchStat[] = parsed.team_a_players || [];
          const teamBPlayers: RawPlayerMatchStat[] = parsed.team_b_players || [];

          if (!fixtureId || isNaN(scoreA) || isNaN(scoreB) || scoreA < 0 || scoreB < 0) {
            return {
              success: false,
              responseText: '⚠️ Parameter JSON tidak valid. Pastikan fixture_id dan skor non-negatif telah diisi.',
            };
          }

          const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';
          const res = await handleManualReport(db, {
            organizer_id: organizerId,
            is_organizer: true,
            fixture_id: fixtureId,
            game_id: gameId,
            team_a_score: scoreA,
            team_b_score: scoreB,
            team_a_players: teamAPlayers,
            team_b_players: teamBPlayers,
            notes,
          });

          if (!res.success || !res.version) {
            return {
              success: false,
              responseText: `⚠️ Gagal membuat draf laporan manual:\n${(res.errors || []).join('\n')}`,
            };
          }

          // Fetch team names for formatting
          const fixRes = await db.execute({
            sql: 'SELECT team_a_id, team_b_id FROM fixtures WHERE id = ?',
            args: [fixtureId],
          });
          const teamAId = String(fixRes.rows[0]?.team_a_id ?? fixRes.rows[0]?.[0]);
          const teamBId = String(fixRes.rows[0]?.team_b_id ?? fixRes.rows[0]?.[1]);

          const teamsRes = await db.execute({
            sql: 'SELECT id, team_name FROM teams WHERE id IN (?, ?)',
            args: [teamAId, teamBId],
          });
          const teamAName = String(
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.team_name ??
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.[1] ??
            'Tim A'
          );
          const teamBName = String(
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.team_name ??
            teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.[1] ??
            'Tim B'
          );

          const summaryText = formatMatchReportSummary({
            status: 'PENDING_APPROVAL',
            versionNumber: res.version.version_number,
            fixtureCode: fixtureId,
            teamAName,
            teamBName,
            teamAScore: scoreA,
            teamBScore: scoreB,
            teamAPlayers: teamAPlayers.map((p, idx) => ({
              ordinal: idx + 1,
              nickname: p.nickname_raw,
              rating: p.rating,
              goals: p.goals ?? 0,
              assists: p.assists ?? 0,
              passes: p.passes,
              defense: p.defense_raw,
              saves: p.goalkeeper_saves,
            })),
            teamBPlayers: teamBPlayers.map((p, idx) => ({
              ordinal: idx + 1,
              nickname: p.nickname_raw,
              rating: p.rating,
              goals: p.goals ?? 0,
              assists: p.assists ?? 0,
              passes: p.passes,
              defense: p.defense_raw,
              saves: p.goalkeeper_saves,
            })),
            pendingApprovers: ['TEAM_A', 'TEAM_B', 'ORGANIZER'],
          });

          return { success: true, responseText: summaryText };
        } catch (err: any) {
          return {
            success: false,
            responseText: `⚠️ Format JSON tidak valid: ${err.message}`,
          };
        }
      }

      // 2. Usage Guide if empty or help
      if (!trimmed || trimmed === 'help' || ctx.args.length < 2) {
        return {
          success: false,
          responseText: [
            `⚠️ *Format Perintah !manualreport (Khusus Organizer)*`,
            ``,
            `1️⃣ *Format Ringkas (Daftar Pencetak Gol):*`,
            `\`!manualreport <fixture_id> <skor_a>-<skor_b>\``,
            `\`gol A: <nama1>, <nama2>\``,
            `\`gol B: <nama3>\``,
            ``,
            `_Contoh satu baris:_`,
            `\`!manualreport fix-001 2-1 A:Bunny,Razorr B:Ikyy\``,
            ``,
            `_Contoh jumlah gol > 1:_`,
            `\`!manualreport fix-001 2-1 A:Bunny(2) B:Ikyy\``,
            ``,
            `_Catatan:_ Bot akan mencocokkan nama ke roster tim dan menampilkan ringkasan untuk Anda konfirmasi (balas *OK*) sebelum draf dibuat.`,
            ``,
            `2️⃣ *Format Tanpa Rincian Pencetak (Unassigned):*`,
            `\`!manualreport <fixture_id> <skor_a>-<skor_b> [catatan]\``,
            `_Gol dicatat sebagai belum ditugaskan dan harus dilengkapi via koreksi sebelum !approve._`,
            ``,
            `3️⃣ *Format JSON Lengkap:*`,
            `\`!manualreport {"fixture_id":"fix-001","team_a_score":2,"team_b_score":1,"team_a_players":[...],"team_b_players":[...]}\``,
          ].join('\n'),
        };
      }

      // 3. Quick Format Parsing
      const parsed = parseQuickReport(trimmed);
      if (!parsed.success || !parsed.data) {
        return {
          success: false,
          responseText: `⚠️ ${parsed.error || 'Format tidak valid.'}`,
        };
      }

      const { fixtureId, scoreA, scoreB, rawScorersA, rawScorersB, notes, hasExplicitScorers } = parsed.data;

      // Look up fixture
      const fixtureRes = await db.execute({
        sql: 'SELECT id, tournament_id, team_a_id, team_b_id, status FROM fixtures WHERE id = ?',
        args: [fixtureId],
      });
      if (fixtureRes.rows.length === 0) {
        return { success: false, responseText: `⚠️ Fixture tidak ditemukan: ${fixtureId}` };
      }
      const fixtureRow = fixtureRes.rows[0];
      const teamAId = String(fixtureRow.team_a_id ?? fixtureRow[2]);
      const teamBId = String(fixtureRow.team_b_id ?? fixtureRow[3]);

      // Fetch team names
      const teamsRes = await db.execute({
        sql: 'SELECT id, team_name FROM teams WHERE id IN (?, ?)',
        args: [teamAId, teamBId],
      });
      const teamAName = String(
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.team_name ??
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamAId)?.[1] ??
        'Tim A'
      );
      const teamBName = String(
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.team_name ??
        teamsRes.rows.find((r) => String(r.id ?? r[0]) === teamBId)?.[1] ??
        'Tim B'
      );

      // Fetch active registered rosters
      const playersRes = await db.execute({
        sql: `
          SELECT id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key,
                 position, roster_slot, roster_type, status
          FROM players
          WHERE team_id IN (?, ?) AND status = 'ACTIVE'
          ORDER BY roster_slot ASC
        `,
        args: [teamAId, teamBId],
      });

      const rosterA: Player[] = playersRes.rows
        .filter((r) => String(r.team_id ?? r[2]) === teamAId)
        .map((r) => ({
          id: String(r.id ?? r[0]),
          tournament_id: String(r.tournament_id ?? r[1]),
          team_id: teamAId,
          nickname_raw: String(r.nickname_raw ?? r[3]),
          nickname_nfc: String(r.nickname_nfc ?? r[4]),
          nickname_search_key: String(r.nickname_search_key ?? r[5]),
          position: String(r.position ?? r[6]) as Player['position'],
          roster_slot: Number(r.roster_slot ?? r[7]),
          roster_type: String(r.roster_type ?? r[8]) as Player['roster_type'],
          status: String(r.status ?? r[9]) as Player['status'],
          created_at: '',
          updated_at: '',
        }));

      const rosterB: Player[] = playersRes.rows
        .filter((r) => String(r.team_id ?? r[2]) === teamBId)
        .map((r) => ({
          id: String(r.id ?? r[0]),
          tournament_id: String(r.tournament_id ?? r[1]),
          team_id: teamBId,
          nickname_raw: String(r.nickname_raw ?? r[3]),
          nickname_nfc: String(r.nickname_nfc ?? r[4]),
          nickname_search_key: String(r.nickname_search_key ?? r[5]),
          position: String(r.position ?? r[6]) as Player['position'],
          roster_slot: Number(r.roster_slot ?? r[7]),
          roster_type: String(r.roster_type ?? r[8]) as Player['roster_type'],
          status: String(r.status ?? r[9]) as Player['status'],
          created_at: '',
          updated_at: '',
        }));

      if (rosterA.length < 5 || rosterB.length < 5) {
        return {
          success: false,
          responseText: `⚠️ Salah satu tim belum memiliki 5 pemain terdaftar aktif (1 GK, 4 outfield). ${teamAName}: ${rosterA.length}, ${teamBName}: ${rosterB.length}.`,
        };
      }

      let matchedA: MatchedScorerDetail[] = [];
      let matchedB: MatchedScorerDetail[] = [];
      let unassignedA = 0;
      let unassignedB = 0;
      let teamAPlayers: RawPlayerMatchStat[] = [];
      let teamBPlayers: RawPlayerMatchStat[] = [];

      if (hasExplicitScorers) {
        // Validate scorer goal sums against reported scores
        const totalA = rawScorersA.reduce((sum, s) => sum + s.goals, 0);
        const totalB = rawScorersB.reduce((sum, s) => sum + s.goals, 0);

        if (totalA !== scoreA) {
          const diff = Math.abs(totalA - scoreA);
          return {
            success: false,
            responseText: `⚠️ Jumlah gol di daftar pencetak ${teamAName} (${totalA}) tidak cocok dengan skor tim (${scoreA}). Selisih: ${diff} gol. Mohon lengkapi.`,
          };
        }
        if (totalB !== scoreB) {
          const diff = Math.abs(totalB - scoreB);
          return {
            success: false,
            responseText: `⚠️ Jumlah gol di daftar pencetak ${teamBName} (${totalB}) tidak cocok dengan skor tim (${scoreB}). Selisih: ${diff} gol. Mohon lengkapi.`,
          };
        }

        // Fuzzy match scorers for Team A
        for (const item of rawScorersA) {
          const matchRes = matchScorerToRoster(item.name, rosterA);
          if (!matchRes.player) {
            return {
              success: false,
              responseText: `⚠️ ${matchRes.error || `Pencetak "${item.name}" tidak ditemukan di roster ${teamAName}.`}`,
            };
          }
          matchedA.push({
            inputName: item.name,
            matchedNickname: matchRes.player.nickname_raw,
            playerId: matchRes.player.id,
            goals: item.goals,
            similarity: matchRes.similarity,
          });
        }

        // Fuzzy match scorers for Team B
        for (const item of rawScorersB) {
          const matchRes = matchScorerToRoster(item.name, rosterB);
          if (!matchRes.player) {
            return {
              success: false,
              responseText: `⚠️ ${matchRes.error || `Pencetak "${item.name}" tidak ditemukan di roster ${teamBName}.`}`,
            };
          }
          matchedB.push({
            inputName: item.name,
            matchedNickname: matchRes.player.nickname_raw,
            playerId: matchRes.player.id,
            goals: item.goals,
            similarity: matchRes.similarity,
          });
        }

        const lineupA = buildLineupWithScorers(rosterA, matchedA, scoreB, false);
        if (lineupA.error) return { success: false, responseText: `⚠️ ${lineupA.error}` };
        teamAPlayers = lineupA.lineup;

        const lineupB = buildLineupWithScorers(rosterB, matchedB, scoreA, false);
        if (lineupB.error) return { success: false, responseText: `⚠️ ${lineupB.error}` };
        teamBPlayers = lineupB.lineup;
      } else {
        // Fallback case: no scorers provided at all
        unassignedA = scoreA;
        unassignedB = scoreB;

        const lineupA = buildLineupWithScorers(rosterA, [], scoreB, true);
        if (lineupA.error) return { success: false, responseText: `⚠️ ${lineupA.error}` };
        teamAPlayers = lineupA.lineup;

        const lineupB = buildLineupWithScorers(rosterB, [], scoreA, true);
        if (lineupB.error) return { success: false, responseText: `⚠️ ${lineupB.error}` };
        teamBPlayers = lineupB.lineup;
      }

      // Stage in pending confirmation session (DO NOT create draft report yet!)
      const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';
      const pending: PendingManualReport = {
        fixtureId,
        scoreA,
        scoreB,
        teamAId,
        teamBId,
        teamAName,
        teamBName,
        teamAPlayers,
        teamBPlayers,
        rosterA,
        rosterB,
        matchedDetailsA: matchedA,
        matchedDetailsB: matchedB,
        unassignedGoalsA: unassignedA,
        unassignedGoalsB: unassignedB,
        notes,
        organizerId,
        chatId: ctx.message.chat_id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
      };

      deps.manualReportSession.stagePendingReport(pending);
      const confirmationPrompt = deps.manualReportSession.formatConfirmationPrompt(pending);

      return {
        success: true,
        responseText: confirmationPrompt,
      };
    },
  });

  // !confirm / !ok
  const confirmHandler = async (ctx: CommandContext) => {
    const organizerId = ctx.delegateId || ctx.message.sender_normalized_address || 'ORGANIZER';

    // 1. Check WO Claim Pending first
    if (deps.woClaimSession?.hasPending(ctx.message.chat_id)) {
      const woRes = await deps.woClaimSession.confirmPending(
        db,
        ctx.message.chat_id,
        organizerId
      );
      if (!woRes.success) {
        return { success: false, responseText: woRes.error };
      }
      return { success: true, responseText: woRes.replyText };
    }

    // 2. Check Manual Report Pending
    const confirmRes = await deps.manualReportSession.confirmPending(
      db,
      ctx.message.chat_id,
      organizerId
    );
    if (!confirmRes.success) {
      return { success: false, responseText: confirmRes.error };
    }
    return { success: true, responseText: confirmRes.replyText };
  };

  // !batal / !reject / !tolak
  const cancelHandler = async (ctx: CommandContext) => {
    if (deps.woClaimSession?.hasPending(ctx.message.chat_id)) {
      const rejectRes = deps.woClaimSession.rejectPending(ctx.message.chat_id);
      return { success: true, responseText: rejectRes.replyText };
    }
    if (deps.manualReportSession.hasPending(ctx.message.chat_id)) {
      deps.manualReportSession.clearPending(ctx.message.chat_id);
      return { success: true, responseText: '❌ Draf laporan pertandingan manual telah dibatalkan oleh Admin.' };
    }
    return {
      success: false,
      responseText: '⚠️ Tidak ada pengajuan klaim WO atau draf manual yang sedang menunggu konfirmasi.',
    };
  };

  router.registerCommand({
    command: 'confirm',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengonfirmasi klaim WO atau draf laporan manual (Admin only)',
    handler: confirmHandler,
  });

  router.registerCommand({
    command: 'ok',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengonfirmasi klaim WO atau draf laporan manual (Admin only)',
    handler: confirmHandler,
  });

  router.registerCommand({
    command: 'batal',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membatalkan / menolak pengajuan klaim WO atau draf laporan manual (Admin only)',
    handler: cancelHandler,
  });

  router.registerCommand({
    command: 'reject',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membatalkan / menolak pengajuan klaim WO atau draf laporan manual (Admin only)',
    handler: cancelHandler,
  });

  router.registerCommand({
    command: 'tolak',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Membatalkan / menolak pengajuan klaim WO atau draf laporan manual (Admin only)',
    handler: cancelHandler,
  });

  // !matchday / !ronde
  router.registerCommand({
    command: 'matchday',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat status ronde, batas waktu 19:59 WIB, dan sisa pertandingan',
    handler: async (ctx: CommandContext) => {
      if (!deps.matchdayService) {
        return { success: false, responseText: '⚠️ Layanan matchday belum diaktifkan.' };
      }

      if (ctx.args[0]?.toLowerCase() === 'cutoff') {
        if (!ctx.isOrganizer) {
          return { success: false, responseText: '⚠️ Hanya panitia yang dapat memicu cutoff matchday manual.' };
        }
        const cutoffRes = await deps.matchdayService.processDailyCutoff(true);
        if (!cutoffRes.announcementText) {
          return {
            success: true,
            responseText: '✅ Evaluasi cutoff selesai. Seluruh pertandingan pada ronde aktif telah diselesaikan sebelumnya.',
          };
        }
        return {
          success: true,
          responseText: cutoffRes.announcementText,
          metadata: { mentions: cutoffRes.mentions },
        };
      }

      const statusText = await deps.matchdayService.formatMatchdayStatus();
      return { success: true, responseText: statusText };
    },
  });

  router.registerCommand({
    command: 'ronde',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Melihat status ronde, batas waktu 19:59 WIB, dan sisa pertandingan',
    handler: async (_ctx: CommandContext) => {
      if (!deps.matchdayService) {
        return { success: false, responseText: '⚠️ Layanan matchday belum diaktifkan.' };
      }
      const statusText = await deps.matchdayService.formatMatchdayStatus();
      return { success: true, responseText: statusText };
    },
  });

  // !rule / !rules / !regulasi
  const ruleHandler = async () => {
    return {
      success: true,
      responseText: [
        `📜 *REGULASI RESMI TURNAMEN FLASH PEAK*`,
        `──────────────────────────────`,
        `1. 👥 *Tim & Roster:*`,
        `   • 5 vs 5 (1 Kiper + 4 Pemain Inti).`,
        `   • Cadangan: Maksimal 5 pemain cadangan (Format 5+5, total max 10 pemain).`,
        `   • Nickname in-game WAJIB sama persis dengan yang didaftarkan.`,
        `   • Format daftar roster:`,
        `     *!roster <Nama Tim> GK: [Nama GK] | Inti: [P1, P2, P3, P4] | Cadangan: [C1, C2]*`,
        ``,
        `2. 🏆 *Format Kompetisi:*`,
        `   • *Babak Grup:* Single Round-Robin (1 leg, durasi 8 menit).`,
        `   • *Poin Grup:* Menang = 3 poin | Seri Sah = 1 poin | Kalah = 0 poin.`,
        `   • *Fase Knockout:* Best of 3 (BO3). Grand Final: Best of 5 (BO5).`,
        `   • Top 2 tim teratas tiap grup lolos ke fase gugur.`,
        ``,
        `3. ⏰ *Jadwal & Batasan Waktu (19:59 WIB):*`,
        `   • Setiap ronde matchday dimulai dan berakhir pukul *19:59 WIB* (24 jam per ronde).`,
        `   • Pengingat otomatis dikirim pada pukul 17:00 WIB dan 18:59 WIB.`,
        ``,
        `4. 🏠 *Host Room:*`,
        `   • Tim sebelah kiri pada jadwal (*!schedule*) bertindak sebagai Host Room default.`,
        `   • Jika host tidak memiliki room card, tim lawan dapat menggantikan menjadi host.`,
        ``,
        `5. ❌ *Walkover (WO) & Forfeit (D-031):*`,
        `   • *WO Tunggal:* Lawan tidak hadir 10 menit setelah jadwal atau menolak membuat room. Tim hadir menang 3–0 (3 poin).`,
        `   • *Double WO:* Kedua tim tidak bermain hingga pukul 19:59 WIB. Skor dicatat 0–0 dan masing-masing mendapatkan *0 poin*.`,
        `   • Klaim WO dilaporkan ke Panitia untuk disahkan via *!claimwo*.`,
        ``,
        `6. 📸 *Pelaporan Skor:*`,
        `   • Delegasi tim pemenang wajib mengirim screenshot hasil akhir match + screenshot kartu statistik kiper.`,
        `──────────────────────────────`,
        `💡 _Ketik *!schedule* untuk jadwal pertandingan, atau *!roster <Nama Tim>* untuk mengecek susunan pemain._`,
      ].join('\n'),
    };
  };

  router.registerCommand({
    command: 'rule',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan regulasi resmi turnamen',
    handler: ruleHandler,
  });

  router.registerCommand({
    command: 'rules',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan regulasi resmi turnamen',
    handler: ruleHandler,
  });

  router.registerCommand({
    command: 'regulasi',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Menampilkan regulasi resmi turnamen',
    handler: ruleHandler,
  });

  // !roster [Nama Tim] [GK: ... | Inti: ... | Cadangan: ...]
  router.registerCommand({
    command: 'roster',
    requiredRole: 'ANY',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mendaftarkan atau melihat roster pemain tim (Format 5+5: 1 GK, 4 Inti, max 5 Cadangan)',
    handler: async (ctx: CommandContext) => {
      const raw = ctx.rawArgs.trim();

      // Check active tournament
      const tRes = await db.execute("SELECT id, name FROM tournaments WHERE status NOT IN ('COMPLETED', 'ARCHIVED') ORDER BY created_at DESC LIMIT 1");
      if (tRes.rows.length === 0) {
        return { success: false, responseText: '⚠️ Belum ada turnamen aktif.' };
      }
      const tournamentId = String(tRes.rows[0].id ?? tRes.rows[0][0]);
      const tournamentName = String(tRes.rows[0].name ?? tRes.rows[0][1]);

      if (!raw) {
        return {
          success: true,
          responseText: [
            `📋 *PANDUAN PERINTAH ROSTER (FORMAT 5+5)*`,
            `──────────────────────────────`,
            `1. *Melihat Roster Tim:*`,
            `   \`!roster <Nama Tim>\``,
            `   Contoh: \`!roster Garuda FC\``,
            ``,
            `2. *Mendaftarkan / Memperbarui Roster:*`,
            `   \`!roster <Nama Tim> GK: [Nama GK] | Inti: [P1, P2, P3, P4] | Cadangan: [C1, C2, C3]\``,
            `   Contoh:`,
            `   \`!roster Garuda FC GK: Ikyy | Inti: Budi, Joko, Doni, Reza | Cadangan: Rian, Kevin\``,
            `──────────────────────────────`,
            `💡 _Minimal 5 pemain (1 GK + 4 Inti). Maksimal 5 cadangan (Total max 10 pemain)._`,
          ].join('\n'),
        };
      }

      const lowerRaw = raw.toLowerCase();
      const isRegistration = lowerRaw.includes('gk:') || lowerRaw.includes('kiper:');

      if (!isRegistration) {
        // VIEW ROSTER
        const targetTeamName = raw;
        const teamRes = await db.execute({
          sql: `SELECT id, team_name, delegate_id FROM teams WHERE tournament_id = ? AND LOWER(team_name) = LOWER(?) LIMIT 1`,
          args: [tournamentId, targetTeamName],
        });

        if (teamRes.rows.length === 0) {
          return {
            success: false,
            responseText: `⚠️ Tim *${targetTeamName}* tidak ditemukan di turnamen *${tournamentName}*.`,
          };
        }

        const teamId = String(teamRes.rows[0].id ?? teamRes.rows[0][0]);
        const officialTeamName = String(teamRes.rows[0].team_name ?? teamRes.rows[0][1]);

        const playersRes = await db.execute({
          sql: `SELECT nickname_raw, position, roster_slot, roster_type
                FROM players
                WHERE team_id = ? AND tournament_id = ? AND status = 'ACTIVE'
                ORDER BY roster_slot ASC`,
          args: [teamId, tournamentId],
        });

        if (playersRes.rows.length === 0) {
          return {
            success: true,
            responseText: [
              `📋 *ROSTER TIM: ${officialTeamName.toUpperCase()}*`,
              `──────────────────────────────`,
              `⚠️ Belum ada pemain yang didaftarkan untuk tim ini.`,
              ``,
              `*Format Pendaftaran:*`,
              `\`!roster ${officialTeamName} GK: [Nama GK] | Inti: [P1, P2, P3, P4] | Cadangan: [C1, C2]\``,
            ].join('\n'),
          };
        }

        const gk = playersRes.rows.find((r: any) => String(r.position) === 'GOALKEEPER' || Number(r.roster_slot) === 1);
        const starters = playersRes.rows.filter((r: any) => String(r.roster_type) === 'STARTER' && String(r.position) !== 'GOALKEEPER');
        const subs = playersRes.rows.filter((r: any) => String(r.roster_type) === 'SUBSTITUTE');

        const lines: string[] = [];
        lines.push(`📋 *ROSTER RESMI TIM: ${officialTeamName.toUpperCase()}*`);
        lines.push(`──────────────────────────────`);
        lines.push(`🧤 *Kiper (Slot 1):* ${gk ? String(gk.nickname_raw) : '-(belum ada)-'}`);
        lines.push(`🏃 *Pemain Inti (Slot 2–5):*`);
        if (starters.length === 0) {
          lines.push(`  _(belum ada)_`);
        } else {
          starters.forEach((s: any, idx: number) => {
            lines.push(`  ${idx + 2}. ${String(s.nickname_raw)}`);
          });
        }

        lines.push(`🪑 *Pemain Cadangan (Slot 6–10):*`);
        if (subs.length === 0) {
          lines.push(`  _(tidak ada cadangan)_`);
        } else {
          subs.forEach((s: any, idx: number) => {
            lines.push(`  ${idx + 6}. ${String(s.nickname_raw)}`);
          });
        }
        lines.push(`──────────────────────────────`);
        lines.push(`📊 Total: *${playersRes.rows.length} / 10* pemain terdaftar.`);

        return { success: true, responseText: lines.join('\n') };
      }

      // REGISTER / UPDATE ROSTER
      // Extract team name before gk: or kiper:
      const matchGkPrefix = raw.match(/^(.*?)(?:gk|kiper):/i);
      const teamNamePart = matchGkPrefix ? matchGkPrefix[1].trim() : '';

      if (!teamNamePart) {
        return {
          success: false,
          responseText: '⚠️ Format salah: Nama tim harus dicantumkan di awal.\nContoh: `!roster Garuda FC GK: Ikyy | Inti: Budi, Joko, Doni, Reza | Cadangan: Rian`',
        };
      }

      const teamRes = await db.execute({
        sql: `SELECT id, team_name, delegate_id FROM teams WHERE tournament_id = ? AND LOWER(team_name) = LOWER(?) LIMIT 1`,
        args: [tournamentId, teamNamePart],
      });

      if (teamRes.rows.length === 0) {
        return {
          success: false,
          responseText: `⚠️ Tim *${teamNamePart}* tidak ditemukan di turnamen *${tournamentName}*.`,
        };
      }

      const teamId = String(teamRes.rows[0].id ?? teamRes.rows[0][0]);
      const officialTeamName = String(teamRes.rows[0].team_name ?? teamRes.rows[0][1]);
      const officialDelegateId = teamRes.rows[0].delegate_id ? String(teamRes.rows[0].delegate_id) : null;

      // Authorization: must be Organizer OR team delegate
      if (!ctx.isOrganizer && ctx.delegateId !== officialDelegateId) {
        return {
          success: false,
          responseText: `⛔ Hanya Panitia atau delegasi resmi dari *${officialTeamName}* yang berhak mendaftarkan roster tim ini.`,
        };
      }

      // Parse fields: GK, Inti, Cadangan
      const afterTeam = raw.slice(matchGkPrefix![0].length - 3); // starts with "gk:"
      // Normalize separators
      const parts = afterTeam.split(/[|;\n]+/);
      let gkName = '';
      const starterList: string[] = [];
      const subList: string[] = [];

      for (const part of parts) {
        const trimmedPart = part.trim();
        if (/^(?:gk|kiper):/i.test(trimmedPart)) {
          const val = trimmedPart.replace(/^(?:gk|kiper):/i, '').trim();
          if (val) gkName = val.split(/[,/]/)[0]?.trim() || '';
        } else if (/^(?:inti|pemain|starters?):/i.test(trimmedPart)) {
          const val = trimmedPart.replace(/^(?:inti|pemain|starters?):/i, '').trim();
          val.split(/[,/]/).map((s) => s.trim()).filter(Boolean).forEach((s) => starterList.push(s));
        } else if (/^(?:cadangan|subs?|substitutes?):/i.test(trimmedPart)) {
          const val = trimmedPart.replace(/^(?:cadangan|subs?|substitutes?):/i, '').trim();
          val.split(/[,/]/).map((s) => s.trim()).filter(Boolean).forEach((s) => subList.push(s));
        }
      }

      if (!gkName) {
        return {
          success: false,
          responseText: '⚠️ Nama Kiper (GK) wajib diisi. Contoh: `GK: Ikyy`',
        };
      }

      if (starterList.length < 4) {
        return {
          success: false,
          responseText: `⚠️ Pemain inti harus minimal 4 pemain outfield (saat ini terdeteksi: ${starterList.length}).\nContoh: \`Inti: Budi, Joko, Doni, Reza\``,
        };
      }

      if (starterList.length > 4) {
        // Move excess starters to subs if space permits
        const excess = starterList.splice(4);
        subList.unshift(...excess);
      }

      if (subList.length > 5) {
        return {
          success: false,
          responseText: `⚠️ Maksimal pemain cadangan adalah 5 orang (Format 5+5). Anda memasukkan ${subList.length} cadangan.`,
        };
      }

      // Validate all names are unique within team
      const allNames = [gkName, ...starterList, ...subList];
      const normalizedMap = new Set<string>();
      for (const n of allNames) {
        const norm = n.toLowerCase().trim();
        if (normalizedMap.has(norm)) {
          return {
            success: false,
            responseText: `⚠️ Ditemukan nama ganda di dalam roster: *"${n}"*. Setiap pemain harus memiliki nickname unik.`,
          };
        }
        normalizedMap.add(norm);
      }

      // Save into players table
      // 1. Delete previous players for this team in this tournament
      await db.execute({
        sql: `DELETE FROM players WHERE team_id = ? AND tournament_id = ?`,
        args: [teamId, tournamentId],
      });

      const now = new Date().toISOString();

      // Slot 1: GK
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'GOALKEEPER', 1, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          randomUUID(),
          tournamentId,
          teamId,
          gkName,
          gkName.normalize('NFC'),
          gkName.toLowerCase().replace(/[^a-z0-9]/g, ''),
          now,
          now,
        ],
      });

      // Slot 2-5: Starters
      for (let i = 0; i < starterList.length; i++) {
        const pName = starterList[i];
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'OUTFIELD', ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            randomUUID(),
            tournamentId,
            teamId,
            pName,
            pName.normalize('NFC'),
            pName.toLowerCase().replace(/[^a-z0-9]/g, ''),
            i + 2,
            now,
            now,
          ],
        });
      }

      // Slot 6-10: Substitutes
      for (let i = 0; i < subList.length; i++) {
        const sName = subList[i];
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'OUTFIELD', ?, 'SUBSTITUTE', 'ACTIVE', ?, ?)`,
          args: [
            randomUUID(),
            tournamentId,
            teamId,
            sName,
            sName.normalize('NFC'),
            sName.toLowerCase().replace(/[^a-z0-9]/g, ''),
            i + 6,
            now,
            now,
          ],
        });
      }

      const lines: string[] = [];
      lines.push(`✅ *ROSTER TIM ${officialTeamName.toUpperCase()} BERHASIL DIDAFTARKAN!*`);
      lines.push(`──────────────────────────────`);
      lines.push(`🧤 *Kiper (Slot 1):* ${gkName}`);
      lines.push(`🏃 *Pemain Inti (Slot 2–5):*`);
      starterList.forEach((s, idx) => lines.push(`  ${idx + 2}. ${s}`));
      lines.push(`🪑 *Pemain Cadangan (Slot 6–10):*`);
      if (subList.length === 0) {
        lines.push(`  _(tidak ada cadangan)_`);
      } else {
        subList.forEach((s, idx) => lines.push(`  ${idx + 6}. ${s}`));
      }
      lines.push(`──────────────────────────────`);
      lines.push(`📊 Total Terdaftar: *${allNames.length} / 10* pemain (Format 5+5).`);
      lines.push(`💡 _Roster ini akan otomatis dicocokkan oleh sistem saat pemrosesan skor dan penghargaan turnamen._`);

      return { success: true, responseText: lines.join('\n') };
    },
  });

  // !claimwo / !wo <fixture_id> <nama_tim_forfeit> [alasan]
  const claimWoHandler = async (ctx: CommandContext) => {
    if (!ctx.isOrganizer) {
      return {
        success: false,
        responseText: '⛔ Perintah ini hanya dapat dijalankan oleh Panitia / Organizer.',
      };
    }

    const parts = ctx.args;
    if (parts.length < 2) {
      return {
        success: false,
        responseText: [
          `⚠️ *FORMAT KLAIM WALKOVER (WO):*`,
          `\`!claimwo <fixture_id> <nama_tim_yang_forfeit> [alasan]\``,
          ``,
          `Contoh:`,
          `\`!claimwo 1 Garuda FC Tidak hadir 10 menit setelah kick-off\``,
          `\`!claimwo 2 Elang FC Menolak bertindak sebagai host room\``,
          ``,
          `💡 _Tim yang disebutkan adalah tim yang kalah WO. Lawannya otomatis menang 3–0 (3 poin)._`,
        ].join('\n'),
      };
    }

    const fixtureInput = parts[0].trim();
    const forfeitingTeamInput = parts[1].trim();
    const reason = parts.slice(2).join(' ').trim() || 'Lawan tidak hadir / forfeit setelah batas toleransi';

    // Find fixture
    const fRes = await db.execute({
      sql: `
        SELECT f.id, f.tournament_id, f.stage, f.group_id, f.team_a_id, f.team_b_id, f.status,
               ta.team_name as team_a_name, tb.team_name as team_b_name, t.name as tournament_name
        FROM fixtures f
        JOIN teams ta ON f.team_a_id = ta.id
        JOIN teams tb ON f.team_b_id = tb.id
        JOIN tournaments t ON f.tournament_id = t.id
        WHERE f.id = ? OR f.id LIKE ? || '%'
        LIMIT 1
      `,
      args: [fixtureInput, fixtureInput],
    });

    if (fRes.rows.length === 0) {
      return {
        success: false,
        responseText: `⚠️ Pertandingan dengan ID atau prefix *"${fixtureInput}"* tidak ditemukan.`,
      };
    }

    const fixture = fRes.rows[0] as any;
    const fixtureId = String(fixture.id);
    const tournamentId = String(fixture.tournament_id);
    const tournamentName = String(fixture.tournament_name);
    const teamAId = String(fixture.team_a_id);
    const teamBId = String(fixture.team_b_id);
    const teamAName = String(fixture.team_a_name);
    const teamBName = String(fixture.team_b_name);

    if (fixture.status === 'COMPLETED') {
      return {
        success: false,
        responseText: `⚠️ Pertandingan *${teamAName} vs ${teamBName}* sudah berstatus SELESAI (COMPLETED). Tidak dapat di-WO.`,
      };
    }

    // Determine forfeiting team
    let forfeitingTeamId: string | null = null;
    let winningTeamName = '';
    let losingTeamName = '';

    const lowerInput = forfeitingTeamInput.toLowerCase();
    if (teamAName.toLowerCase().includes(lowerInput)) {
      forfeitingTeamId = teamAId;
      losingTeamName = teamAName;
      winningTeamName = teamBName;
    } else if (teamBName.toLowerCase().includes(lowerInput)) {
      forfeitingTeamId = teamBId;
      losingTeamName = teamBName;
      winningTeamName = teamAName;
    } else {
      return {
        success: false,
        responseText: `⚠️ Tim *"${forfeitingTeamInput}"* tidak cocok dengan tim peserta di pertandingan ini (*${teamAName}* vs *${teamBName}*).`,
      };
    }

    // Execute single forfeit
    const outcome = await handleSingleForfeit(db, fixtureId, forfeitingTeamId, reason);

    // Recalculate standings if group stage
    if (fixture.group_id) {
      await recalculateAndPersistGroupStandings(db, tournamentId, String(fixture.group_id));
    }

    const announcement = [
      `❌ *KEPUTUSAN KLAIM WALKOVER (WO)*`,
      `──────────────────────────────`,
      `🏆 *Turnamen:* ${tournamentName}`,
      `⚔️ *Pertandingan:* *${teamAName}* vs *${teamBName}*`,
      ``,
      `⚠️ *Tim Forfeit / Kalah WO:* ${losingTeamName}`,
      `🎉 *Pemenang WO:* *${winningTeamName}*`,
      `📊 *Skor Resmi:* ${outcome.score.team_a_score}–${outcome.score.team_b_score} (*3 Poin* untuk ${winningTeamName})`,
      `📝 *Alasan:* ${reason}`,
      `──────────────────────────────`,
      `📌 *Klasemen grup telah diperbarui secara otomatis.*`,
    ].join('\n');

    return {
      success: true,
      responseText: announcement,
    };
  };

  router.registerCommand({
    command: 'claimwo',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengesahkan klaim walkover (WO) 3-0 untuk tim lawan (Admin only)',
    handler: claimWoHandler,
  });

  router.registerCommand({
    command: 'klaimwo',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengesahkan klaim walkover (WO) 3-0 untuk tim lawan (Admin only)',
    handler: claimWoHandler,
  });

  router.registerCommand({
    command: 'wo',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengesahkan klaim walkover (WO) 3-0 untuk tim lawan (Admin only)',
    handler: claimWoHandler,
  });
}
