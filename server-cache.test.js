const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");

async function startApp(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myprs-api-cache-test-"));
  if (saved) fs.writeFileSync(path.join(dir, "pr-cache.json"), JSON.stringify(saved));
  const searches = [];
  const sandbox = {
    module: { exports: {} }, __dirname: dir,
    console: { ...console, error() {} },
    require(name) {
      if (name !== "child_process") return require(name);
      return { execFile(command, args, options, callback) {
        assert.equal(command, "gh", "Tests must not send notifications");
        if (args[0] === "search") searches.push(callback);
        else if (args[1] === "list") callback(null, JSON.stringify([{ number: 7, reviews: [] }]));
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
  return { app, searches, url: `http://127.0.0.1:${server.address().port}` };
}

test("a new device can read an empty server cache without starting a GitHub refresh", async (t) => {
  const { url, searches } = await startApp(t);
  const response = await fetch(`${url}/api/prs/cache`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.json(), null);
  assert.equal(searches.length, 0);
});

test("devices share the saved snapshot immediately and a single fresh response afterward", { timeout: 5000 }, async (t) => {
  const saved = { prs: [{ number: 6, title: "Previously shown on desktop" }], at: 1234 };
  const { url, app, searches } = await startApp(t, saved);
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

  const desktop = fetch(`${url}/api/prs`);
  const phone = fetch(`${url}/api/prs`);
  await bothRefreshing;
  assert.equal(searches.length, 1);
  const duringRefresh = await (await fetch(`${url}/api/prs/cache`)).json();
  assert.deepEqual(duringRefresh, { ...saved, sleep: {}, authError: false });

  searches[0](null, JSON.stringify([{
    number: 7, title: "New GitHub result", repository: { nameWithOwner: "example/repo" }, isDraft: true,
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
    prs: desktopRows, at, sleep: {}, authError: false,
  });

  // Sleep state is shared immediately, without a second GitHub refresh.
  const sleep = await (await fetch(`${url}/api/sleep`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: ["example/repo#7"], days: 1 }),
  })).json();
  assert.deepEqual((await (await fetch(`${url}/api/prs/cache`)).json()).sleep, sleep);
  assert.equal(searches.length, 1);
});
