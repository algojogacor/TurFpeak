/**
 * Flash Peak TMS - Omak Peak Application Service (AI-native expansion, D-037)
 *
 * Implements the !ai command (read-only chat with the Omak Peak persona) and
 * the engagement commentary hooks used by other modules (standings commentary,
 * match-lock hype recap, champion celebration) — all grounded in real DB data.
 *
 * !ai behavior (per task brief 2026-11-22):
 * - Open-scope: any question is allowed; the only hard limits are read-only
 *   guarantee, safety, and operational-data secrecy.
 * - Rate limit: rolling window, max 2 uses per user per 60 seconds. Rejects
 *   with a clear Omak-Peak-voiced message stating when to retry.
 * - Persona: "Omak Peak" — already publicly introduced by Arya (organizer) on
 *   2026-11-21. Santai, confident, occasionally Flash-Peak-flavored.
 * - First-use / no-arg invocation: returns a short intro so the persona is
 *   discoverable without a state write (read-only invariant preserved).
 *
 * Engagement commentary (D-040): buildHypeRecap / buildStandingsCommentary /
 * buildChampionCelebration take FACTS from the DB (score margins, streaks,
 * standings movement) and let AI format the presentation. The AI never invents
 * facts — only rephrases. If AI is unavailable, the engagement message is
 * skipped silently (non-critical).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type { ProviderRouter } from '../ai/router.js';
import { AllProvidersFailedError } from '../ai/router.js';
import { AIError } from '../ai/adapter.js';
import { buildOmakPeakPrompt } from '../ai/prompts/omak-peak.js';
import type { OmakPeakContext } from '../ai/prompts/omak-peak-context.js';

// =============================================================================
// Rolling-window rate limiter (in-memory; restart resets are acceptable for
// short abuse windows). 2 uses per 60s per sender per the task brief.
// =============================================================================

export class RollingRateLimiter {
  private uses = new Map<string, number[]>();
  constructor(
    private readonly maxUses: number,
    private readonly windowMs: number
  ) {}

  /**
   * Returns {allowed: true} if the caller may proceed, or {allowed: false,
   * retryAfterMs} with the milliseconds until the oldest in-window use expires.
   * On allow, records the use timestamp.
   */
  check(sender: string, now: number = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const arr = (this.uses.get(sender) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.maxUses) {
      const oldest = arr[0];
      const retryAfterMs = Math.max(1000, this.windowMs - (now - oldest));
      return { allowed: false, retryAfterMs: Math.ceil(retryAfterMs / 1000) * 1000 };
    }
    arr.push(now);
    this.uses.set(sender, arr);
    return { allowed: true };
  }

  /** Test helper: reset a sender's history. */
  reset(sender: string): void {
    this.uses.delete(sender);
  }
}

// =============================================================================
// Omak Peak service
// =============================================================================

export interface OmakPeakDeps {
  db: Client;
  providerRouter?: ProviderRouter;
  /** Injected for tests; defaults to a real RollingRateLimiter in production. */
  rateLimiter?: RollingRateLimiter;
}

export const OMAK_PEAK_INTRO = `👋 *Omak Peak here.*\n\nAku asisten otomatis turnamen Flash Peak (Gojiha Tournament) di grup ini. Bisa ditanya apa aja — jadwal, hasil, klasemen, aturan, atau sekadar ngobrol soal Flash Peak. Aku read-only: nggak bisa ubah apa pun di sistem, bukan itu peranku. Kalau lo butuh aksi (ubah hasil, reopen, dll), ke Panitia Arya langsung.\n\nCaranya: ketik *!ai <pertanyaan>*. Contoh:\n• *!ai siapa lawan tim aku besok?*\n• *!ai gimana aturan WO?*\n• *!ai skill Homer apa?*\n\n_2x per menit per user, ya — biar adil buat semua._`;

export class OmakPeakService {
  private readonly rateLimiter: RollingRateLimiter;

  constructor(private readonly deps: OmakPeakDeps) {
    this.rateLimiter = deps.rateLimiter ?? new RollingRateLimiter(2, 60_000);
  }

  /**
   * Handles the !ai command.
   * Returns the reply text (and optional metadata). Never throws — AI failures
   * surface as a friendly Omak-Peak-voiced fallback message.
   */
  async handleAiCommand(
    senderRawAddress: string,
    userMessage: string
  ): Promise<{ replyText: string; rateLimited: boolean; retryAfterSeconds?: number }> {
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return { replyText: OMAK_PEAK_INTRO, rateLimited: false };
    }

    const gate = this.rateLimiter.check(senderRawAddress);
    if (!gate.allowed) {
      const secs = Math.ceil(gate.retryAfterMs / 1000);
      return {
        replyText:
          `⏳ Sabar ya, Omak Peak lagi cooldown. Kamu baru aja nanya dua kali berturut-turut — ` +
          `coba lagi dalam *${secs} detik* biar quota-nya balik. (Batas: 2x per menit per user.)`,
        rateLimited: true,
        retryAfterSeconds: secs,
      };
    }

    if (!this.deps.providerRouter) {
      return {
        replyText:
          '⚠️ Maaf, aku lagi nggak bisa nyambung ke AI provider-ku. Coba sebentar lagi, atau tanya Panitia Arya langsung soal hal yang urgent.',
        rateLimited: false,
      };
    }

    let context: OmakPeakContext;
    try {
      context = await buildOmakPeakContext(this.deps.db);
    } catch {
      // Context build failure is non-fatal: proceed with an empty context so the
      // user still gets a response (the AI will hedge about tournament specifics).
      context = {
        today_fixtures: [],
        standings_by_group: [],
        teams_and_delegates: [],
        qna_entries: [],
        rules_summary: '(konteks turnamen gagal dimuat — jawaban turnamen mungkin terbatas)',
      };
    }

    const { system_prompt, prompt } = buildOmakPeakPrompt(context, trimmed);

    try {
      const response = await this.deps.providerRouter.execute<string>({
        task: 'CHAT_OMAK_PEAK',
        system_prompt,
        prompt,
        temperature: 0.7,
        timeout_ms: 30_000,
        correlation_id: `omak-peak-${randomUUID().slice(0, 8)}`,
      });
      const text = (response.raw_text || '').trim();
      if (!text) {
        return {
          replyText:
            '🤔 Aku bingung jawabnya — coba pertanyaan yang lebih spesifik, atau tanya Panitia Arya soal hal yang urgent.',
          rateLimited: false,
        };
      }
      // Truncate very long AI responses to keep WhatsApp readable.
      const maxLen = 1800;
      const finalText = text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
      return { replyText: finalText, rateLimited: false };
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        return {
          replyText:
            '⚠️ Aku lagi nggak bisa nyambung ke AI provider-ku (semuanya lagi bermasalah). Coba sebentar lagi — kalau urgent, tanya Panitia Arya langsung.',
          rateLimited: false,
        };
      }
      const msg = err instanceof AIError ? err.message : String(err);
      return {
        replyText:
          `⚠️ Aku sempat mau jawab tapi ada gangguan teknis (${msg.slice(0, 80)}). Coba ulang ya, atau tanya Panitia Arya.`,
        rateLimited: false,
      };
    }
  }
}

// =============================================================================
// Context builder — read-only DB queries. All surfaced data is safe for any
// group participant (D-037: delegate contacts are shareable).
// =============================================================================

const RULES_SUMMARY = `Aturan inti Gojiha Tournament (Flash Peak):
- Game: Flash Peak (4v4 arcade, ~5 menit per match, third-person single-character control, no offside/fouls).
- Roster: 5 starters (1 GK + 4 outfield), maks 5 subs (total maks 10). Karakter in-game harus unik per tim (no duplicate character).
- Group Stage: round-robin 1 game per fixture. Win=3pts, Draw=1pt, Loss=0pts. Top 2 per group lolos KO.
- Knockout: BO3 (first to 2 wins) sampai final; Grand Final BO5 (first to 3 wins). Tied KO game di-replay, skor replay masuk ke series score.
- Room host: tim sisi kiri default (rekomendasi); kalau nggak bisa host dan lawan mau, match jalan; kalau lawan nolak, lawan kena forfeit.
- Double room-card unavailable: Group Stage = double walkover (0 pts each, no stats); Knockout = double loss (kedua tim kalah, pasangan ronde berikutnya bye).
- Cutoff harian: 19:59 WIB — fixture yang belum selesai pas cutoff kena aturan di atas (D-031 grup / D-032 KO).
- Best Goalkeeper Award: dianugerahi ke TIM (bukan individu), dengan kiper utama tim itu sebagai representatif (D-036).`;

export async function buildOmakPeakContext(db: Client): Promise<OmakPeakContext> {
  // Active tournament (any non-terminal status).
  const tRes = await db.execute({
    sql: "SELECT id, name, status, config_json FROM tournaments WHERE status NOT IN ('COMPLETED','ARCHIVED') ORDER BY created_at DESC LIMIT 1",
  });
  if (tRes.rows.length === 0) {
    return {
      today_fixtures: [],
      standings_by_group: [],
      teams_and_delegates: [],
      qna_entries: [],
      rules_summary: RULES_SUMMARY,
    };
  }
  const tRow = tRes.rows[0] as unknown as Record<string, unknown>;
  const tournamentId = String(tRow.id);
  const tournamentName = String(tRow.name);
  const tournamentStatus = String(tRow.status);

  let config: Partial<{
    kickoff_time: string;
    confirmation_deadline: string;
    grace_period_minutes: number;
    report_window_minutes: number;
    points_win: number;
    points_draw: number;
    points_loss: number;
  }> = {};
  try {
    if (tRow.config_json) config = JSON.parse(String(tRow.config_json));
  } catch {
    config = {};
  }

  // Fixtures: upcoming + recent (bounded). scheduled_at nulls last.
  const fxRes = await db.execute({
    sql: `SELECT f.id, f.stage, f.round_code, f.scheduled_at, f.status,
                 ta.team_name AS team_a_name, tb.team_name AS team_b_name,
                 g.group_code
          FROM fixtures f
          LEFT JOIN teams ta ON ta.id = f.team_a_id
          LEFT JOIN teams tb ON tb.id = f.team_b_id
          LEFT JOIN groups g ON g.id = f.group_id
          WHERE f.tournament_id = ?
          ORDER BY (f.scheduled_at IS NULL), f.scheduled_at ASC
          LIMIT 12`,
    args: [tournamentId],
  });
  const today_fixtures = fxRes.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      fixture_id: String(row.id),
      stage: String(row.stage),
      group_code: row.group_code ? String(row.group_code) : null,
      round_code: row.round_code ? String(row.round_code) : null,
      team_a_name: String(row.team_a_name),
      team_b_name: String(row.team_b_name),
      scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
      status: String(row.status),
    };
  });

  // Standings per group (bounded rows per group).
  const stRes = await db.execute({
    sql: `SELECT s.group_id, g.group_code, s.team_id, t.team_name,
                 s.played, s.wins, s.draws, s.losses,
                 s.goals_for, s.goals_against, s.points
          FROM standings s
          JOIN groups g ON g.id = s.group_id
          JOIN teams t ON t.id = s.team_id
          WHERE s.tournament_id = ?
          ORDER BY s.group_id, s.points DESC, s.goal_difference DESC, s.goals_for DESC`,
    args: [tournamentId],
  });
  const groupMap = new Map<string, { group_code: string; rows: any[] }>();
  for (const r of stRes.rows) {
    const row = r as unknown as Record<string, unknown>;
    const gid = String(row.group_id);
    const gcode = String(row.group_code);
    if (!groupMap.has(gid)) groupMap.set(gid, { group_code: gcode, rows: [] });
    const grp = groupMap.get(gid)!;
    if (grp.rows.length < 5) {
      grp.rows.push({
        team_name: String(row.team_name),
        played: Number(row.played),
        wins: Number(row.wins),
        draws: Number(row.draws),
        losses: Number(row.losses),
        goals_for: Number(row.goals_for),
        goals_against: Number(row.goals_against),
        points: Number(row.points),
      });
    }
  }
  const standings_by_group = Array.from(groupMap.values());

  // Teams + delegates + primary WA identity (delegate contacts shareable per D-037).
  // NOTE on LIDs: when the primary identity is a WhatsApp internal LID
  // (raw_address ending '@lid'), it is flagged (delegate_whatsapp_is_lid)
  // instead of being treated as an actionable contact — see the prompt rule
  // in src/ai/prompts/omak-peak.ts.
  const tdRes = await db.execute({
    sql: `SELECT t.team_name, t.team_code, d.display_name AS delegate_display_name,
                 wi.raw_address AS delegate_whatsapp, g.group_code
          FROM teams t
          LEFT JOIN delegates d ON d.id = t.delegate_id
          LEFT JOIN whatsapp_identities wi ON wi.delegate_id = d.id AND wi.is_primary = 1
          LEFT JOIN group_members gm ON gm.team_id = t.id
          LEFT JOIN groups g ON g.id = gm.group_id
          WHERE t.tournament_id = ? AND t.registration_status IN ('VERIFIED','PENDING')
          ORDER BY t.team_name ASC
          LIMIT 30`,
    args: [tournamentId],
  });
  const teams_and_delegates = tdRes.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    const delegateWhatsapp = row.delegate_whatsapp ? String(row.delegate_whatsapp) : null;
    return {
      team_name: String(row.team_name),
      team_code: row.team_code ? String(row.team_code) : null,
      delegate_display_name: row.delegate_display_name ? String(row.delegate_display_name) : null,
      delegate_whatsapp: delegateWhatsapp,
      // Flag internal WhatsApp LIDs: a raw @lid address is NOT a dialable
      // phone contact, so the prompt must not offer it as one (D-037
      // contact-sharing stays honest — see omak-peak.ts prompt guidance).
      delegate_whatsapp_is_lid: delegateWhatsapp !== null && delegateWhatsapp.endsWith('@lid'),
      group_code: row.group_code ? String(row.group_code) : null,
    };
  });

  // QnA entries (living FAQ).
  let qna_entries: Array<{ question: string; answer: string; category: string | null }> = [];
  try {
    const qRes = await db.execute({
      sql: `SELECT question, answer, category FROM qna_entries WHERE is_active = 1 ORDER BY created_at DESC LIMIT 30`,
    });
    qna_entries = qRes.rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return {
        question: String(row.question),
        answer: String(row.answer),
        category: row.category ? String(row.category) : null,
      };
    });
  } catch {
    // qna_entries table may not exist yet on legacy DBs without migration 004.
    qna_entries = [];
  }

  return {
    tournament: {
      name: tournamentName,
      status: tournamentStatus,
      kickoff_time: config.kickoff_time,
      confirmation_deadline: config.confirmation_deadline,
      grace_period_minutes: config.grace_period_minutes,
      report_window_minutes: config.report_window_minutes,
      points_win: config.points_win,
      points_draw: config.points_draw,
      points_loss: config.points_loss,
    },
    today_fixtures,
    standings_by_group,
    teams_and_delegates,
    qna_entries,
    rules_summary: RULES_SUMMARY,
  };
}
