const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPrCache } = require("./pr-cache");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myprs-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "prs.json") };
}

// The persisted settings fingerprint is covered by the server tests; these
// assertions are about the snapshot itself.
function readSnapshot(file) {
  const { fingerprint, ...snapshot } = JSON.parse(fs.readFileSync(file, "utf8"));
  return snapshot;
}

test("a missing cache starts empty without fetching or writing", (t) => {
  const { file } = fixture(t);
  let fetches = 0;
  const cache = createPrCache({ file, fetchPrs: async () => { fetches++; return []; } });

  assert.equal(cache.getSnapshot(), null);
  assert.equal(fetches, 0);
  assert.equal(fs.existsSync(file), false);
});

test("corrupt files and invalid snapshot shapes are ignored", (t) => {
  const { file } = fixture(t);
  for (const contents of [
    "", "{unfinished", "null", "[]", "{}",
    '{"prs":{},"at":100}', '{"prs":[],"at":0}',
    '{"prs":[],"at":-1}', '{"prs":[],"at":"100"}',
    '{"prs":[],"at":null}', '{"prs":[],"at":1e400}',
    '{"prs":[]}', '{"at":100}',
  ]) {
    fs.writeFileSync(file, contents);
    const cache = createPrCache({ file, fetchPrs: async () => assert.fail("Unexpected fetch") });
    assert.equal(cache.getSnapshot(), null, contents);
    assert.equal(fs.readFileSync(file, "utf8"), contents);
  }
});

test("a valid persisted snapshot is available immediately without refreshing its timestamp", (t) => {
  const { file } = fixture(t);
  const saved = { prs: [{ number: 197277, ciStatus: "green" }], at: 1234 };
  fs.writeFileSync(file, JSON.stringify(saved));
  const cache = createPrCache({
    file, now: () => 9999, fetchPrs: async () => assert.fail("Unexpected fetch"),
  });

  assert.deepEqual(cache.getSnapshot(), saved);
  assert.deepEqual(readSnapshot(file), saved);
});

test("concurrent refreshes share one fetch and publish its completion time for future clients", async (t) => {
  const { dir, file } = fixture(t);
  const saved = { prs: [{ number: 1 }], at: 100 };
  fs.writeFileSync(file, JSON.stringify(saved));
  let fetches = 0;
  let time = 200;
  let finishFetch;
  const pending = new Promise(resolve => { finishFetch = resolve; });
  const cache = createPrCache({
    file, now: () => time,
    fetchPrs: () => { fetches++; return pending; },
  });

  const first = cache.refresh();
  const second = cache.refresh();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(fetches, 1);
  assert.deepEqual(cache.getSnapshot(), saved);
  assert.deepEqual(readSnapshot(file), saved);

  time = 300;
  const fresh = [{ number: 2, claudeReviewStatus: "green" }];
  finishFetch(fresh);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  const expected = { prs: fresh, at: 300 };
  assert.strictEqual(firstResult, secondResult);
  assert.deepEqual(firstResult, expected);
  assert.deepEqual(cache.getSnapshot(), expected);
  assert.deepEqual(readSnapshot(file), expected);
  assert.deepEqual(fs.readdirSync(dir), ["prs.json"]);

  const restarted = createPrCache({ file, fetchPrs: async () => assert.fail("Unexpected fetch") });
  assert.deepEqual(restarted.getSnapshot(), expected);
});

test("an empty PR list is a successful snapshot that survives restart", async (t) => {
  const { file } = fixture(t);
  const cache = createPrCache({ file, fetchPrs: async () => [], now: () => 400 });
  const expected = { prs: [], at: 400 };

  assert.deepEqual(await cache.refresh(), expected);
  assert.deepEqual(cache.getSnapshot(), expected);
  assert.deepEqual(readSnapshot(file), expected);
  assert.deepEqual(createPrCache({ file, fetchPrs: async () => [] }).getSnapshot(), expected);
});

test("a refresh after successful completion fetches again and advances the shared snapshot", async (t) => {
  const { file } = fixture(t);
  let fetches = 0;
  const cache = createPrCache({
    file, fetchPrs: async () => [{ number: ++fetches }], now: () => fetches * 100,
  });

  assert.deepEqual(await cache.refresh(), { prs: [{ number: 1 }], at: 100 });
  const expected = { prs: [{ number: 2 }], at: 200 };
  assert.deepEqual(await cache.refresh(), expected);
  assert.equal(fetches, 2);
  assert.deepEqual(cache.getSnapshot(), expected);
  assert.deepEqual(readSnapshot(file), expected);
});

test("fetch failure preserves the previous snapshot and file, and the next refresh can retry", async (t) => {
  const { file } = fixture(t);
  const saved = { prs: [{ number: 1 }], at: 100 };
  const contents = JSON.stringify(saved, null, 2);
  fs.writeFileSync(file, contents);
  let fetches = 0;
  const cache = createPrCache({
    file, now: () => 500,
    fetchPrs: async () => {
      if (++fetches === 1) throw new Error("GitHub unavailable");
      return [{ number: 2 }];
    },
  });

  await assert.rejects(cache.refresh(), /GitHub unavailable/);
  assert.deepEqual(cache.getSnapshot(), saved);
  assert.equal(fs.readFileSync(file, "utf8"), contents);
  const expected = { prs: [{ number: 2 }], at: 500 };
  assert.deepEqual(await cache.refresh(), expected);
  assert.equal(fetches, 2);
  assert.deepEqual(cache.getSnapshot(), expected);
  assert.deepEqual(readSnapshot(file), expected);
});

test("invalid fetched data cannot replace a successful snapshot", async (t) => {
  const { file } = fixture(t);
  const saved = { prs: [], at: 100 };
  fs.writeFileSync(file, JSON.stringify(saved));
  for (const invalid of [null, undefined, {}, "not a PR array"]) {
    const cache = createPrCache({ file, fetchPrs: async () => invalid, now: () => 600 });
    await assert.rejects(cache.refresh(), TypeError);
    assert.deepEqual(cache.getSnapshot(), saved);
    assert.deepEqual(readSnapshot(file), saved);
  }
});

test("persistence failure reports an error while fresh data remains shared in memory", async (t) => {
  const { file } = fixture(t);
  // A directory at the destination makes rename fail even when running as root.
  fs.mkdirSync(file);
  const errors = [];
  const cache = createPrCache({
    file, fetchPrs: async () => [{ number: 3 }], now: () => 700,
    onError: (...args) => errors.push(args),
  });

  const expected = { prs: [{ number: 3 }], at: 700 };
  assert.deepEqual(await cache.refresh(), expected);
  assert.deepEqual(cache.getSnapshot(), expected);
  assert.equal(errors.length, 1);
  assert.ok(fs.statSync(file).isDirectory());
});

test("failures back off exponentially without contacting GitHub, and success resets the delay", async (t) => {
  const { file } = fixture(t);
  let time = 1000;
  let fetches = 0;
  let failing = true;
  const cache = createPrCache({
    file, now: () => time, retryBaseMs: 100, maxRetryMs: 300,
    fetchPrs: async () => {
      fetches++;
      if (failing) throw new Error("API rate limit already exceeded");
      return [];
    },
  });

  await assert.rejects(cache.refresh(), /rate limit/);
  // Polling inside the backoff window reports the failure without fetching.
  time = 1099;
  await assert.rejects(cache.refresh(), /Not retrying GitHub until .* rate limit/);
  assert.equal(fetches, 1);

  // Each further failure doubles the wait, up to the cap.
  time = 1100;
  await assert.rejects(cache.refresh(), /rate limit/);
  time = 1299;
  await assert.rejects(cache.refresh(), /Not retrying/);
  time = 1300;
  await assert.rejects(cache.refresh(), /rate limit/);
  time = 1599;
  await assert.rejects(cache.refresh(), /Not retrying/);
  time = 1600;
  await assert.rejects(cache.refresh(), /rate limit/);
  time = 1899;
  await assert.rejects(cache.refresh(), /Not retrying/);
  assert.equal(fetches, 4);

  // Success resets the delay.
  failing = false;
  time = 1900;
  assert.deepEqual(await cache.refresh(), { prs: [], at: 1900 });
  failing = true;
  time = 2000;
  await assert.rejects(cache.refresh(), /rate limit/);
  time = 2099;
  await assert.rejects(cache.refresh(), /Not retrying/);
  time = 2100;
  await assert.rejects(cache.refresh(), /rate limit/);
  assert.equal(fetches, 7);
});

test("changing settings retries immediately despite a failure backoff", async (t) => {
  const { file } = fixture(t);
  let fetches = 0;
  const cache = createPrCache({
    file, now: () => 0, retryBaseMs: 100,
    fetchPrs: async () => { if (++fetches === 1) throw new Error("Not found"); return []; },
  });

  await assert.rejects(cache.refresh(), /Not found/);
  cache.invalidate();
  assert.deepEqual(await cache.refresh(), { prs: [], at: 0 });
  assert.equal(fetches, 2);
});

test("invalid fetched data also backs off", async (t) => {
  const { file } = fixture(t);
  let fetches = 0;
  const cache = createPrCache({
    file, now: () => 0, retryBaseMs: 100, fetchPrs: async () => { fetches++; return null; },
  });

  await assert.rejects(cache.refresh(), TypeError);
  await assert.rejects(cache.refresh(), /Not retrying/);
  assert.equal(fetches, 1);
});

test("next refresh times and the last failure track success, failure and settings changes", async (t) => {
  const { file } = fixture(t);
  let time = 1000;
  let failing = false;
  const cache = createPrCache({
    file, now: () => time, minIntervalMs: 500, retryBaseMs: 100,
    fetchPrs: async () => { if (failing) throw new Error("down"); return []; },
  });

  assert.equal(cache.nextRefreshAt(), 0);
  await cache.refresh();
  assert.equal(cache.nextRefreshAt(), 1500);
  assert.equal(cache.lastFailure(), null);
  time = 1500;
  failing = true;
  await assert.rejects(cache.refresh(), /down/);
  // The automatic schedule waits out the backoff.
  assert.equal(cache.nextRefreshAt(), 1600);
  assert.deepEqual(cache.lastFailure(), { at: 1500, message: "down" });
  cache.invalidate();
  assert.equal(cache.nextRefreshAt(), 0);
  failing = false;
  await cache.refresh();
  assert.equal(cache.lastFailure(), null);
});

test("a manual refresh retries during the failure backoff", async (t) => {
  const { file } = fixture(t);
  let fetches = 0;
  const cache = createPrCache({
    file, now: () => 0, retryBaseMs: 100,
    fetchPrs: async () => { if (++fetches === 1) throw new Error("down"); return []; },
  });

  await assert.rejects(cache.refresh(), /down/);
  await assert.rejects(cache.refresh(), /Not retrying/);
  assert.deepEqual(await cache.refresh({ manual: true }), { prs: [], at: 0 });
  assert.equal(fetches, 2);
});

test("a manual refresh reaches GitHub even while the snapshot is fresh", async (t) => {
  const { file } = fixture(t);
  let fetches = 0;
  const cache = createPrCache({
    file, now: () => 0, minIntervalMs: 1000, fetchPrs: async () => [{ number: ++fetches }],
  });

  await cache.refresh();
  assert.deepEqual(await cache.refresh(), { prs: [{ number: 1 }], at: 0 });
  assert.deepEqual(await cache.refresh({ manual: true }), { prs: [{ number: 2 }], at: 0 });
  assert.equal(fetches, 2);
});
