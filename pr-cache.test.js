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

function readSnapshot(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
