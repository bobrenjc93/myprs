# My PRs

A personal dashboard for viewing all your open GitHub pull requests in one place.

## Features

- Groups PRs by repository
- Loads the latest shared server snapshot on every device, then refreshes from GitHub; the cache persists in `pr-cache.json` across server restarts
- Shows check/cross badges for PyTorch Claude reviews and CI merge signals, with an in-progress indicator while Claude reviews again
- Collapses ghstack PRs into one row with a stack icon and PR count; the bottom open PR supplies the title, status, and actions
- Pin repositories to the top with the Pin button in each repo header; pins are saved in your browser
- Sorts approved PRs to the top, then open PRs, then drafts
- Sleep/wake PRs to temporarily hide them
- Multi-select with shift-click for bulk actions
- Toggle draft and sleeping PR visibility
- Sort by oldest or newest first (newest by default)

## Prerequisites

- [Node.js](https://nodejs.org/)
- [GitHub CLI (`gh`)](https://cli.github.com/) authenticated with your account

## Setup

```sh
npm install
```

## Usage

```sh
npm start
```

Then open http://localhost:3000.
