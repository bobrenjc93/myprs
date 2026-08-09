# My PRs

`myprs` is a small local dashboard for tracking your own open GitHub pull requests.

It uses the GitHub CLI to fetch PRs authored by `@me`, groups them by repository, and gives you a fast way to sort, hide, and revisit work that is still in flight.

## What It Shows

The app fetches:

- open pull requests where the author is you
- repository metadata for grouping
- the current review decision for each PR when GitHub exposes it

That means you can quickly distinguish:

- approved PRs that may be ready to merge
- active non-draft PRs that still need attention
- drafts you are not ready to surface yet

## Features

- Groups PRs by repository
- Sorts approved PRs first, then other open PRs, then drafts
- Toggles draft visibility on and off
- Sorts by oldest first or newest first
- Lets you sleep PRs for a week to temporarily hide them
- Supports wake-up for individual sleeping PRs
- Supports shift-click multi-select for bulk sleep actions
- Stores sleeping state locally in `sleep.json`

## Requirements

- Node.js
- GitHub CLI (`gh`)
- An authenticated GitHub CLI session with access to the repos you want to inspect

You can verify authentication with:

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

Then open <http://localhost:3000>.

The server currently listens on port `3000`.

## Using The Dashboard

- Click a repository header to collapse or expand that group
- Use `Oldest first` to flip the sort direction
- Use `Drafts` to hide or reveal draft PRs
- Use `Sleeping` to show PRs you previously snoozed
- Select one or more PRs, then use `Sleep 1 week` in the action bar
- Hold `Shift` while selecting to bulk-select a contiguous range
- Use `Refresh` to re-run the GitHub queries

## How It Works

The backend calls `gh search prs` to find your open PRs, then fetches repository-specific PR details to attach `reviewDecision` where possible. Sleeping entries are stored in a local `sleep.json` file next to the app and are pruned automatically after they expire.

This is a local utility app. It does not persist anything to GitHub and it does not require any server-side credentials beyond your existing `gh` login.

## Troubleshooting

- If the page is empty, confirm `gh auth status` succeeds for the account you expect
- If PR data fails to load, run the app from a shell where `gh` is installed and already authenticated
- If you want to clear all sleeping state, remove `sleep.json` and refresh the page
