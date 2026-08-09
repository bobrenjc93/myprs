# My PRs

`myprs` is a small local dashboard for pull requests you opened yourself. It uses the GitHub CLI for data collection and gives you a fast browser view for triaging your open PRs across repositories.

## What It Shows

- Open PRs authored by `@me`
- Repository grouping with collapsible sections
- Review status when GitHub reports a `reviewDecision`
- Draft PRs, sleeping PRs, labels, and created/updated timestamps

## Workflow Features

- Prioritizes approved PRs first, then active non-draft PRs, then drafts
- Toggles draft visibility on and off
- Toggles sleeping PR visibility on and off
- Switches between oldest-first and newest-first sorting
- Supports shift-click multi-select
- Sleeps one or more PRs for a week
- Wakes sleeping PRs individually

## Requirements

- Node.js
- GitHub CLI (`gh`)
- An authenticated GitHub session, usually via `gh auth login`

You can confirm the CLI is ready with:

```bash
gh auth status
```

## Getting Started

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

Then open `http://localhost:3000`.

## How It Works

The app serves a static frontend from `public/` and exposes a small JSON API from `server.js`.

- `GET /api/prs` runs `gh search prs --author=@me --state=open`
- Each repository is queried again to enrich PRs with `reviewDecision`
- `GET /api/sleep`, `POST /api/sleep`, and `DELETE /api/sleep/:key` manage snoozed PRs

## Local State

Sleeping PRs are stored in `sleep.json` in the repository root. The file is created on demand and expired entries are pruned automatically when the app reads it.

## Troubleshooting

- If the UI shows `Failed to fetch PRs`, check `gh auth status` first.
- The server listens on port `3000`.
- Sleeping PR state is local to this checkout because it is stored in `sleep.json`.
