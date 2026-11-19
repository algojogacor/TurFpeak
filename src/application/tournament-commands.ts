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

  // !schedule / !jadwal
  const scheduleHandler = async () => {
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

  router.registerCommand({
    command: 'confirm',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengonfirmasi draf laporan pertandingan manual (Admin only)',
    handler: confirmHandler,
  });

  router.registerCommand({
    command: 'ok',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
    description: 'Mengonfirmasi draf laporan pertandingan manual (Admin only)',
    handler: confirmHandler,
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
}
