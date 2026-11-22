/**
 * Flash Peak TMS - AI-Native Command Registration (AI-native expansion)
 *
 * Registers the new AI-native commands added by the 2026-11-22 expansion:
 *   !ai              — Omak Peak read-only chat (any role)
 *   !agent           — organizer AI agent: NL instruction -> plan -> confirm -> execute
 *   !agentconfirm    — confirm a staged plan by its short code (idempotency enforced)
 *   !agentcancel     — cancel a staged plan by its short code
 *   !qna             — list the living FAQ (any role)
 *   !saveqna         — organizer: AI-extract Q&A pairs from recent group messages
 *   !trivia          — random verified Flash Peak fact (any role)
 *   !quiz            — quiz question with delayed answer reveal (any role)
 *   !pantun          — AI-generated pantun, Flash-Peak/tournament themed (any role)
 *
 * Kept in a dedicated module so tournament-commands.ts does not grow further;
 * the modularization precedent (src/index.ts -> src/application/) is continued.
 */

import type { CommandRouter } from '../whatsapp/router.js';
import type { CommandContext } from '../whatsapp/types.js';
import type { Client } from '@libsql/client';
import type { ProviderRouter } from '../ai/router.js';
import type { WhatsAppSender } from '../whatsapp/sender.js';
import { OmakPeakService, OMAK_PEAK_INTRO } from './omak-peak.js';
import { AgentPlannerService } from './agent-planner.js';
import { buildDefaultAgentActionCatalog, type AgentActionCatalog } from './agent-actions.js';
import { QnaService } from './qna.js';
import { EngagementService } from './engagement.js';
import { TriviaService } from './trivia.js';

export interface AiNativeCommandDeps {
  db: Client;
  providerRouter?: ProviderRouter;
  sender?: WhatsAppSender;
  centralGroupJid?: string;
}

/**
 * Registers all AI-native commands onto the given router.
 * Returns the instantiated services so the caller (FlashPeakApp) can wire
 * engagement hooks (e.g. match-lock hype recap) into the existing pipelines.
 */
export function registerAiNativeCommands(
  router: CommandRouter,
  deps: AiNativeCommandDeps
): {
  omakPeak: OmakPeakService;
  agent: AgentPlannerService;
  qna: QnaService;
  engagement: EngagementService;
  trivia: TriviaService;
} {
  const omakPeak = new OmakPeakService({ db: deps.db, providerRouter: deps.providerRouter });
  const actionCatalog = buildDefaultAgentActionCatalog(deps.db);
  const agent = new AgentPlannerService({
    db: deps.db,
    providerRouter: deps.providerRouter,
    actionCatalog,
  });
  const qna = new QnaService({ db: deps.db, providerRouter: deps.providerRouter });
  const engagement = new EngagementService({ providerRouter: deps.providerRouter });
  const trivia = new TriviaService({ providerRouter: deps.providerRouter });

  // -------------------------------------------------------------------------
  // !ai  —  read-only chat with Omak Peak (any role, group + DM)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'ai',
    requiredRole: 'ANY',
    description: 'Tanya Omak Peak apa aja (turnamen, Flash Peak, atau ngobrol santai). Read-only.',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const userMessage = ctx.rawArgs;
      const res = await omakPeak.handleAiCommand(ctx.message.sender_raw_address, userMessage);
      return {
        success: !res.rateLimited,
        responseText: res.replyText,
        metadata: res.rateLimited ? { rateLimited: true, retryAfterSeconds: res.retryAfterSeconds } : undefined,
      };
    },
  });

  // -------------------------------------------------------------------------
  // !agent  —  organizer AI agent: NL instruction -> plan (preview, no execute)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'agent',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] AI agent: susun rencana aksi dari instruksi bahasa natural (preview + butuh !agentconfirm).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const res = await agent.planFromInstruction({
        instruction: ctx.rawArgs,
        organizerAddress: ctx.message.sender_raw_address,
        organizerDelegateId: ctx.delegateId,
        chatId: ctx.message.chat_id,
      });
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !agentconfirm <code>  —  execute a staged plan (idempotent via plan_code)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'agentconfirm',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] Konfirmasi & eksekusi rencana AI agent berdasarkan kode plan (idempotent).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const code = (ctx.args[0] || '').trim().toUpperCase();
      if (!code) {
        return {
          success: false,
          responseText: '⚠️ Pakai seperti: *!agentconfirm AGENT-XXXX* (kode plan dari !agent).',
        };
      }
      const res = await agent.confirmAndExecute(code, ctx.message.sender_raw_address);
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !agentcancel <code>  —  cancel a staged plan
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'agentcancel',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] Batalkan rencana AI agent yang masih pending.',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const code = (ctx.args[0] || '').trim().toUpperCase();
      if (!code) {
        return {
          success: false,
          responseText: '⚠️ Pakai seperti: *!agentcancel AGENT-XXXX*.',
        };
      }
      const res = await agent.cancelPlan(code, ctx.message.sender_raw_address);
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !qna  —  list the living FAQ (any role)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'qna',
    requiredRole: 'ANY',
    description: 'Lihat daftar pertanyaan-jawaban yang sudah terkumpul (FAQ hidup turnamen).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (_ctx: CommandContext) => {
      const res = await qna.listEntries();
      return { success: true, responseText: res };
    },
  });

  // -------------------------------------------------------------------------
  // !saveqna [n]  —  organizer: AI-extract Q&A from last n (default 10) group msgs
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'saveqna',
    requiredRole: 'ORGANIZER',
    description: '[Panitia] Ekstrak pasangan Q&A dari N pesan terakhir grup (default 10) lewat AI.',
    allowedInDm: false,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const nArg = parseInt(ctx.args[0] || '', 10);
      const n = Number.isFinite(nArg) && nArg > 0 ? Math.min(50, nArg) : 10;
      const res = await qna.extractAndSave({
        chatId: ctx.message.chat_id,
        count: n,
        organizerAddress: ctx.message.sender_raw_address,
        organizerDelegateId: ctx.delegateId,
      });
      return { success: res.success, responseText: res.responseText };
    },
  });

  // -------------------------------------------------------------------------
  // !trivia  —  random verified Flash Peak fact (any role)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'trivia',
    requiredRole: 'ANY',
    description: 'Fakta acak soal Flash Peak (dari basis data terverifikasi, bukan karangan AI).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (_ctx: CommandContext) => {
      const res = await trivia.randomFact();
      return { success: true, responseText: res };
    },
  });

  // -------------------------------------------------------------------------
  // !quiz  —  quiz question with delayed answer reveal (any role)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'quiz',
    requiredRole: 'ANY',
    description: 'Quiz Flash Peak: pertanyaan dulu, jawaban muncul 15 detik kemudian.',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (ctx: CommandContext) => {
      const res = await trivia.randomQuiz();
      if (!res.success || !res.question || !res.answer || !deps.sender || !deps.centralGroupJid) {
        return { success: res.success, responseText: res.responseText };
      }
      // Send the question immediately; schedule the answer reveal after 15s.
      const targetChat = ctx.message.chat_id || deps.centralGroupJid;
      try {
        await deps.sender.sendText(
          targetChat,
          `❓ *QUIZ FLASH PEAK*\n\n${res.question}\n\n_Jawaban muncul 15 detik lagi..._`
        );
      } catch (sendErr) {
        return { success: false, responseText: '⚠️ Gagal mengirim pertanyaan quiz.' };
      }
      // Schedule the reveal. Use a detached promise — never blocks the handler.
      const answer = res.answer;
      const senderRef = deps.sender;
      setTimeout(async () => {
        try {
          await senderRef.sendText(
            targetChat,
            `✅ *Jawaban:* ${answer}\n\n_Mau quiz lagi? Ketik *!quiz*_`
          );
        } catch {
          // Best-effort; if the send fails the user can retry.
        }
      }, 15_000);
      // The handler itself returns no immediate reply (the question was already sent).
      return { success: true, responseText: '' };
    },
  });

  // -------------------------------------------------------------------------
  // !pantun  —  AI-generated pantun, Flash-Peak/tournament themed (any role)
  // -------------------------------------------------------------------------
  router.registerCommand({
    command: 'pantun',
    requiredRole: 'ANY',
    description: 'Pantun acak bergaya Flash Peak / turnamen (generate AI, bukan klaim fakta).',
    allowedInDm: true,
    allowedInGroup: true,
    handler: async (_ctx: CommandContext) => {
      const res = await engagement.generatePantun();
      return { success: res.success, responseText: res.text };
    },
  });

  return { omakPeak, agent, qna, engagement, trivia };
}
