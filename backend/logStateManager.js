/**
 * LogStateManager — maintains app state in memory and processes the log file incrementally.
 *
 * Log format: YYYY-MM-DD HH:MM:SS - [IP]
 *   - IP present  → status "online"
 *   - IP absent   → status "offline", ip = null
 */

import { readFile, stat, open } from 'fs/promises';

// ─── Regex ────────────────────────────────────────────────────────────────────
// Captures: (1) timestamp, (2) everything after " -" (may be empty or just whitespace)
// Handles both "YYYY-MM-DD HH:MM:SS - 1.2.3.4" (online) and "YYYY-MM-DD HH:MM:SS -" (offline)
const LOG_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) -(.*)$/;

/**
 * Parse a single log line into a LogEntry.
 *
 * @param {string} line - Raw line from the log file.
 * @returns {{ timestamp: Date, ip: string|null, status: "online"|"offline", ipChanged: boolean }|null}
 *   Returns null (and emits console.warn) when the line does not match the expected format.
 */
export function parseLogLine(line) {
  const match = line.match(LOG_LINE_RE);

  if (!match) {
    console.warn(`[logStateManager] Invalid log line ignored: "${line}"`);
    return null;
  }

  const [, rawTimestamp, rawIp] = match;
  const timestamp = new Date(rawTimestamp);

  // Guard against timestamps that parsed to an invalid Date
  if (isNaN(timestamp.getTime())) {
    console.warn(`[logStateManager] Invalid timestamp in log line: "${line}"`);
    return null;
  }

  const trimmedIp = rawIp.trim();

  if (trimmedIp === '') {
    // Empty IP field → device was offline at this moment
    return {
      timestamp,
      ip: null,
      status: 'offline',
      ipChanged: false, // will be re-evaluated by LogStateManager when processing sequences
    };
  }

  // Non-empty IP field → device was online
  return {
    timestamp,
    ip: trimmedIp,
    status: 'online',
    ipChanged: false, // will be set to true by LogStateManager when IP differs from previous online entry
  };
}

// ─── Empty state factory ──────────────────────────────────────────────────────

/**
 * Returns a fresh empty AppState.
 * @returns {AppState}
 */
function createEmptyState() {
  return {
    entries: [],
    outages: [],
    currentStatus: 'offline',
    currentIp: null,
    lastUpdated: null,
    fileOffset: 0,
  };
}

// ─── LogStateManager ──────────────────────────────────────────────────────────

/**
 * Manages application state in memory, reading the log file on startup and
 * incrementally on each update.
 *
 * AppState shape:
 * {
 *   entries:       LogEntry[]        — all parsed log entries
 *   outages:       OutageEvent[]     — grouped offline periods (populated in task 5.1)
 *   currentStatus: "online"|"offline"
 *   currentIp:     string|null
 *   lastUpdated:   Date|null
 *   fileOffset:    number            — bytes already processed
 * }
 */
export class LogStateManager {
  constructor() {
    /** @type {string|null} */
    this._logFilePath = null;

    /** @type {AppState} */
    this._state = createEmptyState();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Initialize state by reading the entire log file.
   *
   * - If the file does not exist, AppState is set to empty (lastUpdated: null, fileOffset: 0).
   * - If the file exists, every line is parsed; fileOffset is set to the file size in bytes.
   *
   * @param {string} logFilePath - Absolute or relative path to the log file.
   * @returns {Promise<void>}
   */
  async initialize(logFilePath) {
    this._logFilePath = logFilePath;
    this._state = createEmptyState();

    // Check whether the file exists
    let fileSize = 0;
    try {
      const fileStat = await stat(logFilePath);
      fileSize = fileStat.size;
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File does not exist — start with empty state (Requirement 1.3)
        console.info(`[LogStateManager] Log file not found at "${logFilePath}". Starting with empty state.`);
        return;
      }
      // Re-throw unexpected errors (permissions, I/O, etc.)
      throw err;
    }

    // File exists — read and process all lines (Requirements 1.1, 1.2)
    const content = await readFile(logFilePath, 'utf8');
    const lines = content.split('\n');

    const entries = [];
    for (const line of lines) {
      const trimmed = line.trimEnd(); // normalise Windows-style \r\n
      if (trimmed === '') continue;   // skip blank lines

      const entry = parseLogLine(trimmed);
      if (entry !== null) {
        entries.push(entry);
      }
    }

    this._state.entries = entries;
    this._state.fileOffset = fileSize; // Requirement 1.2

    // Derive currentStatus, currentIp, lastUpdated from the last entry
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      this._state.currentStatus = last.status;
      this._state.currentIp = last.ip;
      this._state.lastUpdated = last.timestamp;
    }

    // Build outages from the fully-loaded entries (Requirement 5)
    this._rebuildOutages();
    // Detect IP changes across online entries (Requirements 4.5, 4.6)
    this._rebuildIpChanged();
  }

  /**
   * Returns the current AppState (read-only snapshot reference).
   *
   * @returns {AppState}
   */
  getState() {
    return this._state;
  }

  /**
   * Reads and processes only the new bytes added since the last read.
   *
   * - Detects file truncation (logrotate): if stat.size < fileOffset, reinitializes
   *   state from scratch by calling initialize() again. (Requirements 2.4, 16.1–16.3)
   * - Reads only the bytes from fileOffset to end of file. (Requirement 2.1)
   * - Updates fileOffset to the new file size after reading. (Requirements 2.2, 2.3)
   * - Parses each new line and appends valid entries to state. (Requirements 4.1–4.4)
   *
   * @returns {Promise<void>}
   */
  async processNewLines() {
    if (!this._logFilePath) return;

    // ── 1. Stat the file to get current size ─────────────────────────────────
    let fileStat;
    try {
      fileStat = await stat(this._logFilePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File disappeared — reset to empty state
        this._state = createEmptyState();
        return;
      }
      throw err;
    }

    // ── 2. Detect truncation (logrotate) ─────────────────────────────────────
    // Requirement 2.4 / 16.1–16.3
    if (fileStat.size < this._state.fileOffset) {
      console.info('[LogStateManager] File truncation detected (logrotate). Reinitializing state.');
      await this.initialize(this._logFilePath);
      return;
    }

    // ── 3. Nothing new to read ────────────────────────────────────────────────
    const bytesToRead = fileStat.size - this._state.fileOffset;
    if (bytesToRead === 0) return;

    // ── 4. Read only the new bytes ────────────────────────────────────────────
    // Requirement 2.1
    let newContent = '';
    const fileHandle = await open(this._logFilePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, this._state.fileOffset);
      newContent = buffer.slice(0, bytesRead).toString('utf8');
    } finally {
      await fileHandle.close();
    }

    // ── 5. Update fileOffset to new file size ─────────────────────────────────
    // Requirements 2.2, 2.3 — fileOffset can only grow (or stay equal) here
    this._state.fileOffset = fileStat.size;

    // ── 6. Parse the new lines ────────────────────────────────────────────────
    const lines = newContent.split('\n');

    for (const line of lines) {
      const trimmed = line.trimEnd(); // normalise Windows-style \r\n
      if (trimmed === '') continue;   // skip blank / partial lines without \n

      const entry = parseLogLine(trimmed);
      if (entry !== null) {
        this._state.entries.push(entry);
        // Update current status/ip/lastUpdated from this entry
        this._state.currentStatus = entry.status;
        this._state.currentIp = entry.ip;
        this._state.lastUpdated = entry.timestamp;
      }
    }

    // Rebuild outages from the updated entries (Requirement 5)
    this._rebuildOutages();
    // Detect IP changes across online entries (Requirements 4.5, 4.6)
    this._rebuildIpChanged();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Rebuild `this._state.outages` from scratch by scanning `this._state.entries`.
   *
   * Algorithm:
   *  - Walk entries left-to-right.
   *  - When an offline entry is found and no outage is open, open a new OutageEvent
   *    (set `start`, `entriesCount = 1`, `end = null`, `durationMinutes = null`).
   *  - When an offline entry continues an open outage, increment `entriesCount`.
   *  - When an online entry is found and an outage is open, close it:
   *    set `end` to this entry's timestamp and calculate `durationMinutes`.
   *  - After the loop, any still-open outage is pushed as-is (ongoing outage,
   *    `end` and `durationMinutes` remain `null` — Requirement 5.4).
   *
   * Requirements 5.1–5.6
   */
  _rebuildOutages() {
    const outages = [];
    let current = null; // the OutageEvent being built, or null

    for (const entry of this._state.entries) {
      if (entry.status === 'offline') {
        if (current === null) {
          // Start a new outage group (Requirement 5.2)
          current = {
            id: outages.length,      // sequential index (Requirement 5)
            start: entry.timestamp,
            end: null,               // Requirement 5.4
            durationMinutes: null,   // Requirement 5.4
            entriesCount: 1,         // Requirement 5.6
          };
        } else {
          // Continue the current outage group (Requirement 5.1)
          current.entriesCount += 1;
        }
      } else {
        // entry.status === 'online'
        if (current !== null) {
          // Close the outage: set end and compute duration (Requirement 5.3)
          current.end = entry.timestamp;
          current.durationMinutes = Math.round(
            (entry.timestamp - current.start) / 60000
          );
          outages.push(current);
          current = null;
        }
      }
    }

    // If an outage is still open at the end of the log, keep it as ongoing
    if (current !== null) {
      outages.push(current);
    }

    this._state.outages = outages;
  }

  /**
   * Rebuild `ipChanged` flags on all online entries by scanning `this._state.entries`.
   *
   * Algorithm:
   *  - Walk entries left-to-right, tracking `lastOnlineIp` (initially `null`).
   *  - For each online entry:
   *    - If `lastOnlineIp === null` → first online entry → set `ipChanged = false` (Requirement 4.6).
   *    - Else if `entry.ip !== lastOnlineIp` → IP changed → set `ipChanged = true` (Requirement 4.5).
   *    - Else → same IP → set `ipChanged = false`.
   *    - Update `lastOnlineIp = entry.ip`.
   *  - Offline entries are left with `ipChanged = false` (no meaningful IP change).
   *
   * Requirements 4.5, 4.6
   */
  _rebuildIpChanged() {
    let lastOnlineIp = null;

    for (const entry of this._state.entries) {
      if (entry.status === 'online') {
        if (lastOnlineIp === null) {
          // First online entry in history — no previous IP to compare (Requirement 4.6)
          entry.ipChanged = false;
        } else {
          // Subsequent online entry — compare against last seen online IP (Requirement 4.5)
          entry.ipChanged = entry.ip !== lastOnlineIp;
        }
        lastOnlineIp = entry.ip;
      } else {
        // Offline entries carry no IP change information
        entry.ipChanged = false;
      }
    }
  }
}
