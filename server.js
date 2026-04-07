const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
const SLEEP_FILE = path.join(__dirname, "sleep.json");

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
