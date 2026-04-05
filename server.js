const express = require("express");
const { execFile } = require("child_process");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/prs", (req, res) => {
  const args = [
    "search",
    "prs",
    "--author=@me",
    "--state=open",
    "--limit=200",
    "--json",
    "number,title,repository,updatedAt,url,isDraft,state,createdAt,labels",
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
