/**
 * Flash Peak TMS - WhatsApp Command Router & Authorizer
 * 
 * Handles command parsing, group scope enforcement (FR-ID-005), and role authorization.
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type {
  NormalizedMessage,
  CommandContext,
  CommandResult,
  CommandDefinition,
  UserRole,
} from './types.js';
import type { IdentityResolver } from '../identity/resolver.js';
import pino from 'pino';

export interface CommandRouterConfig {
  centralGroupJid?: string;
  organizerJid?: string;
  organizerPhone?: string;
  identityResolver: IdentityResolver;
  logLevel?: pino.LevelWithSilent;
  onCentralGroupJidChange?: (jid: string) => void;
}

export class CommandRouter {
  private centralGroupJid: string;
  private organizerJid: string;
  private organizerPhone: string;
  private identityResolver: IdentityResolver;
  private commands: Map<string, CommandDefinition> = new Map();
  private logger: pino.Logger;
  private onCentralGroupJidChange?: (jid: string) => void;

  constructor(config: CommandRouterConfig) {
    this.centralGroupJid = jidNormalizedUser(
      config.centralGroupJid || process.env.WA_CENTRAL_GROUP_JID || ''
    );
    this.organizerJid = (config.organizerJid || process.env.WA_ORGANIZER_JID || '').trim();
    this.organizerPhone = (config.organizerPhone || process.env.WA_ORGANIZER_PHONE || '').replace(/\D/g, '');
    this.identityResolver = config.identityResolver;
    this.logger = pino({ level: config.logLevel || 'silent' });
    this.onCentralGroupJidChange = config.onCentralGroupJidChange;

    // Register built-in utility commands
    this.registerDefaultCommands();
  }

  public onGroupJidChanged(listener: (jid: string) => void): void {
    this.onCentralGroupJidChange = listener;
  }

  /**
   * Registers a command definition.
   */
  public registerCommand(definition: CommandDefinition): void {
    const cmd = definition.command.toLowerCase().trim().replace(/^!/, '');
    this.commands.set(cmd, {
      ...definition,
      command: cmd,
      allowedInDm: definition.allowedInDm ?? (definition.requiredRole === 'ORGANIZER'),
      allowedInGroup: definition.allowedInGroup ?? true,
    });
  }

  public setCentralGroupJid(jid: string): void {
    const normalized = jidNormalizedUser(jid);
    const changed = this.centralGroupJid !== normalized;
    this.centralGroupJid = normalized;
    if (changed && this.onCentralGroupJidChange) {
      this.onCentralGroupJidChange(normalized);
    }
  }

  public getCentralGroupJid(): string {
    return this.centralGroupJid;
  }

  /**
   * Checks whether a command name is registered.
   */
  public hasCommand(command: string): boolean {
    const cmd = command.toLowerCase().trim().replace(/^!/, '');
    return this.commands.has(cmd);
  }

  /**
   * Checks if an incoming message is a command (starts with '!').
   */
  public isCommand(message: NormalizedMessage): boolean {
    const text = (message.text_body || message.caption || '').trim();
    return text.startsWith('!') && text.length > 1;
  }

  /**
   * Parses command name and argument strings from message text.
   */
  public parseCommand(message: NormalizedMessage): { command: string; args: string[]; rawArgs: string } | null {
    const text = (message.text_body || message.caption || '').trim();
    if (!text.startsWith('!')) return null;

    const parts = text.slice(1).trim().split(/\s+/);
    const command = (parts[0] || '').toLowerCase();
    if (!command) return null;

    const args = parts.slice(1);
    const rawArgs = text.slice(1 + command.length).trim();

    return { command, args, rawArgs };
  }

  /**
   * Checks whether the message sender matches configured Organizer identities.
   */
  public isSenderOrganizer(message: NormalizedMessage): boolean {
    // BUGFIX-TS-002: sender_id never existed on NormalizedMessage (legacy
    // field name). sender_raw_address is required and guaranteed non-empty by
    // the normalizer (participant || remoteJid; messages without remoteJid are
    // dropped), so the fallback was dead code removed for type safety.
    const rawSender = message.sender_raw_address;
    const normalizedSender = (message.sender_normalized_address || jidNormalizedUser(rawSender) || '').toLowerCase();
    const organizerList = (this.organizerJid || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (
      organizerList.some(
        (target) =>
          normalizedSender === target ||
          (rawSender && rawSender.toLowerCase() === target) ||
          (rawSender && jidNormalizedUser(rawSender).toLowerCase() === target)
      )
    ) {
      return true;
    }

    if (this.organizerPhone) {
      const senderDigits = normalizedSender.split('@')[0]?.replace(/\D/g, '');
      // BUGFIX-TS-002: sender_id fallback removed (field never existed on
      // NormalizedMessage; see isSenderOrganizer note above).
      const rawDigits = message.sender_raw_address.split('@')[0]?.replace(/\D/g, '');
      if (
        (senderDigits && senderDigits === this.organizerPhone) ||
        (rawDigits && rawDigits === this.organizerPhone)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluates message authorization, verifies group scope, and dispatches command.
   */
  public async handleMessage(message: NormalizedMessage): Promise<CommandResult | null> {
    const parsed = this.parseCommand(message);
    if (!parsed) {
      return null;
    }

    const { command, args, rawArgs } = parsed;
    const normalizedChatId = jidNormalizedUser(message.chat_id);

    // 1. Role Resolution & Authorization
    let role: UserRole = 'UNKNOWN';
    const isOrganizer = this.isSenderOrganizer(message);

    let delegateId: string | null = null;
    let teamId: string | null = null;

    if (isOrganizer) {
      role = 'ORGANIZER';
    } else {
      // Resolve delegate from database
      // BUGFIX-TS-002: sender_id fallback removed (field never existed on
      // NormalizedMessage; see isSenderOrganizer note above).
      const rawAddress = message.sender_raw_address;
      const resolution = await this.identityResolver.resolveIdentity(
        rawAddress,
        message.chat_id
      );

      if (resolution.status === 'VERIFIED' && resolution.delegate) {
        role = 'DELEGATE';
        delegateId = resolution.delegate.id;
        teamId = resolution.team?.id || null;
      }
    }

    // 2. Command Definition Lookup
    const definition = this.commands.get(command);
    if (!definition) {
      return {
        success: false,
        error: 'UNKNOWN_COMMAND',
        responseText: `Perintah *!${command}* tidak dikenali. Ketik *!help* untuk melihat daftar perintah.`,
      };
    }

    // 3. Role-based Access Control
    if (definition.requiredRole === 'ORGANIZER' && role !== 'ORGANIZER') {
      return {
        success: false,
        error: 'FORBIDDEN_ORGANIZER_ONLY',
        responseText: '⛔ Perintah ini hanya memiliki izin untuk dijalankan oleh Organizer turnamen.',
      };
    }

    if (definition.requiredRole === 'DELEGATE' && role === 'UNKNOWN') {
      return {
        success: false,
        error: 'UNAUTHORIZED_DELEGATE',
        responseText: '⛔ Identitas Anda belum terdaftar sebagai delegate resmi turnamen.',
      };
    }

    // 4. Validate DM vs Group Context
    const isGroup = normalizedChatId.endsWith('@g.us');
    const isAdminChat = !isGroup && isOrganizer;
    if (!isGroup && !definition.allowedInDm) {
      return {
        success: false,
        error: 'GROUP_ONLY',
        responseText: '⚠️ Perintah ini hanya dapat dijalankan di dalam grup turnamen.',
      };
    }

    if (isGroup && !definition.allowedInGroup) {
      return {
        success: false,
        error: 'DM_ONLY',
        responseText: '⚠️ Perintah ini hanya dapat dijalankan melalui pesan pribadi dengan bot.',
      };
    }

    // 5. Group Scope Validation (FR-ID-005)
    // Commands and match reports must be accepted only in the configured central tournament group,
    // unless it is an explicitly allowed private DM with the organizer or an organizer administrative flow.
    let isCentralGroup = Boolean(this.centralGroupJid && normalizedChatId === this.centralGroupJid);

    if (isGroup && !isCentralGroup) {
      // If an authorized ORGANIZER is running an administrative command (role ORGANIZER),
      // or explicit group setup commands (!createtournament, !setgroup),
      // or if central group has not been configured yet: adopt this group as official central group.
      if (isOrganizer && (definition.requiredRole === 'ORGANIZER' || command === 'createtournament' || command === 'setgroup' || !this.centralGroupJid)) {
        this.setCentralGroupJid(normalizedChatId);
        isCentralGroup = true;
        this.logger.info(
          { newCentralGroup: normalizedChatId, command },
          'Central tournament group automatically established by organizer'
        );
      } else {
        this.logger.warn(
          { chatId: normalizedChatId, centralGroup: this.centralGroupJid },
          'Command rejected: outside central tournament group scope'
        );
        return {
          success: false,
          error: 'UNAUTHORIZED_GROUP',
          responseText: '⚠️ Perintah hanya dapat diproses di dalam grup turnamen resmi.',
        };
      }
    }

    // 6. Execute Handler
    const ctx: CommandContext = {
      message,
      command,
      args,
      rawArgs,
      role,
      delegateId,
      teamId,
      isOrganizer,
      isCentralGroup,
      isAdminChat,
    };

    try {
      return await definition.handler(ctx);
    } catch (err: any) {
      this.logger.error({ err, command }, 'Error executing command handler');
      return {
        success: false,
        error: 'HANDLER_ERROR',
        responseText: `Terjadi kesalahan saat memproses perintah *!${command}*: ${err?.message || 'Internal error'}`,
      };
    }
  }

  private registerDefaultCommands(): void {
    // !ping
    this.registerCommand({
      command: 'ping',
      requiredRole: 'ANY',
      description: 'Cek koneksi dan kecepatan respon bot',
      allowedInDm: true,
      allowedInGroup: true,
      handler: (ctx) => {
        const receivedAt = ctx.message?.received_at
          ? new Date(ctx.message.received_at).getTime()
          : Date.now();
        const latencyMs = Math.max(1, Date.now() - receivedAt);
        return {
          success: true,
          responseText: `🏓 Pong! (*${latencyMs} ms*)\nBot Flash Peak TMS aktif.`,
        };
      },
    });

    // !help
    this.registerCommand({
      command: 'help',
      requiredRole: 'ANY',
      description: 'Menampilkan daftar perintah yang tersedia',
      allowedInDm: true,
      allowedInGroup: true,
      handler: (ctx) => {
        const available: string[] = [];
        for (const [cmd, def] of this.commands.entries()) {
          if (def.requiredRole === 'ORGANIZER' && ctx.role !== 'ORGANIZER') {
            continue;
          }
          if (def.requiredRole === 'DELEGATE' && ctx.role === 'UNKNOWN') {
            continue;
          }
          available.push(`*!${cmd}* - ${def.description || 'Tidak ada deskripsi'}`);
        }

        return {
          success: true,
          responseText: `📋 *Daftar Perintah Flash Peak TMS:*\n\n${available.join('\n')}`,
        };
      },
    });

    // !setgroup
    this.registerCommand({
      command: 'setgroup',
      requiredRole: 'ORGANIZER',
      description: 'Menetapkan grup ini sebagai grup turnamen resmi (Admin only)',
      allowedInDm: false,
      allowedInGroup: true,
      handler: (ctx) => {
        this.setCentralGroupJid(ctx.message.chat_id);
        return {
          success: true,
          responseText: '✅ Grup ini telah berhasil ditetapkan sebagai Grup Resmi Turnamen Flash Peak TMS.',
        };
      },
    });
  }
}
