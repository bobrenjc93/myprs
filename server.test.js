const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { app, effectiveReviewDecision, filterVerifiedOpen } = require("./server");

function pr(repo, number) {
  return { repository: { nameWithOwner: repo }, number };
}

function review(state, login = "reviewer") {
  return { state, author: login ? { login } : null };
}

test("recognizes pytorchgreenlight's approval when GitHub has no aggregate decision", () => {
  for (const reviewDecision of [null, "", undefined]) {
    assert.equal(effectiveReviewDecision({
      reviewDecision,
      reviews: [review("APPROVED", "pytorchgreenlight")],
    }), "APPROVED");
  }
});

test("preserves GitHub's aggregate decision even when individual reviews differ", () => {
  for (const reviewDecision of ["REVIEW_REQUIRED", "APPROVED", "CHANGES_REQUESTED"]) {
    const conflictingState = reviewDecision === "APPROVED" ? "CHANGES_REQUESTED" : "APPROVED";
    assert.equal(effectiveReviewDecision({
      reviewDecision,
      reviews: [review(conflictingState)],
    }), reviewDecision);
  }
});

test("uses each reviewer's latest verdict when they change their decision", () => {
  for (const [earlier, later] of [
    ["CHANGES_REQUESTED", "APPROVED"],
    ["APPROVED", "CHANGES_REQUESTED"],
  ]) {
    assert.equal(effectiveReviewDecision({
      reviews: [review(earlier), review(later)],
    }), later);
  }
});

test("comments and pending reviews do not revoke a submitted verdict", () => {
  for (const verdict of ["APPROVED", "CHANGES_REQUESTED"]) {
    assert.equal(effectiveReviewDecision({
      reviews: [review(verdict), review("COMMENTED"), review("PENDING")],
    }), verdict);
  }
});

test("dismissal removes a reviewer's earlier verdict until they review again", () => {
  for (const verdict of ["APPROVED", "CHANGES_REQUESTED"]) {
    const reviews = [review(verdict), review("DISMISSED")];
    assert.equal(effectiveReviewDecision({ reviews }), "");
    assert.equal(effectiveReviewDecision({ reviews: [...reviews, review("APPROVED")] }), "APPROVED");
  }
});

test("another reviewer's outstanding changes take priority over approval", () => {
  const reviews = [review("CHANGES_REQUESTED", "alice"), review("APPROVED", "bob")];
  assert.equal(effectiveReviewDecision({ reviews }), "CHANGES_REQUESTED");
  assert.equal(effectiveReviewDecision({ reviews: [...reviews].reverse() }), "CHANGES_REQUESTED");
  assert.equal(effectiveReviewDecision({
    reviews: [...reviews, review("DISMISSED", "alice")],
  }), "APPROVED");
});

test("has no decision without a decisive review from an identified author", () => {
  for (const reviews of [undefined, [], [review("COMMENTED"), review("PENDING")], [
    review("APPROVED", null),
    { state: "CHANGES_REQUESTED" },
    { state: "APPROVED", author: {} },
  ]]) {
    assert.equal(effectiveReviewDecision({ reviews }), "");
  }
});

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
