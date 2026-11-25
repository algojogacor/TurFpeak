/**
 * Flash Peak TMS - KO Roster Replacement & Interactive !ganti Service
 *
 * Manages:
 * 1. Manual organizer KO transfer window toggle (!bukaganti / !tutupganti)
 *    persisted in `tournaments.config_json.ko_transfer_open`.
 * 2. Eligibility & hard-lock checks:
 *    - Before a team plays Round 1 (no group matches started/reported/stats): allowed.
 *    - During KO transfer window (when ko_transfer_open === true): allowed ONLY for
 *      KO-qualified teams that have NOT yet started/reported/received WO in their
 *      first KO match (hard-locked per team; even organizer cannot force-unlock).
 * 3. Two-step reply-gated interactive !ganti session (WAIT_SLOT -> WAIT_NICKNAME):
 *    - Preserves historical group-stage stats/awards by archiving replaced players
 *      with `status = 'REPLACED'` (never DELETE, avoiding ON DELETE CASCADE).
 *    - Enforces Rule 2.7 (one player per tournament across teams) and 5+3 slots (1..8).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { recalculateAndPersistGroupStandings } from '../competition/standings.js';
import type { TournamentConfig } from '../shared/types/index.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import type { NormalizedMessage } from '../whatsapp/types.js';

export type RosterEditEligibility =
  | { allowed: true; phase: 'PRE_ROUND_1' | 'KO_WINDOW' }
  | {
      allowed: false;
      reason:
        | 'GROUP_PLAYED_WINDOW_CLOSED'
        | 'GROUP_NOT_FINISHED'
        | 'NOT_KO_QUALIFIER'
        | 'KO_ALREADY_STARTED';
      message: string;
    };

export interface TeamRosterSlotView {
  slot: number;
  position: 'GOALKEEPER' | 'OUTFIELD';
  rosterType: 'STARTER' | 'SUBSTITUTE';
  roleLabel: string;
  playerId: string | null;
  nicknameRaw: string | null;
}

export interface GantiSession {
  id: string;
  tournamentId: string;
  tournamentName: string;
  teamId: string;
  teamName: string;
  starterAddress: string;
  starterDelegateId: string | null;
  chatId: string;
  step: 'WAIT_SLOT' | 'WAIT_NICKNAME';
  selectedSlot?: number;
  slots: TeamRosterSlotView[];
  promptMessageKey: string;
  expiresAt: number;
}

const GANTI_SESSION_TTL_MS = 5 * 60 * 1000;
const PLAYED_STATUSES_SQL = `('IN_PROGRESS', 'REPORT_PENDING', 'DISPUTED', 'COMPLETED', 'WALKOVER')`;

function parseTournamentConfig(configJson: string | null | undefined): Partial<TournamentConfig> {
  if (!configJson) return {};
  try {
    return JSON.parse(configJson) as Partial<TournamentConfig>;
  } catch {
    return {};
  }
}

export async function getTournamentKoTransferOpen(
  db: Client,
  tournamentId: string
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT config_json FROM tournaments WHERE id = ? LIMIT 1`,
    args: [tournamentId],
  });
  if (res.rows.length === 0) return false;
  const cfg = parseTournamentConfig(String(res.rows[0].config_json ?? '{}'));
  return cfg.ko_transfer_open === true;
}

export async function setTournamentKoTransferOpen(
  db: Client,
  tournamentId: string,
  open: boolean,
  actorId: string
): Promise<{ changed: boolean; tournamentName: string }> {
  const res = await db.execute({
    sql: `SELECT name, config_json FROM tournaments WHERE id = ? LIMIT 1`,
    args: [tournamentId],
  });
  if (res.rows.length === 0) {
    throw new Error('Turnamen tidak ditemukan.');
  }
  const tournamentName = String(res.rows[0].name);
  const cfg = parseTournamentConfig(String(res.rows[0].config_json ?? '{}'));
  const previous = cfg.ko_transfer_open === true;
  cfg.ko_transfer_open = open;

  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE tournaments SET config_json = ?, updated_at = ? WHERE id = ?`,
    args: [JSON.stringify(cfg), now, tournamentId],
  });

  await db.execute({
    sql: `INSERT INTO audit_events (
            id, actor_type, actor_id, event_type, entity_type, entity_id,
            before_json, after_json, reason, correlation_id, created_at
          ) VALUES (?, 'ORGANIZER', ?, ?, 'TOURNAMENT', ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      actorId,
      open ? 'KO_TRANSFER_WINDOW_OPENED' : 'KO_TRANSFER_WINDOW_CLOSED',
      tournamentId,
      JSON.stringify({ ko_transfer_open: previous }),
      JSON.stringify({ ko_transfer_open: open }),
      open
        ? 'Organizer opened KO phase player replacement window (!bukaganti)'
        : 'Organizer closed KO phase player replacement window (!tutupganti)',
      randomUUID(),
      now,
    ],
  });

  return { changed: previous !== open, tournamentName };
}

/**
 * Determines whether a team is currently allowed to modify its roster via !ganti.
 */
export async function checkTeamCanModifyRoster(
  db: Client,
  tournamentId: string,
  teamId: string,
  teamName: string
): Promise<RosterEditEligibility> {
  // 1. Check if team has played any GROUP match or has any stats/reports at all
  const groupCheckRes = await db.execute({
    sql: `
      SELECT
        EXISTS(
          SELECT 1 FROM fixtures
          WHERE tournament_id = ? AND stage = 'GROUP'
            AND (team_a_id = ? OR team_b_id = ?)
            AND status IN ${PLAYED_STATUSES_SQL}
        ) AS has_group_fixture,
        EXISTS(
          SELECT 1 FROM games g
          JOIN fixtures f ON g.fixture_id = f.id
          WHERE f.tournament_id = ? AND f.stage = 'GROUP'
            AND (f.team_a_id = ? OR f.team_b_id = ?)
            AND g.status IN ${PLAYED_STATUSES_SQL}
        ) AS has_group_game,
        EXISTS(
          SELECT 1 FROM report_versions rv
          JOIN fixtures f ON rv.fixture_id = f.id
          WHERE f.tournament_id = ? AND f.stage = 'GROUP'
            AND (f.team_a_id = ? OR f.team_b_id = ?)
        ) AS has_group_report,
        EXISTS(
          SELECT 1 FROM player_game_stats WHERE team_id = ?
        ) AS has_player_stats,
        EXISTS(
          SELECT 1 FROM goalkeeper_reports WHERE team_id = ?
        ) AS has_gk_stats
    `,
    args: [
      tournamentId, teamId, teamId,
      tournamentId, teamId, teamId,
      tournamentId, teamId, teamId,
      teamId,
      teamId,
    ],
  });
  const gRow = groupCheckRes.rows[0] as unknown as Record<string, unknown>;
  const hasPlayedGroup =
    Number(gRow?.has_group_fixture ?? 0) > 0 ||
    Number(gRow?.has_group_game ?? 0) > 0 ||
    Number(gRow?.has_group_report ?? 0) > 0 ||
    Number(gRow?.has_player_stats ?? 0) > 0 ||
    Number(gRow?.has_gk_stats ?? 0) > 0;

  // Check if team has ANY KO activity (even if somehow group wasn't recorded)
  const koCheckRes = await db.execute({
    sql: `
      SELECT
        EXISTS(
          SELECT 1 FROM fixtures
          WHERE tournament_id = ? AND stage = 'KNOCKOUT'
            AND (team_a_id = ? OR team_b_id = ?)
            AND status IN ${PLAYED_STATUSES_SQL}
        ) AS has_ko_fixture,
        EXISTS(
          SELECT 1 FROM games g
          JOIN fixtures f ON g.fixture_id = f.id
          WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'
            AND (f.team_a_id = ? OR f.team_b_id = ?)
            AND g.status IN ${PLAYED_STATUSES_SQL}
        ) AS has_ko_game,
        EXISTS(
          SELECT 1 FROM report_versions rv
          JOIN fixtures f ON rv.fixture_id = f.id
          WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'
            AND (f.team_a_id = ? OR f.team_b_id = ?)
        ) AS has_ko_report,
        EXISTS(
          SELECT 1 FROM ko_game_evidence kge
          JOIN fixtures f ON kge.fixture_id = f.id
          WHERE f.tournament_id = ? AND (f.team_a_id = ? OR f.team_b_id = ?)
        ) AS has_ko_evidence
    `,
    args: [
      tournamentId, teamId, teamId,
      tournamentId, teamId, teamId,
      tournamentId, teamId, teamId,
      tournamentId, teamId, teamId,
    ],
  });
  const kRow = koCheckRes.rows[0] as unknown as Record<string, unknown>;
  const hasPlayedKo =
    Number(kRow?.has_ko_fixture ?? 0) > 0 ||
    Number(kRow?.has_ko_game ?? 0) > 0 ||
    Number(kRow?.has_ko_report ?? 0) > 0 ||
    Number(kRow?.has_ko_evidence ?? 0) > 0;

  // HARD LOCK: Once team has played/reported/received WO in KO, NEVER allow roster modification
  if (hasPlayedKo) {
    return {
      allowed: false,
      reason: 'KO_ALREADY_STARTED',
      message: [
        `🔒 *ROSTER KO TIM ${teamName.toUpperCase()} SUDAH TERKUNCI PERMANEN*`,
        `──────────────────────────────`,
        `Tim *${teamName}* sudah memainkan atau memiliki laporan pertandingan di fase Knockout.`,
        `Sesuai aturan turnamen, pergantian pemain tidak dapat dilakukan lagi (termasuk oleh Panitia).`,
      ].join('\n'),
    };
  }

  // Pre-Round 1: Team hasn't played any Group Stage match yet
  if (!hasPlayedGroup) {
    return { allowed: true, phase: 'PRE_ROUND_1' };
  }

  // Team has played Group Stage -> requires manual KO transfer window to be open
  const isKoWindowOpen = await getTournamentKoTransferOpen(db, tournamentId);
  if (!isKoWindowOpen) {
    return {
      allowed: false,
      reason: 'GROUP_PLAYED_WINDOW_CLOSED',
      message: [
        `🔒 *PERGANTIAN PEMAIN BELUM DIBUKA*`,
        `──────────────────────────────`,
        `Tim *${teamName}* sudah pernah bermain di Babak Grup, dan jendela transfer fase Knockout saat ini sedang *DITUTUP*.`,
        ``,
        `📌 Panitia dapat membuka jendela pergantian fase KO dengan *!bukaganti* setelah babak grup selesai.`,
      ].join('\n'),
    };
  }

  // Verify group stage is completed before KO transfer is allowed
  const unfinGroupRes = await db.execute({
    sql: `SELECT COUNT(*) as c FROM fixtures
          WHERE tournament_id = ? AND stage = 'GROUP'
            AND status NOT IN ('COMPLETED', 'WALKOVER', 'CANCELLED')`,
    args: [tournamentId],
  });
  if (Number(unfinGroupRes.rows[0]?.c ?? 0) > 0) {
    return {
      allowed: false,
      reason: 'GROUP_NOT_FINISHED',
      message: `⚠️ Pergantian pemain fase KO belum bisa dilakukan karena masih ada pertandingan Babak Grup yang belum selesai.`,
    };
  }

  // Verify team qualified for KO:
  // If KO fixtures already exist, team must be in a KO fixture; otherwise check top 2 in its group.
  const anyKoRes = await db.execute({
    sql: `SELECT COUNT(*) as c FROM fixtures WHERE tournament_id = ? AND stage = 'KNOCKOUT'`,
    args: [tournamentId],
  });
  if (Number(anyKoRes.rows[0]?.c ?? 0) > 0) {
    const teamKoRes = await db.execute({
      sql: `SELECT COUNT(*) as c FROM fixtures
            WHERE tournament_id = ? AND stage = 'KNOCKOUT' AND (team_a_id = ? OR team_b_id = ?)`,
      args: [tournamentId, teamId, teamId],
    });
    if (Number(teamKoRes.rows[0]?.c ?? 0) === 0) {
      return {
        allowed: false,
        reason: 'NOT_KO_QUALIFIER',
        message: `⚠️ Tim *${teamName}* tidak terdaftar sebagai peserta fase Knockout sehingga tidak dapat melakukan pergantian pemain KO.`,
      };
    }
  } else {
    // KO bracket not drawn yet: check group standings top 2
    const gmRes = await db.execute({
      sql: `SELECT gm.group_id
            FROM group_members gm
            JOIN groups g ON gm.group_id = g.id
            JOIN group_draws gd ON g.draw_id = gd.id
            WHERE gd.tournament_id = ? AND gm.team_id = ?
            LIMIT 1`,
      args: [tournamentId, teamId],
    });
    if (gmRes.rows.length > 0) {
      const groupId = String(gmRes.rows[0].group_id);
      const standings = await recalculateAndPersistGroupStandings(db, tournamentId, groupId);
      const rankIdx = standings.findIndex((s) => s.team_id === teamId);
      if (rankIdx < 0 || rankIdx >= 2) {
        return {
          allowed: false,
          reason: 'NOT_KO_QUALIFIER',
          message: `⚠️ Tim *${teamName}* berada di luar 2 besar klasemen grup dan tidak lolos ke fase Knockout.`,
        };
      }
    }
  }

  return { allowed: true, phase: 'KO_WINDOW' };
}

export async function getTeamRosterSlots(
  db: Client,
  tournamentId: string,
  teamId: string
): Promise<TeamRosterSlotView[]> {
  const playersRes = await db.execute({
    sql: `SELECT id, nickname_raw, position, roster_slot, roster_type
          FROM players
          WHERE team_id = ? AND tournament_id = ? AND status = 'ACTIVE'
          ORDER BY roster_slot ASC`,
    args: [teamId, tournamentId],
  });

  const bySlot = new Map<number, { id: string; nickname: string }>();
  for (const r of playersRes.rows as any[]) {
    bySlot.set(Number(r.roster_slot), {
      id: String(r.id),
      nickname: String(r.nickname_raw),
    });
  }

  const slots: TeamRosterSlotView[] = [];
  for (let slot = 1; slot <= 8; slot++) {
    const isGk = slot === 1;
    const isStarter = slot <= 5;
    const existing = bySlot.get(slot);
    slots.push({
      slot,
      position: isGk ? 'GOALKEEPER' : 'OUTFIELD',
      rosterType: isStarter ? 'STARTER' : 'SUBSTITUTE',
      roleLabel: isGk ? 'Kiper (GK)' : isStarter ? 'Inti' : 'Cadangan',
      playerId: existing?.id ?? null,
      nicknameRaw: existing?.nickname ?? null,
    });
  }
  return slots;
}

export function formatGantiSlotListPrompt(
  teamName: string,
  phase: 'PRE_ROUND_1' | 'KO_WINDOW',
  slots: TeamRosterSlotView[]
): string {
  const phaseTag = phase === 'KO_WINDOW' ? 'Jendela Transfer KO' : 'Pra-Round 1';
  const lines: string[] = [
    `🔄 *GANTI PEMAIN — ${teamName.toUpperCase()}* (${phaseTag})`,
    `──────────────────────────────`,
  ];

  for (const s of slots) {
    const nameLabel = s.nicknameRaw ? `*${s.nicknameRaw}*` : `_(Kosong - Tambah ${s.roleLabel})_`;
    lines.push(`*${s.slot}.* [${s.roleLabel}] ${nameLabel}`);
  }

  lines.push(`──────────────────────────────`);
  lines.push(`💬 *Balas (reply) pesan ini* dengan *angka slot (1–8)* yang ingin diganti/diisi.`);
  lines.push(`_(Balas \`batal\` untuk membatalkan)_`);
  return lines.join('\n');
}

export class GantiSessionManager {
  private sessionsByPromptKey = new Map<string, GantiSession>();

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, session] of this.sessionsByPromptKey.entries()) {
      if (session.expiresAt <= now) {
        this.sessionsByPromptKey.delete(key);
      }
    }
  }

  public registerSession(session: GantiSession): void {
    this.cleanupExpired();
    // Remove any older active session by the same starter in the same chat so only latest prompt is active
    for (const [k, s] of this.sessionsByPromptKey.entries()) {
      if (s.chatId === session.chatId && s.starterAddress === session.starterAddress) {
        this.sessionsByPromptKey.delete(k);
      }
    }
    this.sessionsByPromptKey.set(session.promptMessageKey, session);
  }

  public findMatchingSession(message: NormalizedMessage): GantiSession | null {
    this.cleanupExpired();
    if (!message.reply_to_key) return null;
    const session = this.sessionsByPromptKey.get(message.reply_to_key);
    if (!session) return null;
    if (session.chatId !== message.chat_id) return null;

    const senderAddr = message.sender_normalized_address || message.sender_raw_address;
    if (session.starterAddress !== senderAddr) {
      return null;
    }
    return session;
  }

  public async handleReply(
    db: Client,
    message: NormalizedMessage,
    sender?: WhatsAppSender | null
  ): Promise<{ handled: boolean; replyText?: string; promptMessageKey?: string }> {
    const session = this.findMatchingSession(message);
    if (!session) return { handled: false };

    const input = (message.text_body || message.caption || '').trim();
    const lower = input.toLowerCase();

    if (lower === 'batal' || lower === 'cancel') {
      this.sessionsByPromptKey.delete(session.promptMessageKey);
      return {
        handled: true,
        replyText: `❌ Proses pergantian pemain untuk *${session.teamName}* dibatalkan.`,
      };
    }

    if (session.step === 'WAIT_SLOT') {
      const parsedNum = Number.parseInt(input, 10);
      if (!/^\d+$/.test(input) || Number.isNaN(parsedNum) || parsedNum < 1 || parsedNum > 8) {
        return {
          handled: true,
          replyText: `⚠️ Pilihan tidak valid. *Balas (reply) pesan daftar di atas* dengan angka *1* sampai *8* (atau ketik \`batal\`).`,
        };
      }

      const targetSlot = session.slots.find((s) => s.slot === parsedNum)!;
      if (!targetSlot.playerId && parsedNum <= 5) {
        return {
          handled: true,
          replyText: `⚠️ Slot ${parsedNum} (${targetSlot.roleLabel}) masih kosong. Silakan lengkapi roster awal dengan *!roster* terlebih dahulu, atau pilih slot lain.`,
        };
      }

      const oldLabel = targetSlot.nicknameRaw ? `*${targetSlot.nicknameRaw}*` : `_(Slot Kosong)_`;
      const nextPromptText = [
        `✏️ *SLOT ${parsedNum} (${targetSlot.roleLabel}) — ${session.teamName.toUpperCase()}*`,
        `Pemain saat ini: ${oldLabel}`,
        ``,
        `💬 *Balas (reply) pesan ini* dengan *nickname in-game pemain baru* penggantinya.`,
        `_(Harus sama persis dengan nickname di game. Balas \`batal\` untuk batal)_`,
      ].join('\n');

      // Rotate prompt key to the new bot message
      this.sessionsByPromptKey.delete(session.promptMessageKey);
      let newPromptKey = `ganti-nick-${randomUUID()}`;
      if (sender) {
        newPromptKey = message.raw_message
          ? await sender.sendQuote(message.chat_id, nextPromptText, message.raw_message)
          : await sender.sendText(message.chat_id, nextPromptText);
      }

      this.sessionsByPromptKey.set(newPromptKey, {
        ...session,
        step: 'WAIT_NICKNAME',
        selectedSlot: parsedNum,
        promptMessageKey: newPromptKey,
        expiresAt: Date.now() + GANTI_SESSION_TTL_MS,
      });

      return sender
        ? { handled: true, promptMessageKey: newPromptKey }
        : { handled: true, replyText: nextPromptText, promptMessageKey: newPromptKey };
    }

    // step === 'WAIT_NICKNAME'
    const slotNum = session.selectedSlot!;
    const targetSlot = session.slots.find((s) => s.slot === slotNum)!;

    if (!input || input.startsWith('!') || input.length > 50) {
      return {
        handled: true,
        replyText: `⚠️ Nickname tidak valid (kosong, diawali \`!\`, atau lebih dari 50 karakter). *Balas pesan pertanyaan nickname* dengan nama pemain yang benar, atau \`batal\`.`,
      };
    }

    // Re-verify eligibility at commit time (prevents race condition if KO match started mid-flow)
    const eligibility = await checkTeamCanModifyRoster(
      db,
      session.tournamentId,
      session.teamId,
      session.teamName
    );
    if (!eligibility.allowed) {
      this.sessionsByPromptKey.delete(session.promptMessageKey);
      return {
        handled: true,
        replyText: eligibility.message,
      };
    }

    const newRaw = input;
    const newNfc = newRaw.normalize('NFC');
    const newSearchKey = newRaw.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check Rule 2.7 & same-team duplicate via NFC / case-insensitive check
    const existingRes = await db.execute({
      sql: `SELECT p.id, p.team_id, p.roster_slot, p.status, p.nickname_raw, t.team_name
            FROM players p
            JOIN teams t ON p.team_id = t.id
            WHERE p.tournament_id = ?
              AND (p.nickname_nfc = ? OR LOWER(p.nickname_raw) = LOWER(?))
            LIMIT 1`,
      args: [session.tournamentId, newNfc, newRaw],
    });

    let reactivatePlayerId: string | null = null;
    if (existingRes.rows.length > 0) {
      const ex = existingRes.rows[0] as unknown as Record<string, unknown>;
      const exTeamId = String(ex.team_id);
      const exTeamName = String(ex.team_name);
      const exStatus = String(ex.status);
      const exSlot = Number(ex.roster_slot);

      if (exTeamId !== session.teamId) {
        return {
          handled: true,
          replyText: `⚠️ Pemain *"${newRaw}"* sudah terdaftar di tim *${exTeamName}*. Sesuai Pasal 2.7, pemain tidak boleh membela lebih dari 1 tim dalam turnamen. Balas dengan nickname pemain lain atau \`batal\`.`,
        };
      }

      if (exStatus === 'ACTIVE') {
        if (exSlot === slotNum) {
          this.sessionsByPromptKey.delete(session.promptMessageKey);
          return {
            handled: true,
            replyText: `ℹ️ Slot ${slotNum} sudah berisi pemain *${String(ex.nickname_raw)}*. Tidak ada perubahan dilakukan.`,
          };
        }
        return {
          handled: true,
          replyText: `⚠️ Pemain *"${newRaw}"* sudah terdaftar di Slot ${exSlot} tim Anda sendiri. Pilih pemain lain atau \`batal\`.`,
        };
      }

      if (exStatus === 'INELIGIBLE' || exStatus === 'SUSPENDED') {
        return {
          handled: true,
          replyText: `⚠️ Pemain *"${newRaw}"* berstatus ${exStatus} di turnamen ini dan tidak dapat didaftarkan kembali. Balas dengan nickname lain atau \`batal\`.`,
        };
      }

      // exStatus === 'REPLACED' on the SAME team -> allow re-activating their original row!
      reactivatePlayerId = String(ex.id);
    }

    const now = new Date().toISOString();
    const tx = await db.transaction('write');
    try {
      // 1. Archive current active player in this slot (if any) without deleting stats
      if (targetSlot.playerId) {
        await tx.execute({
          sql: `UPDATE players SET status = 'REPLACED', updated_at = ? WHERE id = ?`,
          args: [now, targetSlot.playerId],
        });
      }

      // 2. Reactivate replaced player of the same team OR insert brand new player
      let newPlayerId: string;
      if (reactivatePlayerId) {
        newPlayerId = reactivatePlayerId;
        await tx.execute({
          sql: `UPDATE players
                SET status = 'ACTIVE',
                    roster_slot = ?,
                    roster_type = ?,
                    position = ?,
                    nickname_raw = ?,
                    nickname_nfc = ?,
                    nickname_search_key = ?,
                    updated_at = ?
                WHERE id = ?`,
          args: [
            slotNum,
            targetSlot.rosterType,
            targetSlot.position,
            newRaw,
            newNfc,
            newSearchKey,
            now,
            reactivatePlayerId,
          ],
        });
      } else {
        newPlayerId = randomUUID();
        await tx.execute({
          sql: `INSERT INTO players (
                  id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key,
                  position, roster_slot, roster_type, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          args: [
            newPlayerId,
            session.tournamentId,
            session.teamId,
            newRaw,
            newNfc,
            newSearchKey,
            targetSlot.position,
            slotNum,
            targetSlot.rosterType,
            now,
            now,
          ],
        });
      }

      // 3. Audit trail
      await tx.execute({
        sql: `INSERT INTO audit_events (
                id, actor_type, actor_id, event_type, entity_type, entity_id,
                before_json, after_json, reason, correlation_id, created_at
              ) VALUES (?, ?, ?, 'ROSTER_PLAYER_REPLACED', 'TEAM', ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          session.starterDelegateId ? 'DELEGATE' : 'ORGANIZER',
          session.starterDelegateId || session.starterAddress || 'ORGANIZER',
          session.teamId,
          JSON.stringify({
            slot: slotNum,
            player_id: targetSlot.playerId,
            nickname: targetSlot.nicknameRaw,
          }),
          JSON.stringify({
            slot: slotNum,
            player_id: newPlayerId,
            nickname: newRaw,
            phase: eligibility.phase,
            reactivated: Boolean(reactivatePlayerId),
          }),
          `Roster replacement via !ganti (${eligibility.phase})`,
          randomUUID(),
          now,
        ],
      });

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    this.sessionsByPromptKey.delete(session.promptMessageKey);

    const actionText = targetSlot.nicknameRaw
      ? `*${targetSlot.nicknameRaw}* ➡️ *${newRaw}*`
      : `Slot Kosong ➡️ *${newRaw}*`;

    return {
      handled: true,
      replyText: [
        `✅ *PERGANTIAN PEMAIN BERHASIL!*`,
        `──────────────────────────────`,
        `🛡️ *Tim:* ${session.teamName}`,
        `📌 *Slot ${slotNum} (${targetSlot.roleLabel}):* ${actionText}`,
        `──────────────────────────────`,
        `💡 _Statistik babak grup pemain sebelumnya tetap tersimpan di klasemen awards. Ketik *!ganti* lagi jika masih ada pemain lain yang ingin diganti, atau *!roster ${session.teamName}* untuk cek susunan terbaru._`,
      ].join('\n'),
    };
  }
}
