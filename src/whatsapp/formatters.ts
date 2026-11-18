/**
 * Flash Peak TMS - WhatsApp Response & Message Formatters (Task 6.3)
 * 
 * Formats match reports, standings tables, progressive draw reveals,
 * and individual awards per PROMPT_CATALOG.md §8 and COMPETITION_RULES.
 * 
 * Guarantees:
 * - Explicit status tags: [DRAFT], [NEEDS CORRECTION], [PENDING APPROVAL], [OFFICIAL].
 * - Never claims a result is official until fully approved and locked.
 * - Uncertain values labeled as "Perlu konfirmasi", never guessed numbers.
 * - Monospaced standings table for clean alignment on WhatsApp mobile/desktop.
 */

import type { StandingWithTeamName } from '../competition/standings.js';
import type { TournamentAwardsSummary, AwardDetail } from '../stats/awards.js';
import type { ApproverType } from '../shared/types/index.js';

export type ReportDisplayStatus =
  | 'DRAFT'
  | 'NEEDS_CORRECTION'
  | 'PENDING_APPROVAL'
  | 'OFFICIAL';

export interface PlayerStatDisplayItem {
  ordinal: number;
  nickname: string;
  rating?: number | null;
  goals: number | string | null;
  assists: number | string | null;
  passes?: number | string | null;
  defense?: number | string | null;
  saves?: number | string | null;
  isGoalkeeper?: boolean;
}

export interface MatchReportSummaryParams {
  status: ReportDisplayStatus;
  versionNumber: number;
  fixtureCode?: string;
  stageName?: string;
  teamAName: string;
  teamBName: string;
  teamAScore: number | string | null;
  teamBScore: number | string | null;
  teamAPlayers: PlayerStatDisplayItem[];
  teamBPlayers: PlayerStatDisplayItem[];
  uncertainties?: string[];
  pendingApprovers?: ApproverType[];
  rejectionReason?: string;
}

/**
 * Formats a match report summary message for WhatsApp.
 */
export function formatMatchReportSummary(params: MatchReportSummaryParams): string {
  const {
    status,
    versionNumber,
    fixtureCode,
    stageName,
    teamAName,
    teamBName,
    teamAScore,
    teamBScore,
    teamAPlayers,
    teamBPlayers,
    uncertainties = [],
    pendingApprovers = [],
    rejectionReason,
  } = params;

  const lines: string[] = [];

  // Header with explicit status tag (PROMPT_CATALOG.md §8: DRAFT / NEEDS CORRECTION / PENDING APPROVAL / OFFICIAL)
  const displayStatus = status.replace(/_/g, ' ');
  const statusTag = `[${displayStatus}]`;
  const stageHeader = stageName ? ` • ${stageName}` : '';
  const fixtureHeader = fixtureCode ? ` (${fixtureCode})` : '';
  lines.push(`⚽ *LAPORAN PERTANDINGAN* ${statusTag}${fixtureHeader}${stageHeader}`);
  lines.push(`_Versi ${versionNumber}_`);
  lines.push('');

  // Match Score
  const scoreAStr = formatMetricValue(teamAScore);
  const scoreBStr = formatMetricValue(teamBScore);
  lines.push(`*${teamAName}*  ${scoreAStr} - ${scoreBStr}  *${teamBName}*`);
  lines.push('');

  // Team A Player Details
  lines.push(`📋 *Statistik ${teamAName}:*`);
  if (teamAPlayers.length === 0) {
    lines.push('  _(Belum ada data pemain)_');
  } else {
    for (const p of teamAPlayers) {
      lines.push(formatPlayerLine(p));
    }
  }
  lines.push('');

  // Team B Player Details
  lines.push(`📋 *Statistik ${teamBName}:*`);
  if (teamBPlayers.length === 0) {
    lines.push('  _(Belum ada data pemain)_');
  } else {
    for (const p of teamBPlayers) {
      lines.push(formatPlayerLine(p));
    }
  }
  lines.push('');

  // Uncertainties or warnings
  if (uncertainties.length > 0) {
    lines.push('⚠️ *Perhatian / Perlu Konfirmasi:*');
    for (const u of uncertainties) {
      lines.push(`• ${u}`);
    }
    lines.push('');
  }

  // Rejection reason if any
  if (status === 'NEEDS_CORRECTION' && rejectionReason) {
    lines.push(`❌ *Catatan Koreksi / Penolakan:* ${rejectionReason}`);
    lines.push('');
  }

  // Action instructions based on status
  lines.push('──────────────────────────────');
  if (status === 'DRAFT' || status === 'NEEDS_CORRECTION') {
    lines.push('💬 *Aksi Koreksi:*');
    lines.push(
      'Jika terdapat data yang salah, balas pesan ini dengan koreksi natural language.'
    );
    lines.push(
      '_Contoh:_ "player urutan 2 tim B salah di gol, seharusnya 2 bukan 1"'
    );
  } else if (status === 'PENDING_APPROVAL') {
    lines.push('✍️ *Menunggu Persetujuan:*');
    if (pendingApprovers.length > 0) {
      const names = pendingApprovers
        .map((a) => {
          if (a === 'TEAM_A') return `Delegasi ${teamAName}`;
          if (a === 'TEAM_B') return `Delegasi ${teamBName}`;
          return 'Organizer';
        })
        .join(', ');
      lines.push(`Menunggu: *${names}*`);
    }
    lines.push('Ketik *!approve* untuk menyetujui laporan pertandingan ini.');
  } else if (status === 'OFFICIAL') {
    lines.push('🔒 *Hasil Resmi Terkunci (OFFICIAL)*');
    lines.push(
      'Laporan telah disetujui ketiga pihak (Delegasi A, Delegasi B, Organizer). Statistik dan klasemen telah diperbarui.'
    );
  }

  return lines.join('\n');
}

function formatMetricValue(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === 'Perlu konfirmasi') {
    return 'Perlu konfirmasi';
  }
  return String(val);
}

function formatPlayerLine(p: PlayerStatDisplayItem): string {
  const parts: string[] = [];
  parts.push(`${p.ordinal}. *${p.nickname}*`);

  const statItems: string[] = [];
  if (p.goals !== null && p.goals !== undefined) {
    statItems.push(`Gol: ${formatMetricValue(p.goals)}`);
  }
  if (p.assists !== null && p.assists !== undefined) {
    statItems.push(`Ast: ${formatMetricValue(p.assists)}`);
  }
  if (p.passes !== null && p.passes !== undefined) {
    statItems.push(`Pass: ${formatMetricValue(p.passes)}`);
  }
  if (p.defense !== null && p.defense !== undefined) {
    statItems.push(`Def: ${formatMetricValue(p.defense)}`);
  }
  if (p.saves !== null && p.saves !== undefined) {
    statItems.push(`Saves: ${formatMetricValue(p.saves)}`);
  }
  if (p.rating !== null && p.rating !== undefined) {
    statItems.push(`Rating: ${p.rating.toFixed(1)}`);
  }

  if (statItems.length > 0) {
    parts.push(`(${statItems.join(', ')})`);
  }

  return `  ${parts.join(' ')}`;
}

/**
 * Formats group standings table cleanly with WhatsApp monospaced block (``` ... ```).
 */
export function formatStandingsTable(
  groupCode: string,
  standings: StandingWithTeamName[]
): string {
  const lines: string[] = [];
  lines.push(`📊 *KLASEMEN GRUP ${groupCode.toUpperCase()}*`);
  lines.push('```');
  lines.push('POS TIM            P  W  D  L  GF GA  GD PTS');
  lines.push('─── ────────────── ── ── ── ── ── ── ─── ───');

  for (const s of standings) {
    const pos = String(s.rank).padEnd(3);
    const rawName = s.team_name || s.team_id;
    const name = rawName.length > 14 ? rawName.slice(0, 13) + '…' : rawName.padEnd(14);
    const p = String(s.played).padStart(2);
    const w = String(s.wins).padStart(2);
    const d = String(s.draws).padStart(2);
    const l = String(s.losses).padStart(2);
    const gf = String(s.goals_for).padStart(2);
    const ga = String(s.goals_against).padStart(2);
    const gdNum = s.goal_difference;
    const gdStr = (gdNum >= 0 ? `+${gdNum}` : `${gdNum}`).padStart(3);
    const pts = String(s.points).padStart(3);

    lines.push(`${pos} ${name} ${p} ${w} ${d} ${l} ${gf} ${ga} ${gdStr} ${pts}`);
  }

  lines.push('```');
  lines.push('_Keterangan: Top 2 tim lolos ke Babak Knockout._');
  return lines.join('\n');
}

export interface DrawRevealStepParams {
  tournamentTitle: string;
  stepIndex: number;
  totalSteps: number;
  teamName: string;
  groupCode: string;
  seedReveal?: string;
  commitmentHash?: string;
}

/**
 * Formats a progressive draw reveal message for WhatsApp.
 */
export function formatDrawRevealStep(params: DrawRevealStepParams): string {
  const {
    tournamentTitle,
    stepIndex,
    totalSteps,
    teamName,
    groupCode,
    seedReveal,
  } = params;

  const lines: string[] = [];
  lines.push(`🎲 *PENGUNDIAN GRUP — ${tournamentTitle.toUpperCase()}*`);
  lines.push(`_Undian ke-${stepIndex} dari ${totalSteps}_`);
  lines.push('');
  lines.push(`➡️ Tim: *${teamName}*`);
  lines.push(`🎯 Masuk ke: *GRUP ${groupCode.toUpperCase()}*`);
  lines.push('');

  if (seedReveal) {
    lines.push(`🔒 _Seed Verifikasi: ${seedReveal.slice(0, 16)}..._`);
  }

  return lines.join('\n');
}

export interface CompletedDrawGroup {
  groupCode: string;
  teams: { teamId: string; teamName: string }[];
}

/**
 * Formats a completed group draw announcement for WhatsApp.
 */
export function formatDrawCompletedSummary(
  tournamentTitle: string,
  groups: CompletedDrawGroup[],
  commitmentHash?: string
): string {
  const lines: string[] = [];
  lines.push(`🎉 *HASIL LENGKAP PENGUNDIAN GRUP*`);
  lines.push(`🏆 *${tournamentTitle}*`);
  lines.push('──────────────────────────────');

  for (const g of groups) {
    lines.push('');
    lines.push(`📌 *GRUP ${g.groupCode.toUpperCase()}*`);
    g.teams.forEach((t, idx) => {
      lines.push(`  ${idx + 1}. ${t.teamName}`);
    });
  }

  lines.push('');
  lines.push('──────────────────────────────');
  if (commitmentHash) {
    lines.push(`🔐 *Commitment Hash:* \`${commitmentHash}\``);
  }
  lines.push('Jadwal pertandingan akan segera diumumkan. Selamat bertanding!');

  return lines.join('\n');
}

/**
 * Formats tournament awards announcement for WhatsApp.
 */
export function formatAwardsAnnouncement(
  tournamentTitle: string,
  awards: TournamentAwardsSummary
): string {
  const lines: string[] = [];
  lines.push(`🏆 *PENGHARGAAN INDIVIDU — ${tournamentTitle.toUpperCase()}* 🏆`);
  lines.push('_Berdasarkan hasil resmi pertandingan terkunci_');
  lines.push('──────────────────────────────');
  lines.push('');

  // 1. Golden Boot
  lines.push(formatAwardSection('🥇 *GOLDEN BOOT* (Pencetak Gol Terbanyak)', awards.goldenBoot, 'Gol'));
  lines.push('');

  // 2. Top Assist
  lines.push(formatAwardSection('🎯 *TOP ASSIST* (Pemberi Assist Terbanyak)', awards.topAssist, 'Assist'));
  lines.push('');

  // 3. Best Defender
  lines.push(formatAwardSection('🛡️ *BEST DEFENDER* (Pemain Bertahan Terbaik)', awards.bestDefender, 'Defense'));
  lines.push('');

  // 4. Best Winning Goalkeeper
  lines.push(
    formatAwardSection(
      '🧤 *BEST WINNING GOALKEEPER* (Kiper Terbaik Laga Menang)',
      awards.bestWinningGoalkeeper,
      'Saves'
    )
  );

  lines.push('');
  lines.push('──────────────────────────────');
  lines.push('Selamat kepada para pemenang atas performa luar biasa sepanjang turnamen! 👏⚽');

  return lines.join('\n');
}

function formatAwardSection(header: string, award: AwardDetail, metricUnit: string): string {
  const lines: string[] = [header];

  if (award.winners.length === 0) {
    lines.push('  _(Belum ada pemenang yang memenuhi syarat)_');
    return lines.join('\n');
  }

  if (award.isTie) {
    lines.push(`  🤝 *Pemenang Bersama (Co-Winners) — ${award.winners[0].metricValue} ${metricUnit}:*`);
    for (const w of award.winners) {
      lines.push(`  • *${w.nicknameRaw}* (${w.teamName}) — ${w.gamesPlayed} laga`);
    }
  } else {
    const w = award.winners[0];
    lines.push(`  👑 *${w.nicknameRaw}* (${w.teamName})`);
    lines.push(`  Total: *${w.metricValue} ${metricUnit}* (${w.gamesPlayed} laga dimainkan)`);
  }

  if (award.isOverride) {
    lines.push('  _(Keputusan khusus dari Penyelenggara / Organizer Override)_');
  } else if (award.notes) {
    lines.push(`  _Catatan: ${award.notes}_`);
  }

  return lines.join('\n');
}
