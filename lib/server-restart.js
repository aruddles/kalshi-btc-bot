'use strict';
// Dashboard "Restart" support. The server writes a marker, exits, and the
// run-forever loop (npm run forever) starts it again with the latest code.
// The marker records whether the bot was trading so it resumes automatically.
// LIVE mode is never restarted or auto-started from here.
const fs = require('fs');
const path = require('path');

const MARKER_MAX_AGE_MS = 5 * 60 * 1000;

function markerPath(dataDir) { return path.join(dataDir, '.restart-autostart.json'); }

function canRestart(mode) {
  return mode === 'live' ? { ok: false, error: 'restart_disabled_in_live_mode' } : { ok: true };
}

function writeMarker(dataDir, { running, mode }, now = Date.now()) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(markerPath(dataDir), JSON.stringify({ running: !!running, mode, at: now }));
}

// Reads and removes the marker. Returns true only for a fresh marker written
// while the bot was running in a non-live mode, and only if still non-live.
function consumeAutostart(dataDir, currentMode, now = Date.now()) {
  const file = markerPath(dataDir);
  let m = null;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }
  try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
  if (!m || !m.running || m.mode === 'live' || currentMode === 'live') return false;
  return Number.isFinite(m.at) && now - m.at >= 0 && now - m.at <= MARKER_MAX_AGE_MS;
}

module.exports = { MARKER_MAX_AGE_MS, markerPath, canRestart, writeMarker, consumeAutostart };
