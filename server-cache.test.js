const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");

const POST = { method: "POST" };

async function startApp(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myprs-api-cache-test-"));
  if (saved) fs.writeFileSync(path.join(dir, "pr-cache.json"), JSON.stringify(saved));
  // A refresh is exactly one `gh pr list` per enabled repo; the account-wide
  // search is only reachable from the settings panel.
  const listings = [];
  const gh = [];
  const sandbox = {
    module: { exports: {} }, __dirname: dir,
    console: { ...console, error() {} },
    process: { ...process, env: {} },
    require(name) {
      if (name !== "child_process") return require(name);
      return { execFile(command, args, options, callback) {
        assert.equal(command, "gh", "Tests must not send notifications");
        assert.notEqual(args[0], "search", "A refresh must not spend the search rate limit");
        gh.push(options);
        if (args[1] === "list") listings.push(callback);
        else if (args[1] === "view") callback(null, JSON.stringify({ comments: [] }));
        else assert.fail(`Unexpected gh arguments: ${args.join(" ")}`);
      } };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "server.js"), "utf8"), sandbox);
  const app = sandbox.module.exports.app;
  const server = app.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  return { app, listings, gh, dir, sandbox, url: `http://127.0.0.1:${server.address().port}` };
}

test("a new device can read an empty server cache without starting a GitHub refresh", async (t) => {
  const { url, listings } = await startApp(t);
  const response = await fetch(`${url}/api/prs/cache`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.json(), null);
  assert.equal(listings.length, 0);
});

test("devices share the saved snapshot immediately and a single fresh response afterward", { timeout: 5000 }, async (t) => {
  const saved = { prs: [{ number: 6, title: "Previously shown on desktop" }], at: 1234 };
  const { url, app, listings } = await startApp(t, saved);
  const route = app._router.stack.find(layer => layer.route?.path === "/api/prs").route.stack[0];
  const refreshHandler = route.handle;
  let incoming = 0;
  // Socket arrival precedes asynchronous static middleware. Wait until both
  // handlers are actually awaiting the shared refresh before releasing it.
  const bothRefreshing = new Promise(resolve => {
    route.handle = (req, res, next) => {
      const response = refreshHandler(req, res, next);
      if (++incoming === 2) resolve();
      return response;
    };
  });

  const desktop = fetch(`${url}/api/prs`, POST);
  const phone = fetch(`${url}/api/prs`, POST);
  await bothRefreshing;
  assert.equal(listings.length, 1);
  const duringRefresh = await (await fetch(`${url}/api/prs/cache`)).json();
  assert.deepEqual(duringRefresh, { ...saved, nextRefreshAt: 0, refreshFailure: null, sleep: {}, authError: false });

  listings[0](null, JSON.stringify([{
    number: 7, title: "New GitHub result", isDraft: true, reviews: [], reviewRequests: [],
  }]));
  const [desktopResponse, phoneResponse] = await Promise.all([desktop, phone]);
  const desktopRows = await desktopResponse.json();
  assert.equal(desktopResponse.status, 200);
  assert.deepEqual(await phoneResponse.json(), desktopRows);
  assert.equal(desktopRows[0].number, 7);
  const at = Number(desktopResponse.headers.get("X-PRs-Updated-At"));
  assert.ok(at > saved.at);
  assert.equal(Number(phoneResponse.headers.get("X-PRs-Updated-At")), at);
  assert.deepEqual(await (await fetch(`${url}/api/prs/cache`)).json(), {
    prs: desktopRows, at, nextRefreshAt: at + 60 * 60 * 1000, refreshFailure: null, sleep: {}, authError: false,
  });

  // Sleep state is shared immediately, without a second GitHub refresh.
  const sleep = await (await fetch(`${url}/api/sleep`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: ["pytorch/pytorch#7"], days: 1 }),
  })).json();
  assert.deepEqual((await (await fetch(`${url}/api/prs/cache`)).json()).sleep, sleep);
  assert.equal(listings.length, 1);
});

test("a recent snapshot is reused, and changing repositories forces a fresh query", { timeout: 5000 }, async (t) => {
  const saved = { prs: [{ number: 6, title: "Fetched moments ago" }], at: Date.now(), fingerprint: "pytorch/pytorch" };
  const { url, listings, sandbox } = await startApp(t, saved);

  // A restart doesn't re-query GitHub for a snapshot from this hour.
  await sandbox.module.exports.refreshWhenDue();
  assert.deepEqual((await (await fetch(`${url}/api/prs/cache`)).json()).prs, saved.prs);
  assert.equal(listings.length, 0);

  const repos = await (await fetch(`${url}/api/repos`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: ["pytorch/pytorch", "owner/extra"] }),
  })).json();
  assert.deepEqual(repos, {
    enabled: ["owner/extra", "pytorch/pytorch"],
    known: ["owner/extra", "pytorch/pytorch"],
  });

  // The snapshot is now wrong rather than merely stale, so it must not be served.
  const refreshed = fetch(`${url}/api/prs`, POST);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(listings.length, 2, "both enabled repositories are queried");
  for (const send of listings) send(null, JSON.stringify([]));
  assert.deepEqual(await (await refreshed).json(), []);
});

test("rejecting a repository list keeps the stored settings untouched", async (t) => {
  const { url } = await startApp(t);
  const response = await fetch(`${url}/api/repos`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: "pytorch/pytorch" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await (await fetch(`${url}/api/repos`)).json(), {
    enabled: ["pytorch/pytorch"], known: ["pytorch/pytorch"],
  });
});

test("a snapshot from other repositories is shown but never counts as fresh", { timeout: 5000 }, async (t) => {
  // What a restart finds after the tracked repositories changed, or after an
  // older version wrote the file: recent, so the throttle would otherwise
  // serve it, but describing repos that are no longer tracked.
  const saved = { prs: [{ number: 6, title: "From a repo we stopped tracking" }], at: Date.now() };
  const { url, listings } = await startApp(t, saved);

  // Still shown, because it beats a blank dashboard while GitHub is queried.
  assert.deepEqual((await (await fetch(`${url}/api/prs/cache`)).json()).prs, saved.prs);

  const refreshed = fetch(`${url}/api/prs`, POST);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(listings.length, 1, "the stale snapshot must not satisfy the refresh");
  listings[0](null, JSON.stringify([]));
  assert.deepEqual(await (await refreshed).json(), []);
});

test("the Refresh button reaches GitHub even inside the hourly window", { timeout: 5000 }, async (t) => {
  const { url, listings, sandbox } = await startApp(t);
  const first = fetch(`${url}/api/prs`, POST);
  await new Promise(resolve => setTimeout(resolve, 50));
  listings[0](null, JSON.stringify([]));
  await first;

  // The hourly schedule leaves the snapshot alone...
  await sandbox.module.exports.refreshWhenDue();
  assert.equal(listings.length, 1);

  // ...but a click always fetches.
  const clicked = fetch(`${url}/api/prs`, POST);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(listings.length, 2);
  listings[1](null, JSON.stringify([]));
  assert.equal((await clicked).status, 200);
});

test("loading or reloading the page cannot refresh from GitHub", async (t) => {
  const { url, listings } = await startApp(t);
  assert.equal((await fetch(`${url}/api/prs`)).status, 404);
  assert.equal((await fetch(`${url}/api/prs/cache`)).status, 200);
  assert.equal(listings.length, 0);
});

test("clients learn when the next refresh can reach GitHub", { timeout: 5000 }, async (t) => {
  const { url, listings } = await startApp(t);
  const before = Date.now();
  const refreshed = fetch(`${url}/api/prs`, POST);
  await new Promise(resolve => setTimeout(resolve, 50));
  listings[0](null, JSON.stringify([]));
  const response = await refreshed;
  const updatedAt = Number(response.headers.get("X-PRs-Updated-At"));
  const nextAt = Number(response.headers.get("X-PRs-Next-Refresh-At"));
  assert.ok(updatedAt >= before);
  assert.equal(nextAt, updatedAt + 60 * 60 * 1000);
  assert.equal((await (await fetch(`${url}/api/prs/cache`)).json()).nextRefreshAt, nextAt);
});

test("the hourly schedule refreshes only once the hour has passed", { timeout: 5000 }, async (t) => {
  const { url, listings, sandbox } = await startApp(t, {
    prs: [], at: Date.now(), fingerprint: "pytorch/pytorch",
  });
  const { refreshWhenDue } = sandbox.module.exports;

  // A snapshot from this hour is left alone.
  await refreshWhenDue();
  assert.equal(listings.length, 0);

  // Changing repos makes it due immediately, and checks while it runs join it.
  await fetch(`${url}/api/repos`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: ["pytorch/pytorch"] }),
  });
  const scheduled = refreshWhenDue();
  refreshWhenDue();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(listings.length, 1);
  listings[0](null, JSON.stringify([]));
  await scheduled;
  await refreshWhenDue();
  assert.equal(listings.length, 1);
});

test("gh uses a private cache that a rate-limit error clears, and the failure is shown", { timeout: 5000 }, async (t) => {
  const { url, listings, gh, dir } = await startApp(t, {
    prs: [], at: 1, fingerprint: "pytorch/pytorch",
  });
  const cacheDir = path.join(dir, ".gh-cache");
  fs.mkdirSync(path.join(cacheDir, "gh"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "gh", "poisoned"), "API rate limit already exceeded");

  const refreshed = fetch(`${url}/api/prs`, POST);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(gh[0].env.XDG_CACHE_HOME, cacheDir);
  const error = new Error("Command failed: gh pr list\nGraphQL: API rate limit already exceeded for user ID 1.\n");
  listings[0](error, "");
  assert.equal((await refreshed).status, 500);
  assert.equal(fs.existsSync(cacheDir), false);

  const { refreshFailure } = await (await fetch(`${url}/api/prs/cache`)).json();
  assert.match(refreshFailure.message, /rate limit already exceeded/);
  assert.ok(refreshFailure.at > 1);

  // The Refresh button can retry immediately; only the schedule backs off.
  const retried = fetch(`${url}/api/prs`, POST);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(listings.length, 2);
  listings[1](null, JSON.stringify([]));
  assert.equal((await retried).status, 200);
  assert.equal((await (await fetch(`${url}/api/prs/cache`)).json()).refreshFailure, null);
});
