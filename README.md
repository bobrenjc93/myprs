# My PRs

`My PRs` is a small local dashboard for tracking your own open GitHub pull requests without bouncing between repositories or tabs. It uses the GitHub CLI for data collection and serves a lightweight UI with Express.

## What It Does

- Fetches up to 200 open pull requests authored by the authenticated GitHub user
- Groups pull requests by repository
- Prioritizes approved PRs first, then active non-drafts, then drafts
- Lets you sort by oldest-updated or newest-updated first
- Supports bulk selection with shift-click
- Lets you "sleep" PRs for one week so they stay out of the main list temporarily
- Shows labels, draft state, approval state, and relative created/updated times
- Lets you expand or collapse repository sections

## Requirements

- [Node.js](https://nodejs.org/)
- [GitHub CLI (`gh`)](https://cli.github.com/)
- A valid GitHub CLI login for the account whose PRs you want to view

## Installation

Install dependencies:

```sh
npm install
```

Authenticate the GitHub CLI if you have not already:

```sh
gh auth login
```

## Running The App

Start the server:

```sh
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

The server runs on port `3000` and serves both the UI and API from the same process.

## How It Works

- `GET /api/prs` uses `gh search prs --author=@me --state=open` to collect your PRs
- The server then fetches per-repository review decisions so approved PRs can be surfaced first
- Sleeping PR state is stored locally in `sleep.json`
- Expired sleep entries are automatically pruned when the app reads that file

## Project Structure

- `server.js`: Express server and GitHub CLI integration
- `public/index.html`: Single-page UI, styling, and client-side behavior
- `sleep.json`: Local hidden state for slept PRs, created on demand and ignored by git

## Troubleshooting

If the page shows `Failed to load PRs. Is gh authenticated?`, check the GitHub CLI first:

```sh
gh auth status
```

If needed, log in again:

```sh
gh auth login
```

If `localhost:3000` is unavailable, stop the conflicting process or update `PORT` in `server.js`.
