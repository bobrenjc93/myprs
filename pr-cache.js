const fs = require("fs");

// One shared snapshot and one refresh at a time, regardless of which device
// asked for it. A failed refresh leaves the last successful result available.
// `minIntervalMs` additionally caps how often GitHub is contacted: refreshes
// requested inside that window reuse the snapshot, so extra tabs, devices and
// tab-focus events cost nothing instead of multiplying the API calls.
function createPrCache({ file, fetchPrs, now = Date.now, onError = console.error, minIntervalMs = 0 }) {
  let snapshot = null;
  let inFlight = null;
  let freshUntil = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved?.prs) && Number.isFinite(saved.at) && saved.at > 0) {
      snapshot = { prs: saved.prs, at: saved.at };
      // A restart must not re-query GitHub for a snapshot that is still fresh.
      freshUntil = snapshot.at + minIntervalMs;
    }
  } catch {
    // The first visit still works when no cache exists or a file is corrupt.
  }

  function refresh() {
    if (snapshot && now() < freshUntil) return Promise.resolve(snapshot);
    if (!inFlight) {
      inFlight = Promise.resolve().then(fetchPrs).then(prs => {
        if (!Array.isArray(prs)) throw new TypeError("Expected a PR array");
        snapshot = { prs, at: now() };
        freshUntil = snapshot.at + minIntervalMs;
        try {
          // Rename only after a complete write so a restart cannot read half
          // of a snapshot. Keep serving fresh data if persistence fails.
          fs.writeFileSync(`${file}.tmp`, JSON.stringify(snapshot));
          fs.renameSync(`${file}.tmp`, file);
        } catch (error) {
          onError("PR cache could not be saved:", error.message);
        }
        return snapshot;
      }).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  // Changing which repositories are tracked makes the snapshot wrong rather
  // than merely stale, so the next refresh must reach GitHub immediately.
  function invalidate() {
    freshUntil = 0;
  }

  return { getSnapshot: () => snapshot, refresh, invalidate };
}

module.exports = { createPrCache };
