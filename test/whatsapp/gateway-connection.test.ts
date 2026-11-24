import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayConnection } from '../../src/whatsapp/gateway-connection.js';

let socketPath: string;
let server: ReturnType<typeof createServer>;
let serverSockets: import('node:net').Socket[] = [];
let received: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'fpgw-'));
  socketPath = join(dir, 'gw.sock');
  received = [];
  server = createServer((s) => {
    serverSockets.push(s);
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line.trim()) continue;
        received.push(line);
        const obj = JSON.parse(line) as { t: string };
        if (obj.t === 'hello') {
          s.write(`${JSON.stringify({ t: 'hello_ack', ok: true })}\n`);
        }
      }
    });
  });
});

afterEach(async () => {
  for (const s of serverSockets) s.destroy();
  serverSockets = [];
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(join(socketPath, '..'), { recursive: true, force: true });
});

function push(obj: Record<string, unknown>): void {
  for (const s of serverSockets) s.write(`${JSON.stringify(obj)}\n`);
}

function startServer(): Promise<void> {
  return new Promise((resolve) => server.listen(socketPath, () => resolve()));
}

function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('GatewayConnection (flashpeak transport)', () => {
  it('handshakes as consumer flashpeak and emits connection open', async () => {
    await startServer();
    const conn = new GatewayConnection(socketPath, 'flashpeak');
    const events: string[] = [];
    conn.on('connection.update', (u: { connection?: string }) => events.push(u.connection ?? ''));
    await conn.connect();
    expect(JSON.parse(received[0] as string)).toEqual({ t: 'hello', consumer: 'flashpeak' });
    expect(events).toContain('open');
    expect(conn.isConnected).toBe(true);
    expect(conn.getSocket()).toBeTruthy();
    await conn.disconnect();
  });

  it('re-emits messages.upsert shaped for the existing normalizer', async () => {
    await startServer();
    const conn = new GatewayConnection(socketPath, 'flashpeak');
    const ups: { messages: { key?: { remoteJid?: string }; message?: { conversation?: string } }[] }[] = [];
    conn.on('messages.upsert', (u: { messages: never[] }) => ups.push(u as never));
    await conn.connect();
    push({
      t: 'msg',
      id: 'm9',
      ts: 1730000000000,
      from: '120363412423738009@g.us',
      sender: '6281@s.whatsapp.net',
      isGroup: true,
      fromMe: false,
      text: '!quiz',
      raw: {
        key: { remoteJid: '120363412423738009@g.us', fromMe: false, id: 'm9', participant: '6281@s.whatsapp.net' },
        message: { conversation: '!quiz' },
      },
    });
    await waitFor(() => ups.length === 1);
    const msg = ups[0]?.messages[0];
    expect(msg?.key?.remoteJid).toBe('120363412423738009@g.us');
    expect(msg?.message?.conversation).toBe('!quiz');
    await conn.disconnect();
  });

  it('stub socket sendMessage resolves with gateway ack id', async () => {
    await startServer();
    const conn = new GatewayConnection(socketPath, 'flashpeak');
    await conn.connect();
    const stub = conn.getSocket();
    const sent = stub!.sendMessage('120363412423738009@g.us', { text: 'score updated' }, { quoted: { key: { id: 'm9' } } });
    await waitFor(() => received.some((l) => l.includes('"send"')));
    const req = JSON.parse(received.find((l) => l.includes('"send"')) as string) as {
      rid: string;
      to: string;
      text: string;
      quoted?: unknown;
    };
    expect(req.to).toBe('120363412423738009@g.us');
    expect(req.text).toBe('score updated');
    expect(req.quoted).toBeTruthy();
    push({ t: 'ack', rid: req.rid, ok: true, id: 'FP-SENT-1', ts: 1 });
    const res = await sent;
    expect(res.key?.id).toBe('FP-SENT-1');
    await conn.disconnect();
  });
});
