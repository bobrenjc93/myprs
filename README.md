# My PRs

`myprs` is a local dashboard for tracking the open pull requests you authored across repositories. It uses the GitHub CLI for data, serves a small single-page UI, and lets you temporarily hide PRs that do not need attention right now.

## What It Shows

- Open PRs authored by the currently authenticated GitHub user
- Repository-grouped results across all repos visible to `gh`
- PR labels, relative timestamps, and draft or approved status
- Approved PRs first, then other open PRs, then drafts

## UI Features

- Toggle between oldest-first and newest-first sorting
- Show or hide drafts
- Show or hide sleeping PRs
- Collapse repository groups
- Select multiple PRs, including shift-click range selection
- Sleep selected PRs for 7 days
- Wake sleeping PRs early
- Refresh data on demand

## Requirements

- Node.js
- GitHub CLI (`gh`)
- An authenticated GitHub session. Check with:

```sh
gh auth status
```

## Install

```sh
npm install
```

## Run

```sh
npm start
```

Then open `http://localhost:3000`.

This app currently binds to port `3000` directly in `server.js`.

## Sleep State

Sleeping PRs are stored in `sleep.json` in the repo root. The file is created on first write, and expired entries are removed automatically when the app reads sleep state.

## How It Fetches Data

The server combines two GitHub CLI queries:

- `gh search prs --author=@me --state=open` for the base PR list
- `gh pr list` per repository to enrich each PR with `reviewDecision`

## Development Notes

- Static files are served from `public/`
- Restart the server after editing `server.js`
- Refresh the browser manually after frontend changes
