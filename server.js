const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
const SLEEP_FILE = path.join(__dirname, "sleep.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

app.get("/api/prs", (req, res) => {
  const args = [
    "search",
    "prs",
    "--author=@me",
    "--state=open",
    "--limit=200",
    "--json",
    "number,title,repository,updatedAt,url,isDraft,state,createdAt,labels,reviewDecision",
  ];

  execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      console.error("gh error:", err.message);
      return res.status(500).json({ error: "Failed to fetch PRs" });
    }
    try {
      const prs = JSON.parse(stdout);
      res.json(prs);
    } catch (e) {
      res.status(500).json({ error: "Failed to parse gh output" });
    }
  });
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
