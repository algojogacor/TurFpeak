/**
 * Flash Peak TMS - AI Failure Response Formatter (Task 6.4)
 * 
 * Standardized AI failure message formatter per PROMPT_CATALOG.md §9 and FR-FAIL-002.
 * 
 * Mandatory Rules:
 * 1. Must clearly state automated processing is temporarily unavailable.
 * 2. Must clearly state report has NOT been confirmed, accepted, rejected, or made official.
 * 3. Must direct participants to tournament organizer for manual verification.
 * 4. Never invent numbers, guess match outcome, or make claims about match status.
 */

export interface AIFailureMessageOptions {
  language?: 'id' | 'en' | 'both';
  sessionId?: string;
  fixtureCode?: string;
  organizerPhone?: string;
  includeAdminCommandHint?: boolean;
}

/**
 * Standard English failure text verbatim from PROMPT_CATALOG.md §9
 */
export const STANDARD_FAILURE_TEXT_EN = [
  'Automated screenshot processing is temporarily unavailable.',
  'The report has not been confirmed or changed.',
  'Please contact the tournament organizer for manual verification.',
].join('\n');

/**
 * Standard Indonesian failure text adhering to PROMPT_CATALOG.md §9
 */
export const STANDARD_FAILURE_TEXT_ID = [
  '⚠️ *Pemrosesan Tangkapan Layar Otomatis Sementara Tidak Tersedia*',
  '',
  'Laporan pertandingan belum dikonfirmasi atau diubah.',
  'Status pertandingan TIDAK resmi, TIDAK diterima, dan TIDAK ditolak.',
  'Silakan hubungi penyelenggara turnamen untuk verifikasi manual.',
].join('\n');

/**
 * Formats an AI failure notification message for WhatsApp.
 */
export function formatAIFailureMessage(options: AIFailureMessageOptions = {}): string {
  const lang = options.language ?? 'id';
  const lines: string[] = [];

  if (lang === 'en') {
    lines.push(STANDARD_FAILURE_TEXT_EN);
  } else if (lang === 'both') {
    lines.push(STANDARD_FAILURE_TEXT_ID);
    lines.push('');
    lines.push('─── English ───');
    lines.push(STANDARD_FAILURE_TEXT_EN);
  } else {
    lines.push(STANDARD_FAILURE_TEXT_ID);
  }

  // Optional contextual reference
  const refs: string[] = [];
  if (options.fixtureCode) {
    refs.push(`Pertandingan: *${options.fixtureCode}*`);
  }
  if (options.sessionId) {
    refs.push(`Sesi: \`${options.sessionId.slice(0, 8)}\``);
  }
  if (refs.length > 0) {
    lines.push('');
    lines.push(`📌 ${refs.join(' | ')}`);
  }

  // Optional organizer contact
  if (options.organizerPhone) {
    lines.push('');
    lines.push(`📞 Kontak Penyelenggara: wa.me/${options.organizerPhone.replace(/\D/g, '')}`);
  }

  // Optional Admin hint
  if (options.includeAdminCommandHint) {
    lines.push('');
    lines.push('_Admin dapat memasukkan hasil manual menggunakan command *!manualreport*_');
  }

  return lines.join('\n');
}
