const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { app, filterVerifiedOpen } = require("./server");

function pr(repo, number) {
  return { repository: { nameWithOwner: repo }, number };
}

test("removes stale search results from successfully verified repositories", () => {
  const prs = [pr("owner/verified", 1), pr("owner/verified", 2)];
  const result = filterVerifiedOpen(
    prs,
    new Set(["owner/verified"]),
    new Set(["owner/verified#2"]),
  );

  assert.deepEqual(result, [prs[1]]);
});

test("keeps search results when repository verification failed", () => {
  const prs = [pr("owner/unverified", 1)];
  const result = filterVerifiedOpen(prs, new Set(), new Set());

  assert.deepEqual(result, prs);
});

test("API responses cannot be served from an HTTP cache", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/ping-status`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
