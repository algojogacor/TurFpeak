/**
 * Flash Peak TMS - Omak Peak trusted context shape (AI-native expansion, D-037)
 *
 * Read-only context supplied to the Omak Peak chat prompt. Built from DB state
 * at request time by src/application/omak-peak.ts (buildOmakPeakContext).
 * Everything here MUST be safe to surface to any group participant — never
 * include credentials, internal file paths, or system internals.
 */

export interface OmakPeakContext {
  tournament?: {
    name: string;
    status: string;
    kickoff_time?: string;
    confirmation_deadline?: string;
    grace_period_minutes?: number;
    report_window_minutes?: number;
    points_win?: number;
    points_draw?: number;
    points_loss?: number;
  };
  /**
   * Fixtures scheduled for "today" (Asia/Jakarta) — bounded to a reasonable
   * count to keep prompt size manageable. Includes stage/group/round and status
   * so Omak Peak can answer "siapa lawan tim X hari ini" / "kapan main" / etc.
   */
  today_fixtures: Array<{
    fixture_id: string;
    stage: string;
    group_code: string | null;
    round_code: string | null;
    team_a_name: string;
    team_b_name: string;
    scheduled_at: string | null;
    status: string;
  }>;
  /**
   * Compact standings per group (top rows). Bounded per group so the prompt
   * doesn't bloat for large tournaments.
   */
  standings_by_group: Array<{
    group_code: string;
    rows: Array<{
      team_name: string;
      played: number;
      wins: number;
      draws: number;
      losses: number;
      goals_for: number;
      goals_against: number;
      points: number;
    }>;
  }>;
  /**
   * Teams + their delegate's WhatsApp address. Per the tournament's open-communication
   * norm (D-037), delegate contacts are shareable so participants can coordinate matches
   * (room host, scheduling). Limited to teams in the active tournament.
   *
   * delegate_whatsapp_is_lid flags addresses that are WhatsApp internal LIDs
   * (`@lid`) rather than dialable phone-number JIDs: production identities are
   * LID-typed, and a raw LID is NOT actionable as a contact for the recipient.
   * The Omak Peak prompt uses this flag to avoid presenting such an address
   * as a usable "contact" (it directs askers to tag the delegate in the group
   * instead — see D-037 contact-sharing guidance in omak-peak.ts).
   */
  teams_and_delegates: Array<{
    team_name: string;
    team_code: string | null;
    delegate_display_name: string | null;
    delegate_whatsapp: string | null;
    delegate_whatsapp_is_lid: boolean;
    group_code: string | null;
  }>;
  /**
   * The living FAQ (!qna). Omak Peak should prefer these for repeated questions.
   */
  qna_entries: Array<{
    question: string;
    answer: string;
    category: string | null;
  }>;
  /**
   * Compact rules summary, derived from COMPETITION_RULES.md at build time.
   * Keeps the prompt grounded in actual published rules without dumping the
   * full document (which would bloat tokens).
   */
  rules_summary: string;
}
