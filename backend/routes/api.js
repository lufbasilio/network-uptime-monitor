/**
 * API routes for NextDNS Monitor.
 *
 * All routes read exclusively from the in-memory AppState via stateManager.getState()
 * — no I/O is performed per-request (Requirement 7.2).
 * All responses include Cache-Control: no-store (Requirements 7.3, 8.3, 9.4, 10.3).
 *
 * Routes:
 *   GET /api/status   — current status, IP, last updated, outages today, current outage duration
 *   GET /api/history  — full list of outage events
 *   GET /api/timeline — paginated log entries (newest first)
 *   GET /api/chart    — chart points + uptimePercent
 */

import { Router } from 'express';

/**
 * Create and return an Express Router with all API routes wired up.
 *
 * @param {import('../logStateManager.js').LogStateManager} stateManager
 * @returns {Router}
 */
export function createApiRouter(stateManager) {
  const router = Router();

  // ── Shared middleware: no-cache for all /api/* responses ──────────────────
  // Applied per-route below so each handler can also set it explicitly,
  // matching the per-requirement citations.

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/status
  // Requirements: 6.1, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store'); // Requirement 7.3

    const state = stateManager.getState();
    const now = new Date();

    // outagesToday: OutageEvents whose `start` date matches today's local date (Req 6.1)
    const todayStr = now.toLocaleDateString('en-CA'); // "YYYY-MM-DD" in local time
    const outagesToday = state.outages.filter((o) => {
      return o.start.toLocaleDateString('en-CA') === todayStr;
    }).length;

    // currentOutageDuration: minutes elapsed since the ongoing outage started (Req 6.4, 6.5)
    let currentOutageDuration = null;
    if (state.outages.length > 0) {
      const lastOutage = state.outages[state.outages.length - 1];
      if (lastOutage.end === null) {
        // Still ongoing — calculate elapsed minutes dynamically
        currentOutageDuration = Math.round((now - lastOutage.start) / 60000);
      }
    }

    /** @type {StatusResponse} */
    const body = {
      currentStatus: state.currentStatus,
      currentIp: state.currentIp,
      lastUpdated: state.lastUpdated ? state.lastUpdated.toISOString() : null, // Req 7.4
      outagesToday,
      currentOutageDuration,
    };

    res.json(body);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/history
  // Requirements: 8.1, 8.2, 8.3, 8.4
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/history', (req, res) => {
    res.set('Cache-Control', 'no-store'); // Requirement 8.3

    const state = stateManager.getState();

    // Serialize each OutageEvent — dates to ISO 8601 (Requirement 8.2)
    const outages = state.outages.map((o) => ({
      id: o.id,
      start: o.start.toISOString(),
      end: o.end ? o.end.toISOString() : null,
      durationMinutes: o.durationMinutes,
      entriesCount: o.entriesCount,
    }));

    /** @type {HistoryResponse} */
    const body = {
      outages,
      totalOutages: outages.length, // Requirement 8.4
    };

    res.json(body);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/timeline
  // Requirements: 9.1, 9.2, 9.3, 9.4
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/timeline', (req, res) => {
    res.set('Cache-Control', 'no-store'); // Requirement 9.4

    const state = stateManager.getState();

    // Pagination params (Requirement 9.2)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize, 10) || 50);

    // Optional date/time filters: from and to (ISO 8601 or datetime-local format)
    const fromParam = req.query.from;
    const toParam = req.query.to;
    const fromDate = fromParam ? new Date(fromParam) : null;
    const toDate = toParam ? new Date(toParam) : null;

    // Return newest entries first, applying date filter if provided
    let allEntries = [...state.entries].reverse();

    if (fromDate && !isNaN(fromDate.getTime())) {
      allEntries = allEntries.filter((e) => e.timestamp >= fromDate);
    }
    if (toDate && !isNaN(toDate.getTime())) {
      allEntries = allEntries.filter((e) => e.timestamp <= toDate);
    }

    const total = allEntries.length;

    const startIdx = (page - 1) * pageSize;
    const slice = allEntries.slice(startIdx, startIdx + pageSize);

    // Serialize timestamps to ISO 8601 (Requirement 9.3)
    const entries = slice.map((e) => ({
      timestamp: e.timestamp.toISOString(),
      status: e.status,
      ip: e.ip,
      ipChanged: e.ipChanged,
    }));

    /** @type {TimelineResponse} */
    const body = {
      entries,
      total,
      page,
      pageSize,
    };

    res.json(body);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/chart
  // Requirements: 6.2, 6.3, 10.1, 10.2, 10.3
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/chart', (req, res) => {
    res.set('Cache-Control', 'no-store'); // Requirement 10.3

    const state = stateManager.getState();

    // Filter entries from the last 24 hours only
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const entries = state.entries.filter((e) => e.timestamp >= cutoff);
    const total = entries.length;

    // uptimePercent: proportion of online entries (Req 6.2, 6.3)
    const uptimePercent =
      total === 0
        ? 0
        : Math.round(
            (entries.filter((e) => e.status === 'online').length / total) * 100
          );
    // Clamp to [0, 100] for safety (Requirement 6.3)
    const clampedUptime = Math.min(100, Math.max(0, uptimePercent));

    // Group entries by hour for a cleaner chart (max ~48 bars for 48h)
    const hourBuckets = new Map();
    for (const e of entries) {
      const d = e.timestamp;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
      if (!hourBuckets.has(key)) {
        hourBuckets.set(key, { online: 0, total: 0, timestamp: d });
      }
      const bucket = hourBuckets.get(key);
      bucket.total++;
      if (e.status === 'online') bucket.online++;
    }

    // Map hour buckets to chart points — status is "offline" if ANY entry in that hour was offline
    const points = Array.from(hourBuckets.entries()).map(([key, bucket]) => {
      const d = bucket.timestamp;
      const hh = String(d.getHours()).padStart(2, '0');
      // If any entry in the hour was offline, mark the whole hour as offline
      const hasOffline = bucket.online < bucket.total;
      return {
        timestamp: d.toISOString(),
        status: hasOffline ? 'offline' : 'online',
        label: `${hh}:00`,
      };
    });

    /** @type {ChartResponse} */
    const body = {
      points,
      uptimePercent: clampedUptime, // Requirement 6.3
    };

    res.json(body);
  });

    // ─────────────────────────────────────────────────────────────────────────
  // GET /api/ip-history
  // Returns deduplicated list of IPs seen in the last 7 days (one entry per IP change)
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/ip-history', (req, res) => {
    res.set('Cache-Control', 'no-store');

    const state = stateManager.getState();

    // Deduplicate by IP change across all entries (no time filter — server time may differ from log time)
    const ipChanges = [];
    let lastIp = null;
    for (const e of state.entries) {
      if (e.status === 'online' && e.ip !== lastIp) {
        ipChanges.push({ ip: e.ip, since: e.timestamp.toISOString() });
        lastIp = e.ip;
      }
    }

    // Return most recent first, capped at last 50 changes
    const recent = ipChanges.slice(-50).reverse();
    res.json({ ipHistory: recent, total: recent.length });
  });

  return router;
}
