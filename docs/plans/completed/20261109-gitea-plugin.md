# Gitea / Forgejo plugin (bronos.gitea) 0.1.0

External review: sol / high

## Overview

- A cc-cockpit plugin for a self-hosted **Gitea or Forgejo** server, the same shape as `bronos.github` 0.1.0: lanes for
  review requests, the person's open PRs, issues for them and failed CI runs, unread marks, an item overlay
  (conversation, checks, files) with Discuss with Claude, and an `inbox-feed` v2 provider for Inbox.
- One plugin for both servers: Forgejo is a Gitea fork with the same `/api/v1`; differences are probed at run time.
- Sign-in: the server URL and a personal access token, as settings (the token a secret setting, kept by the app in
  the system keychain). Project fields with a global default, so work projects can use one server and personal ones
  another.
- Works on old and new servers alike: what a server lacks is left out quietly, never configured by hand.
  Targets: an old Gitea (1.23, no Actions log API), current Gitea, and Forgejo.
- Writes: only marking the server's notification read (Mark read, Done), and re-running failed jobs where the server
  has that API. Done is otherwise local (Gitea and Forgejo have no notification "done").
- Items follow `cc-cockpit-github/docs/item-convention.md` (ids, labels, action ids), so Inbox rules work across hosts.

## Context (from discovery)

- Source of most code: `~/Projects/cc-cockpit-github` (bronos.github 0.1.0, 139 tests): `dist/lib/{seen,feed,poll,logs,
  overlay,notifications,settings}.js`, `panels/{sanitize,itemview,rowlogic,item,main}.*`, `test/fakes.js`. Decision
  (Oleg, 2026-11-09): **copy, keep in step**: each copied file starts with a one-line note naming its source, as Theme
  Pack does with `palette.js`; no shared package.
- API facts checked against the swagger specs of Gitea v1.23.1, v1.24.0, current Gitea, and Forgejo 17 (codeberg.org):
  - all: `GET /version`, `/user`, `/user/teams`, `/repos/issues/search` (`type`, `state`, `review_requested`,
    `created`, `assigned`, `mentioned`, `page`, `limit`; results are Issues with `repository.full_name` and
    `pull_request {draft, merged, html_url}`), `/repos/{o}/{r}/pulls/{index}` (`draft`, `mergeable`, `head.sha`,
    `requested_reviewers`, `requested_reviewers_teams`), `/pulls/{index}/reviews`, `/pulls/{index}/files`,
    `/issues/{index}/comments`, `/commits/{ref}/status` (combined) and `/statuses`, `POST /markdown`
    (`Text`, `Mode`, `Context`), `/repos/{o}/{r}/notifications` (`status-types`, `subject-type`), `PATCH
    /notifications/threads/{id}?to-status=read`, and **`/repos/{o}/{r}/actions/tasks`** (jobs: `id`, `name`, `status`,
    `workflow_id`, `head_branch`, `head_sha`, `run_number`, `display_title`, `event`, `url`, times; `page`, `limit`
    only, no actor filter).
  - A task is one attempt of a job: its `id` is NOT a job id (separate sequences), and it carries `run_number`, not
    the run id. Job ids come only from `actions/runs/{run}/jobs`; run ids from `actions/runs` (Forgejo:
    `?run_number=N`; current Gitea: `?head_sha=` matched by `run_number`).
  - Gitea 1.24+: `GET /actions/jobs/{job_id}/logs` (but 1.24 has no runs/jobs list, so no way to a job id there). Current Gitea: `/actions/runs` (with `actor`, `branch`, `status`),
    `/actions/runs/{run}/rerun-failed-jobs`. Forgejo 17: `/actions/runs` (no actor), `/actions/runs/{run_id}/rerun`,
    `/actions/jobs/{job_id}/logs`.
  - Forgejo detection: `GET /api/forgejo/v1/version` answers on Forgejo only; its `/api/v1/version` reads like
    `17.0.0+gitea-1.22.0`.
  - Auth header for an access token: `Authorization: token <t>`. Scopes: `read:issue`, `read:repository`,
    `read:notification`, `write:notification`, `read:organization` (teams).
- Feed contract: `~/Projects/cc-cockpit-inbox/docs/design-v2.md`; secret settings: `ccc guide settings-secrets`
  (`"format": "secret"` top-level string, no default).

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change (`npm test` in the plugin repo)
- public repo: no work data anywhere. No server names, owners or repos from Oleg's employer; fixtures use
  `https://git.example.com`, `acme/widgets`, `alice`, `bob`, `me`

## Testing Strategy

- **unit tests**: `node:test`; the copied `test/fakes.js` adapted: a fake server answering by method + path under a
  base URL (Gitea and Forgejo flavours, an "old Gitea" without Actions logs), a fake `ctx` with secret settings, a
  fake clock. Copied modules keep their copied tests (adapted).
- **page logic**: copied pure page modules with their linkedom tests.
- **e2e**: none; manual verification in the dev app against the work Gitea (Oleg enters the URL and token there) and
  a Forgejo server (Post-Completion).

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

- **Host** wires: settings (server URL, token) → client (one origin, `token` header) → server probe (flavour, version,
  features) → poller → search + PR enrichment → model → failed tasks → seen → feed and panel. Same flow and storage
  as GitHub (`list:<key>`, `seen:<key>` in `ctx.appStorage`), keyed by `<origin + path prefix>/<login>` so two servers
  (even two on one host) or two accounts never mix.
- **No GraphQL**, so a PR's state needs REST calls of its own. A per-PR cache keyed by `updated_at` keeps them down:
  `pulls/{n}` + `reviews` + the last comments only when `updated_at` moved; the head's combined status every poll
  (a status change does not move `updated_at`), for at most 30 PRs a poll (newest first; the rest keep their last
  state). About 4 search calls + a few PR calls per poll after the first.
- **Feature probe** per server, cached in memory and redone every 6 hours and after a settings change: flavour and
  version from `/version` (+ `/api/forgejo/v1/version`; versions compared numerically; Forgejo's
  `17.0.0-…+gitea-1.22.0` is read as Forgejo 17, never as Gitea 1.22; Gitea's `29.0.0+dev-…` as 29; a version that
  does not parse turns every optional feature off). Features: `runsApi` (current Gitea or Forgejo: `actions/runs` and
  `runs/{run}/jobs` answer), `jobLogs` (only with `runsApi`, since a job id can only be found through it), `rerun`
  (current Gitea `rerun-failed-jobs`, Forgejo ≥ 17 `rerun`). `/actions/tasks` is there on every version; Actions is
  switched on per repo, so a 404/403 there skips that repo alone (remembered for the probe interval), never the
  feature. A probe never fails a poll.
- **Failed runs** from `/actions/tasks` everywhere (the one Actions list every version has). Tasks are job attempts
  with no actor, so "yours" means: its `head_sha` is the head of one of your open PRs (the PR `head.sha` values the
  poll already has; the branch name only as a fallback when no sha matches, since a `pull_request` event's branch is
  Gitea's pretty ref and forks share branch names). Grouped into runs by `run_number`; a run is failed while its
  newest failing job (key `workflow_id` + job `name` + branch) has no later success of that same key; 7 days at most.
- **Security**: the token goes only to the configured origin's `/api/` paths (never on a redirect, never to another
  host, job-log redirects included); `http://` is refused except for loopback hosts (`localhost`, `127.0.0.1`,
  `[::1]`); a token is **bound to the server it first signed in to** (below), so a project that overrides only the
  server URL never sends the global token to another server; pages get plain data; server
  text is untrusted (rendered Markdown through the copied sanitiser); links open only from the host's own list and
  the server's own origin.

## Technical Details

**Settings** (project fields with a global default, `ccc guide settings-secrets`): `serverUrl` (string, e.g.
`https://git.example.com`; normalised to origin + optional path prefix, trailing slash dropped; `https:` required,
`http:` only for `localhost`/`127.0.0.1`/`::1`; anything else: state `signedOut` with "Set the server address in
Settings"), `token` (`"format": "secret"`, top-level string, no default), plus the GitHub plugin's `lanes`,
`rowsPerLane`, `markReadOnOpen`, `exclude`, `pollMinutes`. No `ghPath`.

**Token binding**: the URL and the token are separate fields, each with a global default, so a project can override
one and inherit the other. On a token's first successful `/user`, `ctx.appStorage` `tokens` records
`sha256(token) → origin + prefix`. Before any request, a token bound to another server is refused: state `signedOut`,
"This token belongs to <other server>: set this project's token in Settings". The panel's notice then offers "Use
this token for <server>" (the person's click rebinds it, for a server that moved); nothing rebinds on its own.

**Host name** in labels: "Gitea" or "Forgejo" from the probe ("Open on Gitea", "Done on Forgejo"); `describe()` label
the same, badge `GT` / `FJ`, colour green / amber. The item `source` is the plugin id, as Inbox sets it.

**Lane queries** (`/repos/issues/search`, `state=open`, `limit=50`, 2 pages at most):
- reviewRequested: `type=pulls&review_requested=true`; a team request (PR `requested_reviewers_teams` ∩ `/user/teams`,
  cached 1 h) gives `team-review-requested` instead of `review-requested`
- myPrs: `type=pulls&created=true`
- issues: `type=issues&assigned=true` and `type=issues&mentioned=true` (merged by id; assigned wins for `to`)

**Item**: exactly the convention's ids, fields, labels and action ids (see `docs/item-convention.md` in
cc-cockpit-github); a run is `run:o/r/<run_number>` (stable across re-run attempts, as the convention's run id),
title `o/r CI failed: <workflow name> on <branch>`. `rev` as for GitHub: others' newest comment and review time,
newest failing head sha; run: the newest failed task id (a re-run that fails again is new). `ci:failed` / `ci:pending`
from the head's combined status (`failure`/`error` → failed, `pending` → pending). `conflict` from `mergeable: false`.
`changes-requested` / `approved`: the newest review per reviewer (`REQUEST_CHANGES` / `APPROVED`), Gitea having no
review decision.

**Notifications**: on Mark read / Done: `GET /repos/{o}/{r}/notifications?status-types=unread&subject-type=pull&subject-type=issue&limit=50` (cached per
repo 60 s), match `subject.url` or `subject.html_url` to the item, `PATCH /notifications/threads/{id}?to-status=read`.
Failures logged only. No `done` on the server.

**Errors**: 401/403 on `/user` → `signedOut` ("The token was refused: check it in Settings"); 403 elsewhere → that
call's feature is skipped and logged once; 429 or `Retry-After` → wait as GitHub's rate limit; network errors →
backoff (copied poller). No token refresh exists.

**Overlay details** (on open): PR → `pulls/{n}`, the body rendered by `POST /markdown {Text, Mode: 'gfm', Context:
'o/r'}` (comments and reviews too, at most 20 renders, each cached by text hash), timeline from comments + reviews,
checks = combined status `statuses` (context, state, description, `target_url`) plus the failed tasks of that head
sha; log tails only where `jobLogs`: run id resolved (Forgejo `actions/runs?run_number=N`, current Gitea
`actions/runs?head_sha=<sha>` matched by `run_number`), job ids from `runs/{run}/jobs` matched by job name, then
`jobs/{job_id}/logs`. A task id is never used as a job id (it could show another job's log). Without `jobLogs` (Gitea
1.23 and 1.24) a failed job links to its web page. Logs are read as a stream keeping only the last 64 KiB (a server may
ignore `Range`), aborted at a 20 MB read cap; a redirect is followed only to https and without the token. Files from
`pulls/{n}/files` with patches capped at 1 MB in total. Issue → `issues/{n}` + comments. Run → the tasks of that run
number, log tails where available.

**Re-run** (where `rerun`): resolve the run id as above, then Gitea `POST actions/runs/{run}/rerun-failed-jobs`,
Forgejo `POST actions/runs/{run_id}/rerun`; the GitHub rules: once per attempt, refused while any task of the run is
queued or running, refused once the run passed.

**Web URLs** (Open on Gitea): built from the configured base plus the path (`<base>/<o>/<r>/pulls/<n>`,
`/issues/<n>`), never taken from `html_url` as is (the server builds it from its own ROOT_URL, which may be another
host name or scheme than the one the person entered). A run: the task's `url` when its path passes the check, rebased
onto the configured base; else `<base>/<o>/<r>/actions/runs/<run_number>`. Relative links in rendered Markdown
(`/o/r/issues/1`) are resolved against the base before the overlay's link check.

## What Goes Where

- **Implementation Steps**: the new repo `~/Projects/cc-cockpit-gitea`.
- **Post-Completion**: public repo creation (Oleg), manual tests, release, marketplace listing, a line in the GitHub
  plugin's convention doc naming this plugin as the second implementation.

## Implementation Steps

### Task 1: Scaffold, copied modules and test fakes [model: sonnet]

**Files:**
- Create: `plugin.json`, `package.json`, `LICENSE`, `.gitignore`, `icons/gitea.svg`, `dist/host.js` (stub),
  `test/fakes.js`, `test/manifest.test.js`
- Copy (with a "copied from cc-cockpit-github, keep in step" first line): `dist/lib/{seen,poll}.js` (`logs.js` is
  adapted in Task 10, not copied),
  `panels/{sanitize,itemview,rowlogic,item,main}.{js,html}` and their tests

- [x] manifest: id `bronos.gitea`, name "Gitea / Forgejo", api 1, `services.provides {"inbox-feed": 2}`, panel `main`
      (right zone), project settings per Technical Details (`token` secret)
- [x] copy the listed modules and tests unchanged except names (`gh` → `gt` globals, GitHub → host-name parameters)
      ⚠️ deviation: identifiers (`gh*` globals, `gh-` classes) kept as is so a sync stays a plain diff; only
      user-visible host names changed
- [x] `test/fakes.js`: fake server by base URL with flavours `gitea-1.23`, `gitea-1.24`, `forgejo-17`
- [x] write manifest tests (secret field shape, no regex in the schema, provides inbox-feed 2)
- [x] run tests - must pass before next task

### Task 2: Settings and server URL [model: sonnet]

**Files:**
- Create: `dist/lib/settings.js`, `test/settings.test.js`

- [x] `normalize(raw)` as GitHub's minus `ghPath`, plus `serverUrl` parsing (https; http on loopback only, `[::1]`
      included; path prefix kept; credentials, query and fragment refused) and `token` presence (value never logged)
- [x] write tests for valid URLs (prefix, trailing slash, port) and refused ones (http remote, `user:pass@`, junk)
- [x] run tests - must pass before next task

### Task 3: Client for one origin [model: opus]

**Files:**
- Create: `dist/lib/client.js`, `test/client.test.js`

- [x] `createClient({fetch, base, token, now, log})`: `rest(method, path, {query, body, raw, maxBytes})`, `pages()`
      following `Link: next` only on the same origin + prefix, `Authorization: token`, `redirect: 'manual'` (a redirect
      is an error, never followed with the token), path shape check as GitHub's (no `%`, no dot segments), API paths
      `/api/v1/…` and `/api/forgejo/v1/version` under the base's path prefix
- [x] token binding (`sha256(token) → origin + prefix` in appStorage, refuse elsewhere, explicit rebind)
- [x] errors: `HttpError`, `RateLimited` (429 / `Retry-After`), `NetworkError`, `SignedOut` (401)
- [x] write tests: token only to the base origin, redirect refused, pagination stays on origin, caps, errors, a
      prefix base, a token bound to another server refused before any request, rebind
- [x] run tests - must pass before next task

### Task 4: Server probe [model: opus]

**Files:**
- Create: `dist/lib/probe.js`, `test/probe.test.js`

- [x] flavour + version (`/version`, `/api/forgejo/v1/version`, numeric compare), host name,
      `features {runsApi, jobLogs, rerun}` (version rules + a probe of `actions/runs` on a known repo), cache 6 h, reset
      on settings change; a failing probe leaves features off and is logged once
      ➕ runsApi is learned (`learnRuns`) on the first repo whose `actions/tasks` answered, not by version: the Gitea
      release that added the runs list is not documented, and a repo with Actions off must not decide it
- [x] write tests for the three fake flavours, a probe that errors, and version strings: `1.23.1`, `1.24.0`,
      `29.0.0+dev-160-g55186ca39b`, `17.0.0-99-322c239+gitea-1.22.0`, junk
- [x] run tests - must pass before next task

### Task 5: Search and PR enrichment [model: opus]

**Files:**
- Create: `dist/lib/search.js`, `test/search.test.js`, fixtures

- [x] lane searches; per-PR cache by `updated_at` (`pulls/{n}`, `reviews`, last comments); head combined status every
      poll for at most 30 PRs; teams from `/user/teams` (1 h)
      ➕ issues get their newest comments the same way (cache by `updated_at`, 30 a poll): issue `rev` is built from
      other people's comments, and the search answers no comment text
- [x] write tests: each lane, pagination cap, cache hit vs `updated_at` moved, status refreshed every poll, the 30 cap,
      teams cached
- [x] run tests - must pass before next task

### Task 6: The item model [model: opus]

**Files:**
- Create: `dist/lib/model.js`, `test/model.test.js`

- [x] `buildItems` per the convention (ids, rev, preview, from/to, mentionsMe, place, labels, actions with host name),
      review state from the newest review per reviewer, web URLs from the base
- [x] write tests: team request, review state per reviewer, ci labels, own actions not moving `rev`, caps, exclusions,
      broken results left out, URLs built from the base when `html_url` has another host
- [x] run tests - must pass before next task

### Task 7: Failed runs from Actions tasks [model: sonnet]

**Files:**
- Create: `dist/lib/runs.js`, `test/runs.test.js`

- [x] per repo of the person's open PRs (at most 10): `/actions/tasks` (2 pages of 50), failures whose `head_sha` is an
      open PR head (branch fallback), grouped by `run_number`, superseded per `workflow_id` + job `name` + branch, 7
      days; `runItem` (`run:o/r/<run_number>`, rev newest failed task id); `linkPrRuns`
- [x] a 404/403 repo is skipped alone and remembered until the next probe
- [x] write tests: sha match, branch fallback, a fork's same branch name not matched, supersession by another job of
      the same workflow not hiding the failure, age, a 404 repo not hiding another repo's runs, stable id on a re-run
- [x] run tests - must pass before next task

### Task 8: Notifications and the feed [model: sonnet]

**Files:**
- Create: `dist/lib/notifications.js`, `dist/lib/feed.js` (copied, host name parameter), tests

- [x] notifications as in Technical Details (read only); feed copied with action labels from the host name and
      `describe()` from the probe
- [x] write tests: thread matched by url and marked read, no match, failures logged; feed labels for both flavours
- [x] run tests - must pass before next task

### Task 9: Poller and host wiring [model: opus]

**Files:**
- Modify: `dist/host.js`
- Create: `test/host.test.js`

- [x] host as GitHub's: settings → client → probe → poll order (login, search, enrich, items, runs every 5 min, seen,
      feed, store, post), storage keyed `<host>/<login>`, panel messages, header refresh, signed-out states for a missing
      URL / token and a refused token
- [x] write tests: start, panel, lanes off, signed out (four reasons: no URL, no token, refused, bound elsewhere) and
      the rebind click, restart from the stored list, the token never in storage / posts / emits / headers / logs (its
      hash only in `tokens`), server switch keeps lists apart, two servers on one host apart
- [x] run tests - must pass before next task

### Task 10: Item details and log tails [model: opus]

**Files:**
- Create: `dist/lib/details.js`, `dist/lib/logs.js` (adapted from GitHub's: `failedStepTail` kept, fetching new),
  `test/details.test.js`, `test/logs.test.js`

- [x] PR / issue / run details per Technical Details, Markdown rendered by the server (relative links resolved),
      `discussText` as GitHub's
- [x] log tails where `jobLogs`: run id lookup per flavour, job id by name from `runs/{run}/jobs`, streamed tail with
      the read cap, redirect without the token
- [x] write tests for both flavours and old Gitea (links, no tails), a task id never used as a job id, a server
      ignoring Range, a redirect, render cap, files cap
- [x] run tests - must pass before next task

- ⚠️ `pulls/{n}/files` carries no patches on any version: patches come from `pulls/{n}.diff` (read up to 1 MB, split
  per file; a cut diff marks its last file too big). Forgejo's `runs/{id}/jobs` gives each job's `task_id`, matched
  exactly; Gitea's only by name (two failed same-name jobs: no tail). The `/markdown` `Context` (`<prefix>/<o>/<r>`)
  is checked in the manual test (relative issue links).

### Task 11: Re-run failed jobs [model: opus]

**Files:**
- Modify: `dist/lib/details.js`
- Create: `test/rerun.test.js`

- [x] `rerun(client, item, attempts, features)`: run id lookup, Gitea `rerun-failed-jobs` / Forgejo `rerun`, once per
      attempt, refused while running, after a pass, or when `rerun` is off (the action is then not offered at all)
- [x] write tests for both flavours and each refusal
- [x] run tests - must pass before next task

- ⚠️ Forgejo's `runs/{run_id}/rerun` restarts every job, so Forgejo re-runs each failed job (`jobs/{job_id}/rerun`)
  to match "Re-run failed jobs"; its attempt is the failed jobs' task ids (Forgejo has no run attempt).

### Task 12: Overlay and panel [model: sonnet]

**Files:**
- Create: `dist/lib/overlay.js` (copied: toolbar order Open first, Mark done last), `panels/*` host-name changes
- Modify: copied page tests

- [x] overlay links: the host's list plus the configured origin; toolbar labels with the host name
- [x] panel: lanes and empty states (no server set → a Settings hint; token bound elsewhere → the rebind button)
- [x] write tests for links, buttons per flavour and the new empty states
- [x] run tests - must pass before next task

### Task 13: README, preview and convention test [model: sonnet]

**Files:**
- Create: `README.md`, `preview.png`, `test/convention.test.js`

- [x] README: what it shows, creating a token (scopes listed), what works on which server version, what it writes,
      settings (global server vs per project), Inbox rules, privacy
- [x] preview logo card (marketplace recipe, Gitea green to Forgejo amber)
- [x] convention test: every label and action id used is listed in the GitHub plugin's convention (a copy of its table
      kept in `test/fixtures/convention-ids.json`, with a note to update both)
- [x] run tests - must pass before next task

### Task 14: Verify acceptance criteria [model: sonnet]

- [x] verify all requirements from Overview are implemented
- [x] verify edge cases (no URL, bad token, token bound elsewhere, old Gitea, Forgejo, rate limit, empty lanes,
      excluded repos, a repo without Actions, big diffs and logs)
- [x] run full test suite: `npm test`
- [x] grep the repo for work data (employer, server names, emails other than the author's)
- [x] verify the token never appears in logs, posts, emits, storage or headers (Task 8 test green)

### Task 15: [Final] Update documentation [model: sonnet]

- [x] update README.md if needed
- [x] add a short CLAUDE.md (layout, copied files and their source, the probe, test command)
- [x] move this plan to `docs/plans/completed/`

## Post-Completion

*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**:
- dev app against an old Gitea (Oleg enters URL and token): lanes, CI labels, failed runs from tasks, no log
  tails, Mark read clearing the server's notification; again after an upgrade (log tails only with the runs API)
- a Forgejo server: flavour detection, labels "Forgejo", re-run on Forgejo 17

**External**:
- Oleg creates `BronOS/cc-cockpit-gitea`; release 0.1.0 and the marketplace listing on his word
- cc-cockpit-github `docs/item-convention.md`: name bronos.gitea as the second implementation (own commit, no release
  needed)
