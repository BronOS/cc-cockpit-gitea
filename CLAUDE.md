# cc-cockpit-gitea

cc-cockpit plugin `bronos.gitea` ("Gitea / Forgejo"): review requests, own PRs, issues and failed Actions runs from a
self-hosted Gitea or Forgejo server in a panel and overlay, and an `inbox-feed` v2 provider for the Inbox plugin.
Plain JavaScript, no build. `ccc guide api` / `ccc guide style` / `ccc guide settings-secrets` are the plugin API, the
page style rules and the secret settings.

## Layout

- `dist/host.js`: the plugin host entry (settings → client → probe → poll, panel messages, stored list keyed
  `<server base>/<login>`); `dist/lib/*`: one concern per file (settings, client and token binding, probe, search and
  enrichment, model, runs, seen marks, notifications, feed, poll, details and re-run, logs, overlay).
- `panels/`: the main panel (`main.*`, lane logic in `rowlogic.js`) and the item overlay (`item.*`, `itemview.js`,
  `sanitize.js`); the shared logic files are UMD so `node:test` can load them.
- `docs/plans/completed/`: the implementation plan (API facts per server version, decisions, review notes).

## Copied from cc-cockpit-github

Copy, keep in step: each copied or adapted file says so in its first lines, with what differs. Copied as is (log prefix
and user-visible host names aside): `dist/lib/{seen,poll}.js`, `panels/*`, their tests. Adapted (same output shape,
Gitea's REST underneath): `feed.js` (host name, re-run feature), `model.js`, `notifications.js` (match by path, no
server "done"), `details.js`, `logs.js`, `overlay.js` (host name, links on the configured server). A fix in one plugin
is checked against the other. Labels and actions follow cc-cockpit-github `docs/item-convention.md`; its tables are
copied in `test/fixtures/convention-ids.json` (update both).

## The probe

`dist/lib/probe.js` reads `/version` and Forgejo's `/api/forgejo/v1/version` (6 h cache per server) and learns once
whether the Actions runs API exists (`actions/runs` on a repo whose `actions/tasks` answered). Features follow from
it: `runsApi`, `jobLogs` (= runsApi), `rerun` (runsApi and Gitea ≥ 1.26 or Forgejo ≥ 17). Failed runs come from
`actions/tasks` on every version; a task id is never a job id (job ids only from `runs/{id}/jobs`).

## Commands

- `npm install` (dev only: linkedom), `npm test` (`node --test test/`).
- `ccc plugin link .` to try it in the app.

## Rules

- The token is a secret setting: it reaches only `createClient` (`settings.tokenOf`); never store, post, emit or log
  it (host test checks). A token is bound to its first server (`sha256 → base` in appStorage `tokens`); only the
  person's rebind click moves it.
- Requests go to the configured base only; a redirect is followed only for a job log, https, without the token.
- Item URLs are built from the configured base, never from the server's `html_url` (its ROOT_URL may differ).
- Writes on the server are only re-run failed jobs and notification read, each on the person's click.
- Overlay links open only if the host found them in the details or they are under the configured server; HTML from the
  server goes through `sanitize.js`.
- Test data is made up (`git.example.com`, `acme/widgets`, `me`, `alice`, `bob`); no work data in this public repo.
