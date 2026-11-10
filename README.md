# Gitea / Forgejo for cc-cockpit

A [cc-cockpit](https://github.com/BronOS/cc-cockpit) plugin (`bronos.gitea`) that keeps your work on a Gitea or Forgejo
server next to your Claude Code sessions:

- **Review requested**: pull requests waiting for your review (yours or your team's).
- **My pull requests**: your open PRs, with what happened last (a review, a comment, CI failing, a conflict).
- **Issues**: issues assigned to you or mentioning you, and, if you turn it on, the issues you opened.
- **Failed runs**: Actions runs on your open PRs that failed in the last 7 days, until a later run of the same job
  passes.

Each lane has unread marks. A click opens the item in an overlay:
- **PR:** the description and conversation, the checks (with the end of each failed job's log where the server has
  the API, see below), and the changed files.
- **Issue:** its body and comments.
- **Failed run:** its jobs, with their log tails where the server has the API.

**Discuss with Claude** sends the item, its URL and what failed to a Claude session.

It also feeds the [Inbox](https://github.com/BronOS/cc-cockpit-inbox) plugin: every item shows there under Gitea (or
Forgejo), with labels your Inbox rules can use.

## Requirements

- cc-cockpit 0.16.2 or newer.
- A Gitea (1.23 or newer) or Forgejo server you can reach over https (http only for `localhost`).
- A personal access token (on the server: Settings > Applications > Generate New Token) with:

| Scope | For |
|---|---|
| `read:user` | your login |
| `read:issue` | pull requests, issues, comments, reviews |
| `read:repository` | commit statuses, changed files, Actions runs and logs |
| `read:notification`, `write:notification` | marking the server's notification read with Mark read and Done |
| `read:organization` | your teams, to tell a team review request from a direct one |
| `write:repository` | only for Re-run failed jobs; leave it out and Re-run answers that it was refused |

## What works on which server

The plugin asks the server for its version and what its API has, every few hours, and uses what is there.

| | Gitea 1.23, 1.24 | Gitea 1.26 and newer | Forgejo 17 and newer |
|---|---|---|---|
| Lanes, overlay, Inbox, notifications | yes | yes | yes |
| Failed runs | yes | yes | yes |
| Log tails of failed jobs | no: a failed job links to its page | yes | yes |
| Re-run failed jobs | no | yes | yes |

A repository with Actions switched off is skipped for failed runs (asked again after the next version check).

## What it changes on the server

Only two things, and only when you ask:

- **Re-run failed jobs** of a failed run (or of the failing run of your PR's head): once per run attempt, never while
  the run is going, and only on servers that have the API. On Forgejo each failed job is re-run on its own (its
  run-level re-run would restart the jobs that passed too).
- **Mark read** and **Done** also mark the matching notification read on the server, so its bell agrees. Gitea and
  Forgejo have no "done" for notifications: Done hides the item in cc-cockpit and marks the notification read.

It never comments, reviews, merges, closes or pushes. Do those yourself, or ask Claude.

## Settings

Per project, with a global default (Settings > Plugins > Gitea / Forgejo). Set the server and the token once globally
and every project uses them; a project that works on another server overrides them there.

| Setting | Default | |
|---|---|---|
| Server address | none | `https://git.example.com`, or with a path (`https://example.com/git`) |
| Access token | none | stored encrypted by the app, never in a settings file |
| Lanes | all on | a lane that is off is not fetched and never reaches Inbox |
| Items per lane | 10 | the rest are behind Show all |
| Also issues I opened | off | your open issues in the Issues lane even when nobody assigned them (labelled `my-issue`) |
| Mark an item read when I open it | on | |
| Leave out | none | owners (`acme`) or repositories (`acme/widgets`) |
| Check every (minutes) | 2 | 2 to 15; failed runs at most every 5 minutes |

A token is **bound to the server it first signed in to**: if a project points the same token at another address, the
plugin refuses to send it there and says so. If your server moved, the panel's "Use this token for …" button moves
the token with it; nothing rebinds on its own.

## Inbox rules

Items carry these labels:
- **Kind:** `pr`, `issue`, `run`.
- **Your role:** `review-requested`, `team-review-requested`, `my-pr`, `my-issue`, `assigned`, `mentioned`.
- **PR state:** `changes-requested`, `approved`, `ci:failed`, `ci:pending`, `conflict`, `draft`.
- **Where:** `repo:<owner>/<repo>`, `owner:<owner>`.

They follow the convention shared with the GitHub plugin
([item-convention.md](https://github.com/BronOS/cc-cockpit-github/blob/main/docs/item-convention.md)), so one set of
rules covers both. A good start:
- **Now:** `review-requested`; `my-pr` with `ci:failed`; `my-pr` with `changes-requested`.
- **Later:** `team-review-requested` and `mentioned`.

## Privacy

- Requests go to the server address you set, with your token, and nowhere else. A redirect is never followed with the
  token; a job log the server hands to object storage is fetched there without it.
- The token is kept by the app in the system keyring. The plugin stores only a hash of it, to know which server it
  belongs to; it never logs, posts or stores the token itself.
- The last list and your read marks are kept in the app's plugin storage, per server and login.

## Development

```sh
npm install   # dev only: linkedom for the page tests
npm test
ccc plugin link .
```

The plugin is plain JavaScript with no build: `dist/host.js` and `dist/lib/*` run in the plugin host, `panels/*` in
the panel and overlay pages. Several files are copied from the
[GitHub plugin](https://github.com/BronOS/cc-cockpit-github) and say so in their first lines; keep them in step.

## Licence

MIT
