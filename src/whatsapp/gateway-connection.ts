/**
 * Gateway transport for Flash Peak TMS.
 *
 * Replaces the direct Baileys `WhatsAppConnection` when
 * `WA_TRANSPORT=gateway`: connects to the wa-gateway Unix socket as consumer
 * `flashpeak`, re-emits the same `messages.upsert` / `connection.update`
 * events the app already listens for, and provides a socket-shaped object
 * whose `sendMessage` rides the gateway `send` request. Business logic
 * (competition, AI, quiz, normalizer) is untouched — only the transport
 * changed.
 */

import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import pino from 'pino';

const log = pino({ level: process.env.WA_LOG_LEVEL ?? 'info', base: { mod: 'gateway-conn' } });

export type GatewayMessageEvent = {
  t: 'msg';
  id: string;
  ts: number;
  from: string;
  sender: string;
  isGroup: boolean;
  fromMe: boolean;
  text?: string;
  raw?: { key?: unknown; message?: unknown };
};

/** Minimal socket surface the app/sender actually calls. */
export type GatewayStubSocket = {
  user?: { id?: string };
  sendMessage: (
    to: string,
    content: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<{ key?: { id?: string } }>;
};

export class GatewayConnection extends EventEmitter {
  private socket: Socket | null = null;
  private buf = '';
  private stopped = false;
  private backoffMs = 200;
  private connected = false;
  private stub: GatewayStubSocket;

  constructor(
    private readonly socketPath = process.env.WA_SOCKET_PATH ?? '/run/wa-gateway.sock',
    private readonly consumer = 'flashpeak',
  ) {
    super();
    this.setMaxListeners(20);
    this.stub = {
      user: { id: 'gateway' },
      sendMessage: async (to, content, opts) => {
        // text / image + quoted + mentions travel in one envelope; the gateway
        // executes them against the single Baileys owner.
        const rid = `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const delKey = content.delete as { id?: string; fromMe?: boolean; participant?: string } | undefined;
        const line = delKey?.id
          ? {
              t: 'delete',
              rid,
              to,
              messageId: String(delKey.id),
              fromMe: delKey.fromMe,
              participant: delKey.participant,
            }
          : content.image
            ? {
                t: 'send_image',
                rid,
                to,
                b64: Buffer.from(content.image as Uint8Array).toString('base64'),
                mime: content.mimetype ? String(content.mimetype) : 'image/jpeg',
                caption: content.caption ? String(content.caption) : undefined,
                quoted: opts?.quoted as unknown,
                mentions: content.mentions as string[] | undefined,
              }
            : {
                t: 'send',
                rid,
                to,
                text: String(content.text ?? ''),
                quoted: opts?.quoted as unknown,
                mentions: content.mentions as string[] | undefined,
              };
        const ack = await this.roundtrip({ ...line });
        if (!ack.ok) throw new Error(ack.err ?? 'gateway send failed');
        return { key: { id: ack.id } };
      },
    };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Socket-shaped object for WhatsAppSender's socketProvider. */
  getSocket(): GatewayStubSocket | null {
    return this.connected ? this.stub : null;
  }

  async connect(): Promise<GatewayStubSocket> {
    this.stopped = false;
    await this.dial();
    return this.stub;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  private roundtrip(req: Record<string, unknown>): Promise<{ ok: boolean; id?: string; err?: string }> {
    return new Promise((resolve, reject) => {
      const rid = String(req.rid);
      const timer = setTimeout(() => {
        this.off('ack', onAck as never);
        reject(new Error('gateway send timeout'));
      }, 30_000);
      const onAck = (ack: { rid?: string; ok: boolean; id?: string; err?: string }): void => {
        if (ack.rid !== rid) return;
        clearTimeout(timer);
        this.off('ack', onAck as never);
        resolve({ ok: ack.ok, id: ack.id, err: ack.err });
      };
      this.on('ack', onAck as never);
      this.socket?.write(`${JSON.stringify(req)}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.off('ack', onAck as never);
          reject(err);
        }
      });
    });
  }

  private async dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = netConnect(this.socketPath);
      let helloed = false;
      const fail = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        sock.removeAllListeners();
      };

      sock.setEncoding('utf8');
      sock.once('error', (err) => {
        if (!helloed) fail(err as Error);
      });
      sock.once('connect', () => {
        this.socket = sock;
        this.connected = true;
        void sock.write(`${JSON.stringify({ t: 'hello', consumer: this.consumer })}\n`);
      });

      sock.on('data', (chunk: string) => {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          let obj: { t: string } & Record<string, unknown>;
          try {
            obj = JSON.parse(line) as { t: string } & Record<string, unknown>;
          } catch {
            continue;
          }
          if (obj.t === 'hello_ack') {
            const ok = (obj as { ok?: boolean }).ok === true;
            if (ok) {
              helloed = true;
              this.emit('connection.update', { connection: 'open' });
              resolve();
            } else {
              this.connected = false;
              fail(new Error((obj as { err?: string }).err ?? 'hello rejected'));
            }
            continue;
          }
          if (obj.t === 'status') {
            const wa = (obj as { wa?: string }).wa;
            if (wa === 'connected') this.emit('connection.update', { connection: 'open' });
            else if (wa === 'logged_out') this.emit('connection.update', { connection: 'close', lastDisconnect: { error: { data: { code: 401 } } } });
            else this.emit('connection.update', { connection: 'connecting' });
            continue;
          }
          if (obj.t === 'msg') {
            // Reconstruct a WAMessage-shaped object so the existing
            // normalizer + media-download path runs unchanged.
            const ev = obj as unknown as GatewayMessageEvent;
            const waMsg = {
              key: ev.raw?.key ?? {
                remoteJid: ev.from,
                fromMe: ev.fromMe,
                id: ev.id,
                participant: ev.isGroup ? ev.sender : undefined,
              },
              message: ev.raw?.message ?? (ev.text !== undefined ? { conversation: ev.text } : undefined),
              messageTimestamp: Math.floor(ev.ts / 1000),
              pushName: (ev as any).pushName ?? (ev.raw as any)?.pushName ?? (ev.raw as any)?.key?.pushName,
            };
            this.emit('messages.upsert', { type: 'notify', messages: [waMsg] });
            continue;
          }
          if (obj.t === 'ack' || obj.t === 'media_ack') {
            this.emit('ack', obj as unknown as { rid?: string; ok: boolean; id?: string; err?: string });
          }
        }
      });

      sock.on('close', () => {
        const was = this.connected;
        this.connected = false;
        this.socket = null;
        cleanup();
        if (was && !this.stopped) {
          this.emit('connection.update', { connection: 'connecting' });
          this.emit('connection.update', { connection: 'close', lastDisconnect: { error: { data: { code: -1 } } } });
          void sleep(this.backoffMs).then(() => {
            this.backoffMs = Math.min(this.backoffMs * 2, 2_000);
            if (!this.stopped) void this.reconnect();
          });
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    try {
      await this.dial();
      this.backoffMs = 200;
    } catch (err) {
      log.warn({ err: String(err).slice(0, 80) }, 'gateway reconnect failed; retrying');
      void sleep(this.backoffMs).then(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, 2_000);
        if (!this.stopped) void this.reconnect();
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
