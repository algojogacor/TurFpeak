import path from 'node:path';

export interface MediaServerConfig {
  port: number;
  host: string;
  storageRoot: string;
  quotaBytes: number;
  maxFileSize: number;
  hmacSecret: string;
  allowedMimes: string[];
}

export const MEDIA_ROLE_DIRS: Record<string, string> = {
  MAIN_MATCH: 'private/match_evidence',
  GOALKEEPER_DETAIL: 'private/goalkeeper_detail',
  SUPPORTING_EVIDENCE: 'private/supporting',
  MANUAL_REVIEW: 'private/manual_review',
  OTHER: 'private/supporting',
};

export function getDefaultConfig(): MediaServerConfig {
  return {
    port: parseInt(process.env.FLASHPEAK_MEDIA_PORT || '4189', 10),
    host: process.env.FLASHPEAK_MEDIA_HOST || '127.0.0.1',
    storageRoot: process.env.FLASHPEAK_MEDIA_STORAGE_ROOT || path.resolve(process.cwd(), 'data/flashpeak-media'),
    quotaBytes: parseInt(process.env.FLASHPEAK_MEDIA_QUOTA_BYTES || String(5 * 1024 * 1024 * 1024), 10), // 5 GB default
    maxFileSize: parseInt(process.env.FLASHPEAK_MEDIA_MAX_FILE_SIZE || String(10 * 1024 * 1024), 10), // 10 MB default
    hmacSecret: process.env.FLASHPEAK_MEDIA_SECRET || '',
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
  };
}
