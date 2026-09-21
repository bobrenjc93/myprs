const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const {
  app, effectiveReviewDecision, filterVerifiedOpen,
  drciStatus, claudeReviewStatus, pytorchStatuses, resolvePytorchStatuses,
  ghstackNumbers, groupGhstackPrs,
} = require("./server");

function pr(repo, number) {
  return { repository: { nameWithOwner: repo }, number };
}

function review(state, login = "reviewer") {
  return { state, author: login ? { login } : null };
}

function comment(login, body) {
  return { author: login ? { login } : null, body };
}

function drci(body) {
  return `<!-- drci-comment-start -->\n${body}\n<!-- drci-comment-end -->`;
}

function claudeProgress(runId = "35299414727", repo = "pytorch/pytorch") {
  return [
    '### Re-reviewing #196897 <img src="loading.gif" width="16" height="16" />',
    "- [x] Read the earlier review",
    "- [x] Inspect the updated diff",
    "- [x] Read related code",
    "- [x] Check test coverage",
    "- [x] Draft findings",
    "- [ ] Fact-check findings and post review",
    `[View job run](https://github.com/${repo}/actions/runs/${runId})`,
  ].join("\n");
}

const ghstackHeader = "Stack from [ghstack](https://github.com/ezyang/ghstack/tree/0.17.0) (oldest at bottom):";

function stackedPr(number, ghstack, fields = {}) {
  return { ...pr("pytorch/pytorch", number), ghstack, ...fields };
}

test("ghstack reads the generated list bottom first, preserving stack order rather than number order", () => {
  for (const newline of ["\n", "\r\n"]) {
    const body = [
      "Fixes #999",
      "",
      ghstackHeader,
      "* #40",
      "* __->__ #90",
      "* #70",
      "",
      "Related work:",
      "* #888",
    ].join(newline);
    assert.deepEqual(ghstackNumbers(body), [70, 90, 40]);
  }
});

test("missing descriptions, prose references, and unrelated lists are not ghstack membership", () => {
  for (const body of [
    undefined, null, 42, {}, "",
    "Depends on #10\n* #20",
    "Stack (oldest at bottom):\n* #20\n* #10",
    `${ghstackHeader}\nThis paragraph mentions #10.\n* #20`,
  ]) {
    assert.deepEqual(ghstackNumbers(body), [], String(body));
    assert.deepEqual(groupGhstackPrs([
      stackedPr(10, ghstackNumbers(body)), stackedPr(20, []),
    ]), [pr("pytorch/pytorch", 10), pr("pytorch/pytorch", 20)]);
  }
});

test("overlapping and truncated ghstack descriptions collapse to exactly one bottom row", () => {
  for (const topMembers of [[70, 90, 40], [90, 40]]) {
    const prs = [
      stackedPr(40, topMembers),
      pr("pytorch/pytorch", 5),
      stackedPr(90, [70, 90]),
      stackedPr(70, [70]),
    ];
    for (const input of [prs, [...prs].reverse()]) {
      const rows = groupGhstackPrs(input);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.find(row => row.stack), {
        ...pr("pytorch/pytorch", 70), stack: { numbers: [70, 90, 40] },
      });
      assert.deepEqual(rows.find(row => !row.stack), pr("pytorch/pytorch", 5));
      assert.ok(rows.every(row => !Object.hasOwn(row, "ghstack")));
    }
  }
});

test("the bottom PR keeps its own status and details without mutating input PRs", () => {
  const bottom = stackedPr(70, [70, 90], {
    title: "Bottom change", url: "https://github.com/pytorch/pytorch/pull/70",
    ciStatus: "green", claudeReviewStatus: "red", reviewDecision: "APPROVED",
    labels: [{ name: "ready" }], isDraft: false,
  });
  const prs = [stackedPr(90, [70, 90], {
    title: "Top change", ciStatus: "red", claudeReviewStatus: "green",
    reviewDecision: "CHANGES_REQUESTED", isDraft: true,
  }), bottom];
  const original = structuredClone(prs);
  assert.deepEqual(groupGhstackPrs(prs), [{
    ...pr("pytorch/pytorch", 70),
    title: "Bottom change", url: "https://github.com/pytorch/pytorch/pull/70",
    ciStatus: "green", claudeReviewStatus: "red", reviewDecision: "APPROVED",
    labels: [{ name: "ready" }], isDraft: false,
    stack: { numbers: [70, 90] },
  }]);
  assert.deepEqual(prs, original);
});

test("a closed or otherwise absent bottom advances to the lowest remaining open PR", () => {
  for (const [open, expected] of [
    [[stackedPr(40, [70, 90, 40]), stackedPr(90, [70, 90])], [90, 40]],
    [[stackedPr(40, [70, 90, 40])], [40]],
  ]) {
    assert.deepEqual(groupGhstackPrs(open), [{
      ...pr("pytorch/pytorch", expected[0]), stack: { numbers: expected },
    }]);
  }
});

test("stacks sharing only closed PRs remain separate", () => {
  const rows = groupGhstackPrs([
    stackedPr(30, [10, 20, 30]), stackedPr(50, [10, 40, 50]),
    stackedPr(20, [10, 20]), stackedPr(40, [10, 40]),
  ]);
  assert.deepEqual(rows, [
    { ...pr("pytorch/pytorch", 20), stack: { numbers: [20, 30] } },
    { ...pr("pytorch/pytorch", 40), stack: { numbers: [40, 50] } },
  ]);
});

test("identical PR numbers in different repositories never join a stack", () => {
  const repos = ["pytorch/pytorch", "another/repo"];
  const prs = repos.flatMap(repo => [
    { ...pr(repo, 90), ghstack: [70, 90] },
    { ...pr(repo, 70), ghstack: [70, 90] },
  ]);
  assert.deepEqual(groupGhstackPrs(prs), repos.map(repo => ({
    ...pr(repo, 70), stack: { numbers: [70, 90] },
  })));
});

test("newer stack order wins conflicts while older lists supplement missing members", () => {
  for (const [latest, earlier] of [
    [[70, 20, 90], [90, 20, 70]],
    [[70, 20], [20, 90, 70]],
    [[20, 90], [70, 20, 90]],
  ]) {
    const prs = [
      stackedPr(90, earlier, { updatedAt: "2026-09-16T12:00:00Z" }),
      stackedPr(70, []),
      stackedPr(20, latest, { updatedAt: "2026-09-17T12:00:00Z" }),
    ];
    for (const input of [prs, [...prs].reverse()]) {
      const rows = groupGhstackPrs(input);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].number, 70);
      assert.deepEqual(rows[0].stack.numbers, [70, 20, 90]);
    }
  }
});

test("a single PR retains its ghstack marker and copied lists without their owning PR are ignored", () => {
  assert.deepEqual(groupGhstackPrs([stackedPr(70, [70])]), [{
    ...pr("pytorch/pytorch", 70), stack: { numbers: [70] },
  }]);
  assert.deepEqual(groupGhstackPrs([
    stackedPr(70, [90, 40]), pr("pytorch/pytorch", 90), pr("pytorch/pytorch", 40),
  ]), [pr("pytorch/pytorch", 70), pr("pytorch/pytorch", 90), pr("pytorch/pytorch", 40)]);
  assert.deepEqual(groupGhstackPrs([]), []);
});

test("PyTorch #197277's Claude approval and unrelated CI failures are both green", () => {
  assert.deepEqual(pytorchStatuses([
    comment("claude", "### Recommendation\n**Approve**"),
    comment("pytorchbot", drci([
      "## :link: Helpful Links",
      "## :white_check_mark: You can merge normally! (2 Unrelated Failures)",
    ].join("\n"))),
  ]), { claudeReviewStatus: "green", ciStatus: "green" });
});

test("DrCI uses the headline's emoji or shortcode even when its text sounds mergeable", () => {
  for (const [headline, expected] of [
    ["## ✅ You can merge normally! (2 Unrelated Failures)", "green"],
    ["## :white_check_mark: You can merge normally!", "green"],
    ["## ❌ There are failing jobs", "red"],
    ["## :x: You can merge normally! (2 Unrelated Failures), 1 Unclassified Failure", "red"],
    ["## ❌ You can merge normally! (2 Unrelated Failures), 1 Unclassified Failure", "red"],
  ]) {
    assert.equal(drciStatus(drci(headline)), expected, headline);
  }
});

test("DrCI markers isolate the status from unrelated headings elsewhere in the comment", () => {
  assert.equal(drciStatus([
    "## ❌ An unrelated heading before the status",
    drci("## ✅ You can merge normally!"),
    "## ❌ An unrelated heading after the status",
  ].join("\n")), "green");
  assert.equal(drciStatus([
    "## ✅ An unrelated heading",
    drci("CI is still running."),
    "## ❌ Another unrelated heading",
  ].join("\n")), null);
});

test("Claude recognizes explicit approval, requested changes, and discussion recommendations", () => {
  for (const [body, expected] of [
    ["## Recommendation\n\n**Approve**", "green"],
    ["### Recommendation: Approved", "green"],
    ["## **Recommendation**\r\n\r\n**Request Changes** — a regression needs fixing.", "red"],
    ["## Recommendation\n\n**Needs Discussion**", "red"],
    ["## Recommendation\nChanges Requested", "red"],
  ]) {
    assert.equal(claudeReviewStatus(body), expected, body);
  }
});

test("Claude task progress, prose, and checklists are not review recommendations", () => {
  for (const body of [
    "Claude is working…\n- [x] Review code\n- [ ] Approve",
    "I would Approve once the tests pass.",
    "## Tasks\n- [x] Approve\n- [ ] Request Changes",
    "## Recommendation\n- [ ] Approve\n- [ ] Request Changes",
    "## Recommendation\nReview in progress; I may Approve later.",
    "## Recommendation\nPending",
  ]) {
    assert.equal(claudeReviewStatus(body), null, body);
  }
});

test("the latest recognized Claude recommendation wins while unrelated progress and human comments are ignored", () => {
  for (const [first, last, expected] of [
    ["Approve", "Request Changes", "red"],
    ["Needs Discussion", "Approved", "green"],
  ]) {
    const opposite = expected === "green" ? "Request Changes" : "Approve";
    assert.equal(pytorchStatuses([
      comment("claude", `## Recommendation\n${first}`),
      comment("claude[bot]", `## Recommendation\n${last}`),
      comment("claude", "Review in progress…\n- [x] Inspect code"),
      comment("reviewer", `## Recommendation\n${opposite}`),
      comment("not-claude", `## Recommendation\n${opposite}`),
      comment(null, `## Recommendation\n${opposite}`),
    ]).claudeReviewStatus, expected);
  }
});

test("explicit Claude review progress is pending with unfinished tasks or a linked job", () => {
  for (const body of [
    claudeProgress(),
    "### Reviewing PR #196897\n- [ ] Inspect code",
    "### Re-reviewing #196897\n- [ ] Post review",
    "### Reviewing PR #196897\n- [x] Inspect code\n[View job](https://github.com/pytorch/pytorch/actions/runs/35299414727)",
  ]) {
    assert.equal(claudeReviewStatus(body), "pending", body);
  }
});

test("completed recommendations take precedence over retained progress headings and unchecked tasks", () => {
  for (const [verdict, expected] of [["Approve", "green"], ["Request Changes", "red"], ["Needs Discussion", "red"]]) {
    assert.equal(claudeReviewStatus(`${claudeProgress()}\n\n### Recommendation\n**${verdict}**`), expected);
  }
});

test("finished or failed Claude banners and ordinary tasks cannot look like active reviews", () => {
  for (const terminal of ["finished", "failed", "cancelled", "canceled", "encountered an error", "hit an error"]) {
    assert.equal(claudeReviewStatus(`**Claude ${terminal} this task.**\n\n${claudeProgress()}`), null, terminal);
  }
  for (const body of [
    "### Re-reviewing #196897\n- [x] All tasks completed",
    "I am reviewing PR #196897.\n- [ ] Inspect code",
    "## Tasks\n- [ ] Review code\n- [ ] Post review",
    "@claude please re-review\n[View job run](https://github.com/pytorch/pytorch/actions/runs/35299414727)",
  ]) {
    assert.equal(claudeReviewStatus(body), null, body);
  }
  assert.equal(pytorchStatuses([comment("reviewer", `@claude please re-review\n${claudeProgress()}`)]).claudeReviewStatus, null);
});

test("a newer Claude review attempt replaces a prior verdict until a new verdict arrives", () => {
  for (const [verdict, expected] of [["Approve", "green"], ["Request Changes", "red"]]) {
    const comments = [
      comment("claude", `### Recommendation\n${verdict}`),
      comment("claude[bot]", claudeProgress()),
    ];
    assert.equal(pytorchStatuses(comments).claudeReviewStatus, "pending");
    assert.equal(pytorchStatuses([
      ...comments,
      comment("claude", `### Recommendation\n${verdict}`),
      comment("reviewer", claudeProgress()),
      comment("claude", "Review in progress…\n- [ ] Unrelated task"),
    ]).claudeReviewStatus, expected);
  }
});

test("active workflows keep the latest Claude attempt pending and only that run is fetched", async () => {
  const comments = [
    comment("claude", "### Recommendation\nRequest Changes"),
    comment("claude", claudeProgress("111111")),
    comment("claude", "### Recommendation\nApprove"),
    comment("claude[bot]", claudeProgress()),
    comment("pytorchbot", drci("## ✅ You can merge normally!")),
  ];
  for (const status of ["in_progress", "queued", "waiting"]) {
    const calls = [];
    const result = await resolvePytorchStatuses(comments, "pytorch/pytorch", async (...args) => {
      calls.push(args);
      return { status, conclusion: null };
    });
    assert.deepEqual(result, { claudeReviewStatus: "pending", ciStatus: "green" });
    assert.deepEqual(calls, [["pytorch/pytorch", "35299414727"]]);
  }
});

test("completed workflows restore the last real verdict, and workflow success alone is not approval", async () => {
  for (const conclusion of ["success", "failure", "cancelled"]) {
    for (const [previous, expected] of [["Approve", "green"], ["Request Changes", "red"], [null, null]]) {
      const comments = [
        ...(previous ? [comment("claude", `### Recommendation\n${previous === "Approve" ? "Request Changes" : "Approve"}`)] : []),
        comment("claude", claudeProgress("111111")),
        ...(previous ? [comment("claude", `### Recommendation\n${previous}`)] : []),
        comment("claude[bot]", claudeProgress()),
        comment("pytorchbot", drci("## ❌ CI failed")),
      ];
      const calls = [];
      const result = await resolvePytorchStatuses(comments, "pytorch/pytorch", async (...args) => {
        calls.push(args);
        return { status: "completed", conclusion };
      });
      assert.deepEqual(result, { claudeReviewStatus: expected, ciStatus: "red" }, `${conclusion}: ${previous}`);
      assert.deepEqual(calls, [["pytorch/pytorch", "35299414727"]]);
    }
  }
});

test("a failed workflow lookup preserves the pending status reported by Claude", async () => {
  let calls = 0;
  const result = await resolvePytorchStatuses([
    comment("claude", "### Recommendation\nApprove"),
    comment("claude", claudeProgress()),
  ], "pytorch/pytorch", async () => {
    calls++;
    throw new Error("GitHub unavailable");
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { claudeReviewStatus: "pending", ciStatus: null });
});

test("final verdicts, missing job links, and other repositories do not trigger workflow lookups", async () => {
  for (const [comments, expected] of [
    [[], null],
    [[comment("claude", "- [ ] An ordinary task")], null],
    [[comment("claude", claudeProgress()), comment("claude", "### Recommendation\nApprove")], "green"],
    [[comment("claude", claudeProgress("35299414727", "another/repo"))], "pending"],
    [[comment("claude", "### Reviewing PR #196897\n- [ ] Inspect code")], "pending"],
    [[comment("claude", claudeProgress()), comment("claude", "### Re-reviewing #196897\n- [ ] Inspect code")], "pending"],
    [[comment("reviewer", claudeProgress())], null],
  ]) {
    let calls = 0;
    const result = await resolvePytorchStatuses(comments, "pytorch/pytorch", async () => {
      calls++;
      return { status: "completed", conclusion: "success" };
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { claudeReviewStatus: expected, ciStatus: null });
  }
});

test("DrCI accepts GitHub bot login variants and uses the newest marked status", () => {
  for (const login of ["pytorchbot", "pytorchbot[bot]", "pytorch-bot", "pytorch-bot[bot]"]) {
    assert.equal(pytorchStatuses([
      comment(login, drci("## ❌ CI failed")),
      comment(login, drci("## ✅ You can merge normally!")),
      comment(login, "## ❌ This comment is not a DrCI status"),
      comment("reviewer", drci("## ❌ A human copied the status")),
    ]).ciStatus, "green", login);
    assert.equal(pytorchStatuses([
      comment(login, drci("## ✅ You can merge normally!")),
      comment(login, drci("## ❌ CI failed")),
    ]).ciStatus, "red", login);
    assert.equal(pytorchStatuses([
      comment(login, drci("## ✅ You can merge normally!")),
      comment(login, drci("CI is still running.")),
    ]).ciStatus, null, login);
  }
});

test("missing or unknown bot signals do not fabricate a status", () => {
  for (const body of [undefined, null, 42, {}, "", "CI is running", "✅ Passed without a status heading"]) {
    assert.equal(drciStatus(body), null);
    assert.equal(claudeReviewStatus(body), null);
  }
  const unknown = { claudeReviewStatus: null, ciStatus: null };
  assert.deepEqual(pytorchStatuses(), unknown);
  assert.deepEqual(pytorchStatuses([]), unknown);
  assert.deepEqual(pytorchStatuses([
    {}, comment("claude"), comment("pytorchbot"),
    comment("claude", "## Recommendation\nPending"),
    comment("pytorchbot", drci("CI is still running.")),
  ]), unknown);
});

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
