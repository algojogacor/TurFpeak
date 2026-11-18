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
}

export class CommandRouter {
  private centralGroupJid: string;
  private organizerJid: string;
  private organizerPhone: string;
  private identityResolver: IdentityResolver;
  private commands: Map<string, CommandDefinition> = new Map();
  private logger: pino.Logger;

  constructor(config: CommandRouterConfig) {
    this.centralGroupJid = jidNormalizedUser(
      config.centralGroupJid || process.env.WA_CENTRAL_GROUP_JID || ''
    );
    this.organizerJid = jidNormalizedUser(
      config.organizerJid || process.env.WA_ORGANIZER_JID || ''
    );
    this.organizerPhone = (config.organizerPhone || process.env.WA_ORGANIZER_PHONE || '').replace(/\D/g, '');
    this.identityResolver = config.identityResolver;
    this.logger = pino({ level: config.logLevel || 'silent' });

    // Register built-in utility commands
    this.registerDefaultCommands();
  }

  /**
   * Registers a command definition.
   */
  public registerCommand(definition: CommandDefinition): void {
    const cmd = definition.command.toLowerCase().trim();
    this.commands.set(cmd, {
      ...definition,
      command: cmd,
      allowedInDm: definition.allowedInDm ?? (definition.requiredRole === 'ORGANIZER'),
      allowedInGroup: definition.allowedInGroup ?? true,
    });
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
   * Evaluates message authorization, verifies group scope, and dispatches command.
   */
  public async handleMessage(message: NormalizedMessage): Promise<CommandResult | null> {
    const parsed = this.parseCommand(message);
    if (!parsed) {
      return null;
    }

    const { command, args, rawArgs } = parsed;
    const normalizedChatId = jidNormalizedUser(message.chat_id);
    const normalizedSender = message.sender_normalized_address;

    // 1. Group Scope Validation (FR-ID-005)
    // Commands and match reports must be accepted only in the configured central tournament group,
    // unless it is an explicitly allowed private DM with the organizer.
    const isCentralGroup = Boolean(this.centralGroupJid && normalizedChatId === this.centralGroupJid);
    const isAdminChat = Boolean(this.organizerJid && normalizedChatId === this.organizerJid);
    const isGroup = normalizedChatId.endsWith('@g.us');

    if (isGroup && !isCentralGroup) {
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

    // 2. Authorization Check (Role Resolution)
    let role: UserRole = 'UNKNOWN';
    let isOrganizer = false;

    // Check if sender is organizer (by JID match or phone digits)
    if (this.organizerJid && normalizedSender === this.organizerJid) {
      isOrganizer = true;
    } else if (this.organizerPhone) {
      const senderDigits = normalizedSender.split('@')[0]?.replace(/\D/g, '');
      if (senderDigits && senderDigits === this.organizerPhone) {
        isOrganizer = true;
      }
    }

    let delegateId: string | null = null;
    let teamId: string | null = null;

    if (isOrganizer) {
      role = 'ORGANIZER';
    } else {
      // Resolve delegate from database
      const resolution = await this.identityResolver.resolveIdentity(
        message.sender_raw_address,
        message.chat_id
      );

      if (resolution.status === 'VERIFIED' && resolution.delegate) {
        role = 'DELEGATE';
        delegateId = resolution.delegate.id;
        teamId = resolution.team?.id || null;
      }
    }

    // 3. Command Definition Lookup
    const definition = this.commands.get(command);
    if (!definition) {
      return {
        success: false,
        error: 'UNKNOWN_COMMAND',
        responseText: `Perintah *!${command}* tidak dikenali. Ketik *!help* untuk melihat daftar perintah.`,
      };
    }

    // 4. Validate DM vs Group Context
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

    // 5. Role-based Access Control
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
      description: 'Cek koneksi dan respon bot',
      allowedInDm: true,
      allowedInGroup: true,
      handler: () => ({
        success: true,
        responseText: '🏓 Pong! Bot Flash Peak TMS aktif.',
      }),
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
  }
}
