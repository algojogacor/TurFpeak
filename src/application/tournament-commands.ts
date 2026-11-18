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
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type { CommandRouter } from '../whatsapp/router.js';
import type { CommandContext } from '../whatsapp/types.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import type { IdentityResolver } from '../identity/resolver.js';
import type { OnboardingService } from '../identity/onboarding.js';
import { createTournament } from '../competition/tournament.js';
import { prepareDraw, revealNext } from '../competition/draw.js';
import { generateGroupStageFixtures } from '../competition/fixtures.js';
import { calculateTournamentAwards } from '../stats/awards.js';
import {
  formatAwardsAnnouncement,
  formatDrawCompletedSummary,
  formatDrawRevealStep,
  formatFixturesSchedule,
  type CompletedDrawGroup,
  type FixtureScheduleDisplayItem,
} from '../whatsapp/formatters.js';
import type {
  ApproverType,
  ApprovalDecision,
  DrawResultGroupAssignment,
  ReportVersion,
  UUID,
} from '../shared/types/index.js';
import type { ApprovalOutcome } from '../reports/approval.js';

export interface TournamentCommandDeps {
  db: Client;
  identityResolver: IdentityResolver;
  onboardingService: OnboardingService;
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
    command: '!standings',
    requiredRole: 'ANY',
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
    command: '!awards',
    requiredRole: 'ANY',
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
    command: '!approve',
    requiredRole: 'DELEGATE',
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
    command: '!draw',
    requiredRole: 'ORGANIZER',
    allowedInDm: true,
    allowedInGroup: true,
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

        if (deps.sender) {
          await deps.sender.sendText(ctx.message.chat_id, scheduleMsg);
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
    description: 'Mendaftarkan tim baru ke turnamen',
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
    description: 'Memulai verifikasi delegasi resmi tim secara bertahap di grup',
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
}
