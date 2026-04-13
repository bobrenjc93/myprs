# myprs

`myprs` is a small local dashboard for the pull requests you authored. It uses the GitHub CLI (`gh`) as its data source and serves a lightweight web UI with no build step.

## What It Shows

- Open pull requests where the author is `@me`
- PRs grouped by repository
- Approved PRs surfaced ahead of other open PRs, with drafts last
- Toggle controls for draft PRs and sleeping PRs
- Shift-click multi-select with bulk sleep for one week
- Oldest-first or newest-first ordering

## Requirements

- Node.js
- [GitHub CLI (`gh`)](https://cli.github.com/)
- GitHub authentication configured through `gh auth login`

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open `http://localhost:3000`.

## How It Works

- The server listens on port `3000` and serves the static UI from `public/`.
- The app fetches your open PRs with `gh search prs --author=@me --state=open`.
- It then enriches each repository's PRs with `reviewDecision` via `gh pr list` so approved PRs can be highlighted and sorted.
- Sleeping state is stored locally in `sleep.json`, and expired entries are removed automatically.

## Troubleshooting

- If the UI shows a load error, run `gh auth status` and confirm the authenticated account can access the repositories you expect.
- The app currently listens on a fixed port. If `3000` is occupied, update `PORT` in `server.js`.
- Delete `sleep.json` if you want to reset all sleeping PRs.
