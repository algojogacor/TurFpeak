/**
 * Flash Peak TMS - Interactive Quiz Session Manager
 *
 * Real-time active quiz state machine for community engagement.
 * Manages 15-second fast-paced arcade quiz turns, answer evaluation,
 * timeout callbacks, and scoring into the persistent quiz_scores table.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';

export interface QuizQuestion {
  id: string;
  category: string;
  question: string;
  answer: string;
  keywords: string[];
  sources?: string[];
}

export interface ActiveQuiz {
  chatId: string;
  quiz: QuizQuestion;
  startedAt: number;
  expiresAt: number;
  timeoutHandle: NodeJS.Timeout;
}

export interface QuizLeaderboardEntry {
  rank: number;
  participant_name: string;
  score: number;
}

/**
 * Normalizes input text and checks whether it matches any of the quiz keywords.
 * Supports exact single-word tokens and multi-word phrases.
 */
export function isQuizAnswerMatch(input: string, keywords: string[]): boolean {
  if (!input || !keywords || keywords.length === 0) return false;

  const cleanInput = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s%]/g, ' ')
    .trim();

  if (!cleanInput) return false;

  const words = cleanInput.split(/\s+/).filter(Boolean);

  for (const kw of keywords) {
    const cleanKw = kw.toLowerCase().trim();
    if (!cleanKw) continue;

    // Multi-word phrase (e.g. "guided pulse pass", "free fire", "world class")
    if (cleanKw.includes(' ')) {
      if (cleanInput.includes(cleanKw)) {
        return true;
      }
    } else {
      // Single-word token (e.g. "oscar", "kelly", "steffie", "280", "18", "tatsuya")
      if (words.includes(cleanKw) || cleanInput === cleanKw) {
        return true;
      }
    }
  }

  return false;
}

export interface QuizSessionManagerDeps {
  db: Client;
  durationMs?: number; // default 15_000 (15 seconds)
}

export class QuizSessionManager {
  private readonly db: Client;
  private readonly durationMs: number;
  private activeQuizzes = new Map<string, ActiveQuiz>();

  constructor(deps: QuizSessionManagerDeps) {
    this.db = deps.db;
    this.durationMs = deps.durationMs ?? 15_000;
  }

  /**
   * Checks whether a quiz is currently running in this chat.
   */
  hasActiveQuiz(chatId: string): boolean {
    const active = this.activeQuizzes.get(chatId.toLowerCase());
    if (!active) return false;
    if (Date.now() >= active.expiresAt) {
      this.cancelQuiz(chatId);
      return false;
    }
    return true;
  }

  /**
   * Returns remaining seconds for active quiz in this chat.
   */
  getRemainingSeconds(chatId: string): number {
    const active = this.activeQuizzes.get(chatId.toLowerCase());
    if (!active) return 0;
    const rem = Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000));
    return rem;
  }

  /**
   * Starts a new 15-second quiz in the chat.
   */
  startQuiz(
    chatId: string,
    quiz: QuizQuestion,
    onTimeout: (active: ActiveQuiz) => Promise<void>
  ): { success: boolean; quiz?: ActiveQuiz; remainingSeconds?: number } {
    const key = chatId.toLowerCase();
    if (this.hasActiveQuiz(key)) {
      return {
        success: false,
        remainingSeconds: this.getRemainingSeconds(key),
      };
    }

    const now = Date.now();
    const expiresAt = now + this.durationMs;

    const timeoutHandle = setTimeout(async () => {
      const current = this.activeQuizzes.get(key);
      if (current) {
        this.activeQuizzes.delete(key);
        try {
          await onTimeout(current);
        } catch (err) {
          console.error('[QuizSessionManager] onTimeout callback error:', err);
        }
      }
    }, this.durationMs);

    const active: ActiveQuiz = {
      chatId,
      quiz,
      startedAt: now,
      expiresAt,
      timeoutHandle,
    };

    this.activeQuizzes.set(key, active);
    return { success: true, quiz: active };
  }

  /**
   * Evaluates an incoming message against the active quiz.
   */
  evaluateAnswer(
    chatId: string,
    text: string
  ): { isAnswerToQuiz: boolean; isCorrect: boolean; active?: ActiveQuiz; elapsedSeconds: number } {
    const key = chatId.toLowerCase();
    const active = this.activeQuizzes.get(key);
    if (!active) {
      return { isAnswerToQuiz: false, isCorrect: false, elapsedSeconds: 0 };
    }

    const elapsedSeconds = Math.max(1, Math.round((Date.now() - active.startedAt) / 1000));
    const isCorrect = isQuizAnswerMatch(text, active.quiz.keywords);

    return {
      isAnswerToQuiz: true,
      isCorrect,
      active,
      elapsedSeconds,
    };
  }

  /**
   * Cancels/closes the active quiz immediately (e.g. when someone answered correctly).
   */
  cancelQuiz(chatId: string): void {
    const key = chatId.toLowerCase();
    const active = this.activeQuizzes.get(key);
    if (active) {
      clearTimeout(active.timeoutHandle);
      this.activeQuizzes.delete(key);
    }
  }

  /**
   * Records a correct answer win in the database and returns the participant's updated score.
   */
  async recordWin(
    chatId: string,
    senderRawAddress: string,
    participantName: string
  ): Promise<number> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.execute({
      sql: `
        INSERT INTO quiz_scores (id, chat_id, sender_raw_address, participant_name, score, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(chat_id, sender_raw_address) DO UPDATE SET
          score = score + 1,
          participant_name = excluded.participant_name,
          updated_at = excluded.updated_at
      `,
      args: [id, chatId, senderRawAddress, participantName, now, now],
    });

    const res = await this.db.execute({
      sql: `SELECT score FROM quiz_scores WHERE chat_id = ? AND sender_raw_address = ?`,
      args: [chatId, senderRawAddress],
    });

    return Number(res.rows[0]?.score ?? 1);
  }

  /**
   * Retrieves the top quiz scorers for this chat (or global).
   */
  async getLeaderboard(chatId?: string, limit = 10): Promise<QuizLeaderboardEntry[]> {
    let sql: string;
    let args: any[];

    if (chatId) {
      sql = `SELECT participant_name, score FROM quiz_scores WHERE chat_id = ? ORDER BY score DESC, updated_at ASC LIMIT ?`;
      args = [chatId, limit];
    } else {
      sql = `SELECT participant_name, SUM(score) as score FROM quiz_scores GROUP BY sender_raw_address ORDER BY score DESC, updated_at ASC LIMIT ?`;
      args = [limit];
    }

    try {
      const res = await this.db.execute({ sql, args });
      return res.rows.map((r, i) => ({
        rank: i + 1,
        participant_name: String(r.participant_name),
        score: Number(r.score),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Formats the quiz leaderboard into a clean WhatsApp message.
   */
  formatLeaderboard(rows: QuizLeaderboardEntry[]): string {
    if (rows.length === 0) {
      return [
        '🎮 *LEADERBOARD KUIS FLASH PEAK* 🏆',
        '_Ajang seru-seruan komunitas tongkrongan_',
        '──────────────────────────────',
        '',
        'Belum ada skor kuis tercatat di grup ini.',
        'Ketik *!quiz* untuk mulai bermain dan jadilah juara kuis pertama! 🥇',
      ].join('\n');
    }

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const lines: string[] = [
      '🎮 *LEADERBOARD KUIS FLASH PEAK* 🏆',
      '_Ajang seru-seruan komunitas tongkrongan_',
      '──────────────────────────────',
      '',
    ];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const badge = medals[i] || `${i + 1}.`;
      lines.push(`${badge} *${row.participant_name}* — ${row.score} Poin Kuis`);
    }

    lines.push('');
    lines.push('──────────────────────────────');
    lines.push('💡 _Kuis ini murni seru-seruan (tidak mempengaruhi klasemen turnamen). Ketik *!quiz* untuk main!_');

    return lines.join('\n');
  }
}
