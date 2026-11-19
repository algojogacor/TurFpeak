/**
 * Flash Peak TMS - CLI Entrypoint for WhatsApp Bot
 * 
 * Boots the application orchestrator, connects to WhatsApp via Baileys,
 * renders QR code in the terminal for linking, and binds message event listeners.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@libsql/client';
import { WhatsAppConnection } from '../whatsapp/connection.js';
import { WhatsAppSender } from '../whatsapp/sender.js';
import { normalizeWAMessage } from '../whatsapp/normalizer.js';
import { FlashPeakMediaClient } from '../media/client.js';
import { ProviderRouter } from '../ai/router.js';
import { GroqAdapter } from '../ai/providers/groq.js';
import { GeminiAdapter } from '../ai/providers/gemini.js';
import { OllamaAdapter } from '../ai/providers/ollama.js';
import { NvidiaAdapter } from '../ai/providers/nvidia.js';
import { DeepSeekAdapter } from '../ai/providers/deepseek.js';
import { CohereAdapter } from '../ai/providers/cohere.js';
import { MistralAdapter } from '../ai/providers/mistral.js';
import type { ProviderAdapter } from '../ai/adapter.js';
import { createApp } from '../index.js';
import { runMigrations } from '../db/migrate.js';

// --- Load .env file manually without external dotenv dependency ---
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

async function main() {
  console.log('====================================================');
  console.log('       Flash Peak Tournament Management System      ');
  console.log('====================================================');

  // 1. Initialize Database
  const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.sqlite';
  const dbToken = process.env.TURSO_AUTH_TOKEN;
  console.log(`[DB] Connecting to database (${dbUrl.split('?')[0]})...`);
  const db = createClient({
    url: dbUrl,
    authToken: dbToken,
  });

  // Run pending migrations
  try {
    const migrationResult = await runMigrations(db);
    if (migrationResult.applied.length > 0) {
      console.log(`[DB] Applied ${migrationResult.applied.length} migration(s): ${migrationResult.applied.join(', ')}`);
    } else {
      console.log('[DB] Database schema is up to date.');
    }
  } catch (err) {
    console.error('[DB] Database migration failed. Aborting startup to prevent running with an invalid schema:', err instanceof Error ? err.message : err);
    try {
      db.close();
    } catch {}
    throw new Error(`Database migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Initialize Media Client (pointing to Flash Peak Media Service on VM or local)
  const mediaUrl = process.env.FLASHPEAK_MEDIA_API_URL || process.env.MEDIA_SERVICE_URL || 'http://127.0.0.1:4189';
  const mediaSecret = process.env.FLASHPEAK_MEDIA_SECRET || process.env.MEDIA_SERVICE_HMAC_SECRET;
  if (!mediaSecret) {
    throw new Error(
      'Media service authentication secret missing: Please configure FLASHPEAK_MEDIA_SECRET or MEDIA_SERVICE_HMAC_SECRET in your environment.'
    );
  }
  const mediaClient = new FlashPeakMediaClient({
    apiUrl: mediaUrl,
    secret: mediaSecret,
    db,
  });

  // 3. Initialize AI Provider Router
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const ollamaUrl = process.env.OLLAMA_CLOUD_BASE_URL;

  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const cohereKey = process.env.COHERE_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY;

  const groqKeys = process.env.GROQ_API_KEYS
    ? process.env.GROQ_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const nvidiaKeys = process.env.NVIDIA_API_KEYS
    ? process.env.NVIDIA_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const deepseekKeys = process.env.DEEPSEEK_API_KEYS
    ? process.env.DEEPSEEK_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const cohereKeys = process.env.COHERE_API_KEYS
    ? process.env.COHERE_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;
  const mistralKeys = process.env.MISTRAL_API_KEYS
    ? process.env.MISTRAL_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
    : undefined;

  const adapters: ProviderAdapter[] = [];
  if (groqKey && groqKey !== 'gsk_placeholder_groq_api_key') {
    adapters.push(
      new GroqAdapter({
        apiKey: groqKey,
        apiKeys: groqKeys,
      })
    );
  }
  if (deepseekKey && !deepseekKey.includes('placeholder')) {
    adapters.push(
      new DeepSeekAdapter({
        apiKey: deepseekKey,
        apiKeys: deepseekKeys,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
      })
    );
  }
  if (geminiKey && geminiKey !== 'AIzaSy_placeholder_gemini_api_key' && !geminiKey.includes('placeholder')) {
    adapters.push(
      new GeminiAdapter({
        apiKey: geminiKey,
        model: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
      })
    );
  }
  if (nvidiaKey && !nvidiaKey.includes('placeholder')) {
    adapters.push(
      new NvidiaAdapter({
        apiKey: nvidiaKey,
        apiKeys: nvidiaKeys,
        model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
      })
    );
  }
  if (cohereKey && !cohereKey.includes('placeholder')) {
    adapters.push(
      new CohereAdapter({
        apiKey: cohereKey,
        apiKeys: cohereKeys,
        model: process.env.COHERE_MODEL || 'command-a-reasoning-08-2025',
      })
    );
  }
  if (mistralKey && !mistralKey.includes('placeholder')) {
    adapters.push(
      new MistralAdapter({
        apiKey: mistralKey,
        apiKeys: mistralKeys,
        model: process.env.MISTRAL_MODEL || 'codestral-latest',
        visionModel: process.env.MISTRAL_VISION_MODEL || 'pixtral-12b-2409',
      })
    );
  }
  if (ollamaUrl && ollamaUrl !== 'https://ollama.cloud.example.com') {
    adapters.push(new OllamaAdapter({ baseUrl: ollamaUrl, apiKey: process.env.OLLAMA_CLOUD_API_KEY }));
  }

  console.log(
    `[AI] Initialized Multi-Provider Router with ${adapters.length} provider(s): ` +
      adapters.map((a) => a.name).join(', ')
  );

  const providerRouter = new ProviderRouter({
    adapters,
    prioritizeByTask: true,
  });

  // 4. Initialize WhatsApp Connection
  const authDir = process.env.WA_AUTH_STATE_DIR || './auth_state';
  console.log(`[WA] Initializing Baileys WhatsApp client (auth dir: ${authDir})...`);

  const waConnection = new WhatsAppConnection({
    authStateDir: authDir,
    printQRInTerminal: false,
    browser: ['FlashPeak TMS', 'Chrome', '1.0.0'],
  });

  // Handle QR code generation for user scanning
  waConnection.on('qr', (qr: string) => {
    console.log('\n====================================================');
    console.log('  SCAN QR CODE INI MENGGUNAKAN WHATSAPP DI HP ANDA  ');
    console.log('  (Menu WhatsApp > Perangkat Tertaut > Tautkan)     ');
    console.log('====================================================\n');
    qrcode.generate(qr, { small: true });
    try {
      writeFileSync(path.join(authDir, 'last_qr.txt'), qr, 'utf8');
    } catch {}
    console.log('\n[WA] Menunggu scan QR code dari aplikasi WhatsApp...');
  });

  // 5. Create Central TMS Application
  const envGroup = process.env.WA_CENTRAL_GROUP_JID?.trim();
  const centralGroupJid = envGroup && !envGroup.startsWith('120363000000000000') ? envGroup : undefined;

  const app = createApp({
    db,
    mediaClient,
    providerRouter,
    organizerPhone: process.env.WA_ORGANIZER_PHONE || '6281234567890',
    organizerJid: process.env.WA_ORGANIZER_JID,
    centralGroupJid,
  });

  // Connect socket
  const sock = await waConnection.connect();
  const sender = new WhatsAppSender(() => waConnection.getSocket() || sock, { minIntervalMs: 1500 });
  app.setSender(sender);

  waConnection.on('connection.update', (update) => {
    if (update.connection === 'open') {
      const currentSock = waConnection.getSocket();
      const userJid = currentSock?.user?.id || sock.user?.id || 'Unknown';
      console.log('\n====================================================');
      console.log(`[WA] ✅ BERHASIL TERHUBUNG KE WHATSAPP!`);
      console.log(`[WA] Akun Bot JID: ${userJid}`);
      console.log(`[WA] Bot siap memproses turnamen.`);
      console.log('====================================================\n');
      app.start();
    }
  });

  // Inbound messages routing attached to waConnection (persists across all socket reconnects!)
  waConnection.on('messages.upsert', async (data: { type: string; messages: any[] }) => {
    try {
      if (data.type !== 'notify') return;
      const currentSock = waConnection.getSocket() || sock;

      for (const msg of data.messages) {
        if (!msg.message || msg.key?.fromMe) continue;
        const normalized = normalizeWAMessage(msg);
        if (!normalized) continue;

        // Ignore broadcast and newsletter messages
        if (
          normalized.chat_id.endsWith('@broadcast') ||
          normalized.chat_id === 'status@broadcast' ||
          normalized.chat_id.endsWith('@newsletter')
        ) {
          continue;
        }

        console.log(
          `[WA] Inbound msg from ${normalized.sender_raw_address} in ${normalized.chat_id}: ${normalized.text_body || normalized.caption || '[media]'}`
        );

        let mediaBuffer: Buffer | null = null;
        const unwrapped = msg.message?.ephemeralMessage?.message ||
          msg.message?.viewOnceMessage?.message ||
          msg.message?.viewOnceMessageV2?.message ||
          msg.message?.viewOnceMessageV2Extension?.message ||
          msg.message?.documentWithCaptionMessage?.message ||
          msg.message;

        const isMedia = normalized.message_type === 'IMAGE' ||
          Boolean(unwrapped?.imageMessage || unwrapped?.documentMessage);

        if (isMedia) {
          try {
            console.log(`[WA] Downloading media attachment for message ${msg.key.id}...`);
            mediaBuffer = (await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: pino({ level: 'silent' }),
                reuploadRequest: (reuploadMsg) => currentSock.updateMediaMessage(reuploadMsg),
              }
            )) as Buffer;
            console.log(`[WA] Successfully downloaded media: ${mediaBuffer?.length} bytes`);
          } catch (downloadErr) {
            console.error('[WA] Error downloading media attachment:', downloadErr);
          }
        }

        // Process message through TMS orchestrator
        const outcome = await app.handleInboundMessage(normalized, mediaBuffer);
        if (outcome.replyText) {
          const mentions = outcome.mentions || (outcome.commandResult?.metadata?.mentions as string[] | undefined);
          await sender.sendQuote(normalized.chat_id, outcome.replyText, msg, { mentions });
        }
      }
    } catch (err) {
      console.error('[WA] Error handling inbound message:', err);
    }
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n[System] Shutting down gracefully...');
    app.stop();
    await waConnection.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
