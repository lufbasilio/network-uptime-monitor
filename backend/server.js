import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LogStateManager } from './logStateManager.js';
import { FileWatcher } from './fileWatcher.js';
import { createApiRouter } from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Environment config ─────────────────────────────────────────────────────
const LOG_FILE_PATH = process.env.LOG_FILE_PATH;
const PORT = parseInt(process.env.PORT) || 3000;

// Reject initialization if LOG_FILE_PATH is not set (Requirement 15.3)
if (!LOG_FILE_PATH) {
  console.error('[server] ERROR: LOG_FILE_PATH environment variable is not set. Exiting.');
  process.exit(1);
}

// ── Setup ──────────────────────────────────────────────────────────────────
const app = express();
const stateManager = new LogStateManager();
const watcher = new FileWatcher();

// ── Initialize and start watching ─────────────────────────────────────────
await stateManager.initialize(LOG_FILE_PATH);

watcher.start(LOG_FILE_PATH, async () => {
  await stateManager.processNewLines();
});

// ── Routes ─────────────────────────────────────────────────────────────────
// API routes at /api/*
app.use('/api', createApiRouter(stateManager));

// Serve static files from frontend/ (Requirement 11.2)
const frontendDir = join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// Serve index.html for GET / (Requirement 11.1)
app.get('/', (req, res) => {
  res.sendFile(join(frontendDir, 'index.html'));
});

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Network Monitor listening on http://localhost:${PORT}`);
  console.log(`[server] Watching log file: ${LOG_FILE_PATH}`);
});
