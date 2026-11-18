/**
 * Flash Peak TMS - WhatsApp Adapter Unit Tests
 * 
 * Tests message normalization, rate limiter / pacing sender, command router,
 * and connection lifecycle safeguards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import {
  normalizeWAMessage,
  getAddressType,
  unwrapMessageContent,
} from '../../src/whatsapp/normalizer.js';
import { WhatsAppSender } from '../../src/whatsapp/sender.js';
import { CommandRouter } from '../../src/whatsapp/router.js';
import { WhatsAppConnection } from '../../src/whatsapp/connection.js';
import { IdentityResolver } from '../../src/identity/resolver.js';
import { DisconnectReason, type proto, type WASocket } from '@whiskeysockets/baileys';
import { randomUUID } from 'node:crypto';

describe('WhatsApp Message Normalizer', () => {
  it('detects address types correctly', () => {
    expect(getAddressType('6281234567890@s.whatsapp.net')).toBe('JID');
    expect(getAddressType('12345678901234@lid')).toBe('LID');
    expect(getAddressType('+6281234567890')).toBe('PHONE');
    expect(getAddressType('6281234567890')).toBe('PHONE');
    expect(getAddressType('120363000000000000@g.us')).toBe('UNKNOWN');
  });

  it('unwraps nested message containers (ephemeral, view-once, caption wrapped)', () => {
    const inner = {
      imageMessage: {
        caption: 'Match Result Screen',
        mimetype: 'image/jpeg',
      },
    };

    const ephemeralWrapped = {
      ephemeralMessage: {
        message: {
          viewOnceMessage: {
            message: inner,
          },
        },
      },
    };

    const unwrapped = unwrapMessageContent(ephemeralWrapped);
    expect(unwrapped?.imageMessage?.caption).toBe('Match Result Screen');
  });

  it('normalizes plain text conversation message', () => {
    const rawMsg: proto.IWebMessageInfo = {
      key: {
        remoteJid: '120363000000000000@g.us',
        id: 'BAE5F123456789',
        participant: '6281234567890:2@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Halo admin, jadwal match kapan?',
      },
      messageTimestamp: 1731917000,
      pushName: 'Budi Santoso',
    };

    const normalized = normalizeWAMessage(rawMsg);
    expect(normalized).not.toBeNull();
    expect(normalized?.provider_message_key).toBe('BAE5F123456789');
    expect(normalized?.chat_id).toBe('120363000000000000@g.us');
    expect(normalized?.sender_normalized_address).toBe('6281234567890@s.whatsapp.net'); // Strips :2 device suffix
    expect(normalized?.address_type).toBe('JID');
    expect(normalized?.message_type).toBe('TEXT');
    expect(normalized?.text_body).toBe('Halo admin, jadwal match kapan?');
    expect(normalized?.push_name).toBe('Budi Santoso');
    expect(normalized?.reply_to_key).toBeNull();
  });

  it('normalizes image message with caption and reply context', () => {
    const rawMsg: proto.IWebMessageInfo = {
      key: {
        remoteJid: '120363000000000000@g.us',
        id: 'IMG_999888',
        participant: '98765432101234@lid',
        fromMe: false,
      },
      message: {
        imageMessage: {
          caption: 'HASIL PERTANDINGAN FINAL',
          mimetype: 'image/jpeg',
          fileLength: 1048576,
          contextInfo: {
            stanzaId: 'PROMPT_MSG_KEY_123',
            participant: 'bot@s.whatsapp.net',
            quotedMessage: {
              conversation: 'Silakan upload bukti match',
            },
          },
        },
      },
      messageTimestamp: 1731917500,
      pushName: 'Alex',
    };

    const normalized = normalizeWAMessage(rawMsg);
    expect(normalized).not.toBeNull();
    expect(normalized?.message_type).toBe('IMAGE');
    expect(normalized?.caption).toBe('HASIL PERTANDINGAN FINAL');
    expect(normalized?.address_type).toBe('LID');
    expect(normalized?.sender_normalized_address).toBe('98765432101234@lid');
    expect(normalized?.reply_to_key).toBe('PROMPT_MSG_KEY_123');
    expect(normalized?.quoted_participant).toBe('bot@s.whatsapp.net');
    expect(normalized?.quoted_text).toBe('Silakan upload bukti match');
    expect(normalized?.media_metadata?.mimetype).toBe('image/jpeg');
    expect(normalized?.media_metadata?.fileLength).toBe(1048576);
  });
});

describe('WhatsAppSender (Rate Limiter & Progressive Reveals)', () => {
  it('enforces rate limiting interval between outbound messages', async () => {
    const sentMessages: Array<{ chatId: string; text: string; sentAt: number }> = [];

    const mockSock = {
      sendMessage: vi.fn().mockImplementation(async (chatId: string, content: any) => {
        sentMessages.push({
          chatId,
          text: content.text,
          sentAt: Date.now(),
        });
        return { key: { id: `out_${randomUUID()}` } };
      }),
    } as unknown as WASocket;

    // Use a short interval for testing (50ms)
    const sender = new WhatsAppSender(() => mockSock, { minIntervalMs: 50 });

    const p1 = sender.sendText('chat1@s.whatsapp.net', 'Message 1');
    const p2 = sender.sendText('chat1@s.whatsapp.net', 'Message 2');
    const p3 = sender.sendText('chat1@s.whatsapp.net', 'Message 3');

    await Promise.all([p1, p2, p3]);

    expect(sentMessages.length).toBe(3);
    // Interval between consecutive sends must be at least 45ms (accounting for timer granularity)
    const diff1 = sentMessages[1]!.sentAt - sentMessages[0]!.sentAt;
    const diff2 = sentMessages[2]!.sentAt - sentMessages[1]!.sentAt;

    expect(diff1).toBeGreaterThanOrEqual(45);
    expect(diff2).toBeGreaterThanOrEqual(45);
  });

  it('performs progressive reveals with progress callback', async () => {
    const revealedIndices: number[] = [];

    const mockSock = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'reveal_msg' } }),
    } as unknown as WASocket;

    const sender = new WhatsAppSender(() => mockSock, { minIntervalMs: 10, revealDelayMs: 20 });

    const items = [
      { text: 'Grup A: Tim 1' },
      { text: 'Grup A: Tim 2' },
      { text: 'Grup A: Tim 3' },
    ];

    await sender.sendProgressiveReveal('group@g.us', items, (idx) => {
      revealedIndices.push(idx);
    });

    expect(revealedIndices).toEqual([0, 1, 2]);
    expect(mockSock.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('rejects if socket is disconnected', async () => {
    const sender = new WhatsAppSender(() => null);
    await expect(sender.sendText('chat@s.whatsapp.net', 'Hello')).rejects.toThrow(
      'WhatsApp socket is not connected'
    );
  });
});

describe('CommandRouter (Group Scope & Role Authorization)', () => {
  let db: Client;
  let resolver: IdentityResolver;
  let router: CommandRouter;

  const centralGroupJid = '120363000000000000@g.us';
  const organizerJid = '6281000000000@s.whatsapp.net';
  const tournamentId = randomUUID();

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    resolver = new IdentityResolver(db);

    router = new CommandRouter({
      centralGroupJid,
      organizerJid,
      identityResolver: resolver,
    });

    // Create tournament and delegate
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Flash Peak Tourney', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });

    const { delegate } = await resolver.createDelegateWithIdentity(
      'Verified Delegate',
      '6281222222222@s.whatsapp.net',
      'JID'
    );

    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
            VALUES (?, ?, 'Tsubasa FC', ?, 'VERIFIED', ?, ?)`,
      args: [randomUUID(), tournamentId, delegate.id, now, now],
    });

    // Register a custom organizer command and a delegate command
    router.registerCommand({
      command: 'draw',
      requiredRole: 'ORGANIZER',
      handler: () => ({ success: true, responseText: 'Draw started' }),
    });

    router.registerCommand({
      command: 'report',
      requiredRole: 'DELEGATE',
      handler: (ctx) => ({ success: true, responseText: `Report received for team ${ctx.teamId}` }),
    });
  });

  afterEach(() => {
    db.close();
  });

  function createMsg(chatId: string, senderJid: string, text: string): NormalizedMessage {
    return {
      id: randomUUID(),
      provider_message_key: randomUUID(),
      chat_id: chatId,
      sender_raw_address: senderJid,
      sender_normalized_address: senderJid,
      address_type: 'JID',
      is_from_me: false,
      participant: senderJid,
      push_name: 'Tester',
      message_timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
      message_type: 'TEXT',
      text_body: text,
      caption: null,
      reply_to_key: null,
      quoted_participant: null,
      quoted_text: null,
      raw_message: {} as any,
    };
  }

  it('responds to !ping in central group', async () => {
    const msg = createMsg(centralGroupJid, '6289999999999@s.whatsapp.net', '!ping');
    const res = await router.handleMessage(msg);

    expect(res?.success).toBe(true);
    expect(res?.responseText).toContain('Pong');
  });

  it('rejects commands from an unauthorized group (FR-ID-005 Group Scope)', async () => {
    const unauthorizedGroup = '120363999999999999@g.us';
    const msg = createMsg(unauthorizedGroup, organizerJid, '!ping');
    const res = await router.handleMessage(msg);

    expect(res?.success).toBe(false);
    expect(res?.error).toBe('UNAUTHORIZED_GROUP');
    expect(res?.responseText).toContain('hanya dapat diproses di dalam grup turnamen resmi');
  });

  it('allows organizer commands from organizer JID in central group', async () => {
    const msg = createMsg(centralGroupJid, organizerJid, '!draw');
    const res = await router.handleMessage(msg);

    expect(res?.success).toBe(true);
    expect(res?.responseText).toBe('Draw started');
  });

  it('rejects organizer commands when invoked by non-organizer', async () => {
    const msg = createMsg(centralGroupJid, '6281222222222@s.whatsapp.net', '!draw');
    const res = await router.handleMessage(msg);

    expect(res?.success).toBe(false);
    expect(res?.error).toBe('FORBIDDEN_ORGANIZER_ONLY');
    expect(res?.responseText).toContain('hanya memiliki izin untuk dijalankan oleh Organizer');
  });

  it('allows delegate commands when invoked by verified delegate', async () => {
    const msg = createMsg(centralGroupJid, '6281222222222@s.whatsapp.net', '!report');
    const res = await router.handleMessage(msg);

    expect(res?.success).toBe(true);
    expect(res?.responseText).toContain('Report received for team');
  });

  it('rejects delegate commands when invoked by unknown participant', async () => {
    const msg = createMsg(centralGroupJid, '6289999999999@s.whatsapp.net', '!report');
    const res = await router.handleMessage(msg);

    expect(res?.success).toBe(false);
    expect(res?.error).toBe('UNAUTHORIZED_DELEGATE');
    expect(res?.responseText).toContain('belum terdaftar sebagai delegate resmi');
  });
});

describe('WhatsAppConnection (Lifecycle & Anti-ban Backoff)', () => {
  it('manages connection state and resets retries on open', () => {
    const conn = new WhatsAppConnection({
      authStateDir: './test_auth_state',
      reconnectBaseDelayMs: 100,
      maxRetries: 3,
    });

    expect(conn.getStatus()).toBe('IDLE');

    // Simulate connection update open
    conn.handleConnectionUpdate({ connection: 'open' });
    expect(conn.getStatus()).toBe('CONNECTED');
    expect(conn.getRetryCount()).toBe(0);
  });

  it('stops immediately and emits logged_out on DisconnectReason.loggedOut (401) without retrying', () => {
    const conn = new WhatsAppConnection({
      authStateDir: './test_auth_state',
      reconnectBaseDelayMs: 100,
    });

    const loggedOutSpy = vi.fn();
    conn.on('logged_out', loggedOutSpy);

    // Simulate connection close with 401 loggedOut
    conn.handleConnectionUpdate({
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: DisconnectReason.loggedOut },
        } as any,
      },
    });

    expect(conn.getStatus()).toBe('LOGGED_OUT');
    expect(loggedOutSpy).toHaveBeenCalledTimes(1);
    expect(conn.getRetryCount()).toBe(0);
  });

  it('schedules reconnect with backoff on recoverable connection errors', () => {
    vi.useFakeTimers();

    const conn = new WhatsAppConnection({
      authStateDir: './test_auth_state',
      reconnectBaseDelayMs: 200,
      maxRetries: 5,
    });

    // Simulate connection close with connectionLost
    conn.handleConnectionUpdate({
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: DisconnectReason.connectionLost },
        } as any,
      },
    });

    expect(conn.getStatus()).toBe('RECONNECTING');

    vi.useRealTimers();
  });
});
