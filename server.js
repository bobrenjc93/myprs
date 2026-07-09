const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const PORT = 3000;
const SLEEP_FILE = path.join(__dirname, "sleep.json");
const NOTIFIED_FILE = path.join(__dirname, "notified.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

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

// Parse the Dr. CI (pytorch-bot) comment body into a CI status.
// Returns "red" when the Dr. CI status header is :x: (failures that need
// attention), "green" when it's :white_check_mark: (mergeable, even with
// unrelated/flaky failures), or null when the status can't be determined.
function drciStatus(body) {
  const start = body.indexOf("<!-- drci-comment-start -->");
  const end = body.indexOf("<!-- drci-comment-end -->");
  const section = start !== -1 && end !== -1 ? body.slice(start, end) : body;
  if (/##\s*:x:/.test(section)) return "red";
  if (/##\s*:white_check_mark:/.test(section)) return "green";
  return null;
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

function sendPing(message) {
  return new Promise((resolve) => {
    execFile("meta", ["pingme.message", "send", `--message=${message}`], (err) => {
      if (err) console.error("pingme error:", err.message);
      resolve();
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
    notified[key] = true;
    changed = true;
    await sendPing(`[${host}] Broken CI: ${pr.title} ${pr.url}`);
  }

  for (const key of Object.keys(notified)) {
    if (!broken.has(key)) {
      delete notified[key];
      changed = true;
    }
  }

  if (changed) writeNotified(notified);
}

app.get("/api/prs", async (req, res) => {
  try {
    const prs = await execGh([
      "search", "prs",
      "--author=@me", "--state=open", "--limit=200",
      "--json", "number,title,repository,updatedAt,url,isDraft,state,createdAt,labels",
    ]);

    // Group PRs by repo to batch-fetch reviewDecision
    const byRepo = new Map();
    for (const pr of prs) {
      const repo = pr.repository.nameWithOwner;
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo).push(pr);
    }

    // Fetch reviewDecision per repo in parallel
    await Promise.all([...byRepo.entries()].map(async ([repo, repoPrs]) => {
      try {
        const details = await execGh([
          "pr", "list",
          "--repo", repo,
          "--author=@me",
          "--state=open",
          "--limit=200",
          "--json", "number,reviewDecision",
        ]);
        const decisionMap = new Map(details.map(d => [d.number, d.reviewDecision]));
        for (const pr of repoPrs) {
          pr.reviewDecision = decisionMap.get(pr.number) || "";
        }
      } catch {
        for (const pr of repoPrs) pr.reviewDecision = "";
      }
    }));

    // Fetch Dr. CI status for published (non-draft) PyTorch PRs. Dr. CI only
    // runs in the pytorch org, so skip everything else to avoid wasted calls.
    await Promise.all(prs.map(async (pr) => {
      pr.ciStatus = null;
      const owner = pr.repository.nameWithOwner.split("/")[0];
      if (pr.isDraft || owner !== "pytorch") return;
      try {
        const data = await execGh([
          "pr", "view", String(pr.number),
          "--repo", pr.repository.nameWithOwner,
          "--json", "comments",
        ]);
        const comments = data.comments || [];
        const drci = [...comments].reverse().find(
          c => c.author && c.author.login === "pytorch-bot" && c.body.includes("drci-comment-start")
        );
        if (drci) pr.ciStatus = drciStatus(drci.body);
      } catch {
        pr.ciStatus = null;
      }
    }));

    // Fire-and-forget so a slow/failed ping never blocks the response.
    notifyBrokenCI(prs).catch(e => console.error("notify error:", e.message));

    res.json(prs);
  } catch (e) {
    console.error("gh error:", e.message);
    res.status(500).json({ error: "Failed to fetch PRs" });
  }
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
