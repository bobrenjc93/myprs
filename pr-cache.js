const fs = require("fs");

// One shared snapshot and one refresh at a time, regardless of which device
// asked for it. A failed refresh leaves the last successful result available.
// `minIntervalMs` caps how often GitHub is contacted: every refresh requested
// inside that window — from any tab, device, focus event or Refresh click —
// reuses the snapshot instead of multiplying the API calls.
// `fingerprint` describes the settings a snapshot was produced under. A
// snapshot recorded under different settings is wrong rather than merely
// stale, so it is still shown — beating a blank dashboard — but never counts
// as fresh, which also discards snapshots written by an older version.
// A failed refresh backs off exponentially from `retryBaseMs` up to
// `maxRetryMs`. Retrying while GitHub is rate limiting the account only
// spends the requests that would otherwise let it recover.
function createPrCache({
  file, fetchPrs, now = Date.now, onError = console.error,
  minIntervalMs = 0, fingerprint = () => "",
  retryBaseMs = minIntervalMs, maxRetryMs = Math.max(retryBaseMs, 15 * 60 * 1000),
}) {
  let snapshot = null;
  let inFlight = null;
  let freshUntil = 0;
  let retryDelay = 0;
  let retryAt = 0;
  let lastError = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved?.prs) && Number.isFinite(saved.at) && saved.at > 0) {
      snapshot = { prs: saved.prs, at: saved.at };
      // A restart must not re-query GitHub for a snapshot that is still fresh.
      if (saved.fingerprint === fingerprint()) freshUntil = snapshot.at + minIntervalMs;
    }
  } catch {
    // The first visit still works when no cache exists or a file is corrupt.
  }

  function refresh() {
    if (snapshot && now() < freshUntil) return Promise.resolve(snapshot);
    if (!inFlight) {
      if (now() < retryAt) {
        return Promise.reject(new Error(
          `Not retrying GitHub until ${new Date(retryAt).toLocaleTimeString()} after: ${lastError.message}`,
        ));
      }
      inFlight = Promise.resolve().then(fetchPrs).then(prs => {
        if (!Array.isArray(prs)) throw new TypeError("Expected a PR array");
        snapshot = { prs, at: now() };
        freshUntil = snapshot.at + minIntervalMs;
        retryDelay = 0;
        retryAt = 0;
        try {
          // Rename only after a complete write so a restart cannot read half
          // of a snapshot. Keep serving fresh data if persistence fails.
          fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...snapshot, fingerprint: fingerprint() }));
          fs.renameSync(`${file}.tmp`, file);
        } catch (error) {
          onError("PR cache could not be saved:", error.message);
        }
        return snapshot;
      }).catch(error => {
        retryDelay = Math.min(maxRetryMs, retryDelay ? retryDelay * 2 : retryBaseMs);
        retryAt = now() + retryDelay;
        lastError = error;
        throw error;
      }).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  // Changing which repositories are tracked makes the snapshot wrong rather
  // than merely stale, so the next refresh must reach GitHub immediately,
  // even if the previous settings' query was failing.
  function invalidate() {
    freshUntil = 0;
    retryAt = 0;
  }

  // The earliest time a refresh will contact GitHub rather than reuse the
  // snapshot or report the last failure.
  function nextRefreshAt() {
    return Math.max(snapshot ? freshUntil : 0, retryAt);
  }

  return { getSnapshot: () => snapshot, refresh, invalidate, nextRefreshAt };
}

module.exports = { createPrCache };
