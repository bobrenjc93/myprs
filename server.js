const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPrCache } = require("./pr-cache");

const app = express();
const PORT = 3000;
const SLEEP_FILE = path.join(__dirname, "sleep.json");
const NOTIFIED_FILE = path.join(__dirname, "notified.json");
const PR_CACHE_FILE = path.join(__dirname, "pr-cache.json");

// Set true when a ping fails because the meta auth token is expired/invalid,
// so the UI can prompt the user to run `jf auth`. Cleared on a successful ping.
let pingAuthError = false;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function readSleep() {
  try {
    return JSON.parse(fs.readFileSync(SLEEP_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSleep(data) {
  fs.writeFileSync(SLEEP_FILE, JSON.stringify(data, null, 2));
}

// Prune expired sleep entries and return active ones
function getActiveSleep() {
  const sleep = readSleep();
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(sleep)) {
    if (new Date(sleep[key].until).getTime() <= now) {
      delete sleep[key];
      changed = true;
    }
  }
  if (changed) writeSleep(sleep);
  return sleep;
}

function execGh(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

// GitHub's search index can briefly return PRs that were just merged or
// closed. Only prune results for repositories whose canonical open-PR query
// succeeded; a failed verification must not make an entire repo disappear.
function filterVerifiedOpen(prs, verifiedRepos, verifiedOpen) {
  return prs.filter((pr) => {
    const repo = pr.repository.nameWithOwner;
    return !verifiedRepos.has(repo) || verifiedOpen.has(`${repo}#${pr.number}`);
  });
}

// ghstack lists the newest PR first and marks the current PR with __->__.
// Restrict parsing to its generated block so prose references aren't members.
function ghstackNumbers(body) {
  if (typeof body !== "string") return [];
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => /^Stack from \[ghstack\]\(https:\/\/github\.com\/[^)]+\) \(oldest at bottom\):\s*$/.test(line));
  if (start === -1) return [];
  const numbers = [];
  for (const line of lines.slice(start + 1)) {
    const entry = line.match(/^\s*\*\s+(?:__->__\s+)?#([1-9]\d*)\s*$/);
    if (!entry) break;
    numbers.push(Number(entry[1]));
  }
  return [...new Set(numbers.reverse())];
}

// Collapse overlapping ghstack lists using only PRs still in the dashboard.
// Closed dependencies must neither represent a stack nor join separate stacks.
function groupGhstackPrs(prs) {
  const keyOf = pr => `${pr.repository.nameWithOwner}#${pr.number}`;
  const byKey = new Map(prs.map(pr => [keyOf(pr), pr]));
  const parents = new Map(prs.map(pr => [keyOf(pr), keyOf(pr)]));
  const root = key => {
    if (parents.get(key) !== key) parents.set(key, root(parents.get(key)));
    return parents.get(key);
  };
  const lists = [];
  for (const pr of prs) {
    if (!pr.ghstack?.includes(pr.number)) continue;
    const keys = pr.ghstack.map(number => `${pr.repository.nameWithOwner}#${number}`).filter(key => byKey.has(key));
    for (const key of keys) parents.set(root(key), root(keys[0]));
    lists.push({ keys, updatedAt: pr.updatedAt });
  }

  // Old descriptions can be truncated or disagree after a restack. Preserve
  // the newest list's order; older lists only insert members missing from it.
  // This avoids cycles caused by combining every historical ordering edge.
  lists.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || b.keys.length - a.keys.length);
  const orders = new Map();
  for (const { keys } of lists) {
    const group = root(keys[0]);
    if (!orders.has(group)) orders.set(group, []);
    const order = orders.get(group);
    for (let i = 0; i < keys.length; i++) {
      if (order.includes(keys[i])) continue;
      const previous = keys.slice(0, i).reverse().find(key => order.includes(key));
      const next = keys.slice(i + 1).find(key => order.includes(key));
      const position = previous ? order.indexOf(previous) + 1 : next ? order.indexOf(next) : order.length;
      order.splice(position, 0, keys[i]);
    }
  }

  const emitted = new Set();
  const rows = [];
  for (const pr of prs) {
    const group = root(keyOf(pr));
    if (emitted.has(group)) continue;
    emitted.add(group);
    const order = orders.get(group);
    const representative = order ? byKey.get(order[0]) : pr;
    const { ghstack, ...row } = representative;
    if (order) row.stack = { numbers: order.map(key => byKey.get(key).number) };
    rows.push(row);
  }
  return rows;
}

// GitHub can leave reviewDecision empty even when submitted reviews exist.
// Keep its decision when present; otherwise use each reviewer's latest verdict.
function effectiveReviewDecision(pr) {
  if (pr?.reviewDecision) return pr.reviewDecision;

  const verdicts = new Map();
  // gh returns reviews in chronological order. Comments and pending reviews
  // do not replace an earlier verdict; a dismissed review no longer counts.
  for (const review of pr?.reviews || []) {
    const reviewer = review.author?.login;
    if (!reviewer || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    verdicts.set(reviewer, review.state);
  }

  const states = [...verdicts.values()];
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  return "";
}

// Use Dr. CI's headline, not individual job results: unrelated/flaky failures
// can still be mergeable. GitHub exposes either emoji shortcodes or Unicode.
function drciStatus(body) {
  if (typeof body !== "string") return null;
  const start = body.indexOf("<!-- drci-comment-start -->");
  const end = body.indexOf("<!-- drci-comment-end -->", Math.max(0, start));
  const section = body.slice(Math.max(0, start), end === -1 ? undefined : end);
  if (/^#{1,6}[ \t]+(?:\:x\:|❌|✗|✘)/m.test(section)) return "red";
  if (/^#{1,6}[ \t]+(?:\:white_check_mark\:|✅|✓|✔)/m.test(section)) return "green";
  return null;
}

// Claude posts reviews and progress in issue comments. A recommendation wins
// over task lists retained in a completed review; an active review is pending.
function claudeReviewStatus(body) {
  if (typeof body !== "string") return null;
  const recommendation = body.match(
    /^#{1,6}[ \t]+(?:\*\*|__)?Recommendation(?:\*\*|__)?[ \t]*:?[ \t]*([^\r\n]*)\r?\n?([\s\S]*)/im,
  );
  if (recommendation) {
    const verdict = (recommendation[1].trim() || recommendation[2].trim().split(/\r?\n/)[0])
      .replace(/[*_`]/g, "").trim();
    if (/^Approve(?:d)?\b/i.test(verdict)) return "green";
    if (/^(?:Request(?:ed)? Changes|Changes Requested|Needs Discussion)\b/i.test(verdict)) return "red";
  }
  if (/^\s*\*\*Claude (?:finished|failed|cancell?ed|encountered an error|hit an error)\b/i.test(body)) return null;
  const reviewing = /^#{1,6}[ \t]+(?:Re[- ]?)?reviewing\b/im.test(body);
  const unfinishedTasks = /^[ \t]*[-*][ \t]+\[ \][ \t]+/m.test(body);
  const jobLink = /\[View job(?: run)?\]\(https:\/\/github\.com\//i.test(body);
  if (reviewing && (unfinishedTasks || jobLink)) return "pending";
  return null;
}

function pytorchStatuses(comments = [], { includePending = true } = {}) {
  const statuses = { claudeReviewStatus: null, ciStatus: null };
  // gh returns comments in creation order. The newest review attempt takes
  // precedence, including a re-review that has not posted its verdict yet.
  for (const comment of comments) {
    const author = comment.author?.login?.replace(/\[bot\]$/, "");
    if (author === "claude") {
      const status = claudeReviewStatus(comment.body);
      if (status && (includePending || status !== "pending")) statuses.claudeReviewStatus = status;
    }
    if ((author === "pytorch-bot" || author === "pytorchbot") && comment.body?.includes("<!-- drci-comment-start -->")) {
      statuses.ciStatus = drciStatus(comment.body);
    }
  }
  return statuses;
}

async function resolvePytorchStatuses(comments, repo, fetchRun = (repo, runId) =>
  execGh(["api", `repos/${repo}/actions/runs/${runId}`, "--jq", "{status, conclusion}"])) {
  const statuses = pytorchStatuses(comments);
  if (statuses.claudeReviewStatus !== "pending") return statuses;
  const latest = [...comments].reverse().find(comment =>
    comment.author?.login?.replace(/\[bot\]$/, "") === "claude" && claudeReviewStatus(comment.body) === "pending");
  const run = latest.body.match(/\[View job(?: run)?\]\(https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?\)/i);
  if (!run || run[1].toLowerCase() !== repo.toLowerCase()) return statuses;
  try {
    const workflow = await fetchRun(repo, run[2]);
    // Failed/cancelled jobs can leave a spinner in their comment forever.
    // Completion alone isn't approval; retain the last actual recommendation.
    if (workflow.status === "completed") return pytorchStatuses(comments, { includePending: false });
  } catch {
    // If GitHub is unavailable, use the progress reported in the comment.
  }
  return statuses;
}

function readNotified() {
  try {
    return JSON.parse(fs.readFileSync(NOTIFIED_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeNotified(data) {
  fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(data, null, 2));
}

// Returns true only if the ping was actually delivered. `meta` exits 0 even
// when it silently fails on an expired auth token, so we also scan its output
// for auth-failure markers and treat those as failures.
function sendPing(message) {
  return new Promise((resolve) => {
    execFile("meta", ["pingme.message", "send", `--message=${message}`], (err, stdout, stderr) => {
      if (err) {
        console.error("pingme error:", err.message);
        return resolve(false);
      }
      const out = `${stdout || ""}${stderr || ""}`;
      if (/OAuth token is expired|No valid Crypto Auth Tokens|token is expired or invalid/i.test(out)) {
        console.error("pingme auth failure (run `jf auth`):", out.trim());
        pingAuthError = true;
        return resolve(false);
      }
      pingAuthError = false;
      resolve(true);
    });
  });
}

// Ping once for each published PR whose CI is broken. State is tracked in
// notified.json so we don't re-ping every refresh; a PR that recovers (or drops
// off the list) is cleared, so a fresh breakage pings again.
async function notifyBrokenCI(prs) {
  const notified = readNotified();
  const host = os.hostname();
  let changed = false;

  const broken = new Set();
  for (const pr of prs) {
    if (!pr.isDraft && pr.ciStatus === "red") {
      broken.add(`${pr.repository.nameWithOwner}#${pr.number}`);
    }
  }

  for (const pr of prs) {
    if (pr.isDraft || pr.ciStatus !== "red") continue;
    const key = `${pr.repository.nameWithOwner}#${pr.number}`;
    if (notified[key]) continue;
    // Only mark as notified once the ping is confirmed sent, so a failed send
    // (e.g. expired auth) is retried on the next refresh instead of lost.
    const sent = await sendPing(`[${host}] Broken CI: ${pr.title} ${pr.url}`);
    if (sent) {
      notified[key] = true;
      changed = true;
    }
  }

  for (const key of Object.keys(notified)) {
    if (!broken.has(key)) {
      delete notified[key];
      changed = true;
    }
  }

  if (changed) writeNotified(notified);
}

async function fetchPrsFromGitHub() {
  let prs = await execGh([
    "search", "prs",
    "--author=@me", "--state=open", "--limit=200",
    "--json", "number,title,repository,updatedAt,url,isDraft,state,createdAt,labels",
  ]);

  // Group PRs by repo to batch-fetch review details.
  const byRepo = new Map();
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(pr);
  }

  // Fetch review details per repo in parallel. This list is also the
  // canonical source of truth for whether each search result is still open.
  const verifiedRepos = new Set();
  const verifiedOpen = new Set();
  await Promise.all([...byRepo.entries()].map(async ([repo, repoPrs]) => {
    try {
      const details = await execGh([
        "pr", "list",
        "--repo", repo,
        "--author=@me",
        "--state=open",
        "--limit=200",
        "--json", "number,reviewDecision,reviewRequests,reviews,body,updatedAt",
      ]);
      verifiedRepos.add(repo);
      for (const d of details) verifiedOpen.add(`${repo}#${d.number}`);
      const detailMap = new Map(details.map(d => [d.number, d]));
      for (const pr of repoPrs) {
        const d = detailMap.get(pr.number);
        pr.ghstack = ghstackNumbers(d?.body);
        if (d?.updatedAt) pr.updatedAt = d.updatedAt;
        pr.reviewDecision = effectiveReviewDecision(d);
        const reqs = d && d.reviewRequests ? d.reviewRequests.length : 0;
        const revs = d && d.reviews ? d.reviews.length : 0;
        pr.hasReviewers = reqs > 0 || revs > 0;
      }
    } catch {
      // On failure, assume reviewers exist so we don't falsely nag.
      for (const pr of repoPrs) {
        pr.reviewDecision = "";
        pr.hasReviewers = true;
      }
    }
  }));

  prs = groupGhstackPrs(filterVerifiedOpen(prs, verifiedRepos, verifiedOpen));

  // Claude reviews and Dr. CI mergeability are both published in comments.
  // Fetch them together for PyTorch PRs, including reviewed drafts.
  await Promise.all(prs.map(async (pr) => {
    pr.ciStatus = null;
    pr.claudeReviewStatus = null;
    const owner = pr.repository.nameWithOwner.split("/")[0];
    if (owner !== "pytorch") return;
    try {
      const data = await execGh([
        "pr", "view", String(pr.number),
        "--repo", pr.repository.nameWithOwner,
        "--json", "comments",
      ]);
      Object.assign(pr, await resolvePytorchStatuses(data.comments || [], pr.repository.nameWithOwner));
    } catch {
      // Leave both statuses unknown when comments are unavailable.
    }
  }));

  // Auto-wake any PR that has since been approved.
  const sleep = getActiveSleep();
  let sleepChanged = false;
  for (const pr of prs) {
    if (pr.reviewDecision !== "APPROVED") continue;
    const key = `${pr.repository.nameWithOwner}#${pr.number}`;
    if (sleep[key]) {
      delete sleep[key];
      sleepChanged = true;
    }
  }
  if (sleepChanged) writeSleep(sleep);

  // Fire-and-forget so a slow/failed ping never blocks the response.
  notifyBrokenCI(prs).catch(e => console.error("notify error:", e.message));

  return prs;
}

const prCache = createPrCache({ file: PR_CACHE_FILE, fetchPrs: fetchPrsFromGitHub });

// Reading the shared snapshot is immediate and never waits for GitHub. Sleep
// and auth state are read now so another device's changes aren't cached away.
app.get("/api/prs/cache", (req, res) => {
  const snapshot = prCache.getSnapshot();
  res.json(snapshot ? { ...snapshot, sleep: getActiveSleep(), authError: pingAuthError } : null);
});

app.get("/api/prs", async (req, res) => {
  try {
    const snapshot = await prCache.refresh();
    res.set("X-PRs-Updated-At", String(snapshot.at));
    res.json(snapshot.prs);
  } catch (e) {
    console.error("gh error:", e.message);
    res.status(500).json({ error: "Failed to fetch PRs" });
  }
});

// Whether the last ping failed due to an expired/invalid auth token.
app.get("/api/ping-status", (req, res) => {
  res.json({ authError: pingAuthError });
});

// Actively test the token by sending a confirmation ping. Updates pingAuthError
// as a side effect so the UI banner clears once the token is refreshed.
app.post("/api/verify-token", async (req, res) => {
  const ok = await sendPing(`[${os.hostname()}] myprs: token verified ✅`);
  res.json({ authError: pingAuthError, ok });
});

app.get("/api/sleep", (req, res) => {
  res.json(getActiveSleep());
});

app.post("/api/sleep", (req, res) => {
  const { keys, days } = req.body;
  if (!Array.isArray(keys) || !days) {
    return res.status(400).json({ error: "keys (array) and days (number) required" });
  }
  const sleep = getActiveSleep();
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  for (const key of keys) {
    sleep[key] = { until };
  }
  writeSleep(sleep);
  res.json(sleep);
});

app.delete("/api/sleep/:key", (req, res) => {
  const sleep = getActiveSleep();
  delete sleep[req.params.key];
  writeSleep(sleep);
  res.json(sleep);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = {
  app, filterVerifiedOpen, ghstackNumbers, groupGhstackPrs,
  effectiveReviewDecision, drciStatus, claudeReviewStatus, pytorchStatuses, resolvePytorchStatuses,
};
