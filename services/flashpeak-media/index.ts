export * from './config.js';
export * from './db.js';
export * from './storage.js';
export * from './detector.js';
export * from './security.js';
export * from './server.js';

import { createMediaServer } from './server.js';

export async function startMediaService() {
  const mediaServer = createMediaServer();
  const info = await mediaServer.start();
  console.log(`[flashpeak-media] Server running at http://${info.host}:${info.port}`);
  return mediaServer;
}

// Allow direct CLI execution if run directly via node/tsx
if (process.argv[1]?.endsWith('services/flashpeak-media/index.ts') || process.argv[1]?.endsWith('services/flashpeak-media/index.js')) {
  startMediaService().catch((err) => {
    console.error('[flashpeak-media] Failed to start:', err);
    process.exit(1);
  });
}
