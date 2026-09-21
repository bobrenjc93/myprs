const fs = require("fs");

// One shared snapshot and one refresh at a time, regardless of which device
// asked for it. A failed refresh leaves the last successful result available.
function createPrCache({ file, fetchPrs, now = Date.now, onError = console.error }) {
  let snapshot = null;
  let inFlight = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved?.prs) && Number.isFinite(saved.at) && saved.at > 0) {
      snapshot = { prs: saved.prs, at: saved.at };
    }
  } catch {
    // The first visit still works when no cache exists or a file is corrupt.
  }

  function refresh() {
    if (!inFlight) {
      inFlight = Promise.resolve().then(fetchPrs).then(prs => {
        if (!Array.isArray(prs)) throw new TypeError("Expected a PR array");
        snapshot = { prs, at: now() };
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

  return { getSnapshot: () => snapshot, refresh };
}

module.exports = { createPrCache };
