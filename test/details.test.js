'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const d = require('../dist/lib/details')
const { infoOf } = require('../dist/lib/probe')
const { createClient, createBinding } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, memStore, json, text, BASE, TOKEN } = require('./fakes')
const { T, review, comment } = require('./builders')

const quiet = { info() {}, warn() {}, error() {} }
const OLD = infoOf('gitea', '1.23.1', false)
const GITEA = infoOf('gitea', '1.26.0', true)
const FORGEJO = infoOf('forgejo', '17.0.0', true)

const prItem = { id: 'pr:acme/widgets#1', title: 'acme/widgets#1 Fix login', place: { status: 'failing' }, _: { kind: 'pr', repo: 'acme/widgets', number: 1, url: `${BASE}/acme/widgets/pulls/1` } }
const issueItem = { id: 'issue:acme/widgets#5', title: 'acme/widgets#5 Broken', _: { kind: 'issue', repo: 'acme/widgets', number: 5, url: `${BASE}/acme/widgets/issues/5` } }
const runIt = { id: 'run:acme/widgets/4', title: 'acme/widgets CI failed: ci on feature', _: { kind: 'run', repo: 'acme/widgets', runNumber: 4, workflow: 'ci', branch: 'feature', sha: 'abc1234', url: `${BASE}/acme/widgets/actions/runs/4` } }

// Task ids (900s) and job ids (30s) are separate sequences on purpose: a log asked by task id would 404 here.
const task = (id, name, status = 'failure', run = 4, sha = 'abc1234') => ({ id, name, status, run_number: run, head_sha: sha, head_branch: 'feature', workflow_id: 'ci.yml', event: 'pull_request', display_title: 'Fix login', created_at: T(8), updated_at: T(8) })
const DIFF = ['diff --git a/src/a.js b/src/a.js', 'index 1..2 100644', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1 +1 @@', '-old', '+new', 'diff --git a/src/b.js b/src/b.js', '--- a/src/b.js', '+++ b/src/b.js', '@@ -1 +1,2 @@', ' x', '+y', ''].join('\n')

/** A world for one PR, issue and run; `flavour` picks the runs API shape. */
function world(over = {}) {
  const renders = []
  const routes = [
    ...(over.routes || []),
    ['POST', '/markdown', (u, init) => {
      const b = JSON.parse(init.body)
      renders.push(b)
      return text(`<p>${b.Text}</p><a href="/acme/widgets/issues/2">#2</a><img src="/attachments/x.png">`)
    }],
    ['GET', '/repos/acme/widgets/pulls/1', () => json({ number: 1, state: 'open', draft: false, merged: false, body: 'Fixes **login**', head: { ref: 'feature', sha: 'abc1234' }, base: { ref: 'main' }, user: { login: 'me' }, additions: 2, deletions: 1, changed_files: 2 })],
    ['GET', '/repos/acme/widgets/issues/1/comments', () => json(over.comments || [comment('alice', 3, 'Looks off')])],
    ['GET', '/repos/acme/widgets/pulls/1/reviews', () => json(over.reviews || [review('bob', 'REQUEST_CHANGES', 4, 'Add a test'), review('carol', 'PENDING', 5, 'draft')])],
    ['GET', '/repos/acme/widgets/pulls/1/files', () => json([{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 1 }, { filename: 'src/b.js', status: 'modified', additions: 1, deletions: 0 }, { filename: 'img.png', status: 'added' }])],
    ['GET', '/repos/acme/widgets/pulls/1.diff', () => (over.diff ? over.diff() : text(DIFF))],
    ['GET', '/repos/acme/widgets/commits/abc1234/status', () => json({ state: 'failure', total_count: 2, statuses: [
      { context: 'ci / test (pull_request)', status: 'failure', target_url: '/acme/widgets/actions/runs/4/jobs/1', description: 'Failing after 3s' },
      { context: 'ci / lint (pull_request)', status: 'success', target_url: '/acme/widgets/actions/runs/4/jobs/0' },
    ] })],
    ['GET', '/repos/acme/widgets/actions/tasks', () => json({ workflow_runs: over.tasks || [task(901, 'test'), task(902, 'lint', 'success')], total_count: 2 })],
    ['GET', '/repos/acme/widgets/issues/5', () => json({ number: 5, state: 'open', body: 'It broke', user: { login: 'alice' }, assignees: [{ login: 'me' }] })],
    ['GET', '/repos/acme/widgets/issues/5/comments', () => json([comment('bob', 6, 'same here')])],
    // Forgejo: filter by run_number, index_in_repo; jobs as an array with task_id.
    ['GET', '/repos/acme/widgets/actions/runs', (u) => {
      if (over.flavour === 'forgejo') return json({ workflow_runs: u.searchParams.get('run_number') === '4' ? [{ id: 77, index_in_repo: 4, status: 'failure' }] : [], total_count: 1 })
      return json({ workflow_runs: [{ id: 76, run_number: 3 }, { id: 77, run_number: 4, run_attempt: 1, status: 'completed', conclusion: 'failure' }], total_count: 2 })
    }],
    ['GET', '/repos/acme/widgets/actions/runs/77/jobs', () => (over.flavour === 'forgejo'
      ? json(over.jobs || [{ id: 31, name: 'test', status: 'failure', task_id: 901 }, { id: 32, name: 'lint', status: 'success', task_id: 902 }])
      : json({ jobs: over.jobs || [{ id: 31, name: 'test', status: 'completed', conclusion: 'failure' }, { id: 32, name: 'lint', status: 'completed', conclusion: 'success' }], total_count: 2 }))],
    ['GET', '/repos/acme/widgets/actions/jobs/31/logs', () => text('##[group]Run npm test\nFAIL a.test.js\n##[error]exit 1')],
  ]
  const srv = fakeServer({ routes })
  const client = createClient({ fetch: srv.fetch, server: parseServer(BASE).server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), log: quiet })
  const logs = []
  const env = (info) => ({ renderer: d.createRenderer({ log: quiet }), info, log: { info() {}, warn: (m) => logs.push(m), error() {} } })
  return { srv, client, renders, env, logs }
}
const paths = (srv) => srv.calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)

test('PR on Forgejo: rendered bodies with absolute links, timeline, checks with the job log tail by task_id', async () => {
  const w = world({ flavour: 'forgejo' })
  const v = await d.detailsOf(w.client, prItem, w.env(FORGEJO))
  assert.equal(v.kind, 'pr')
  assert.equal(v.host, 'Forgejo')
  assert.equal(v.url, `${BASE}/acme/widgets/pulls/1`)
  assert.match(v.body, /^<p>Fixes \*\*login\*\*<\/p><a href="https:\/\/git\.example\.com\/acme\/widgets\/issues\/2">#2<\/a><img src="https:\/\/git\.example\.com\/attachments\/x\.png">$/)
  assert.deepEqual(w.renders[0], { Text: 'Fixes **login**', Mode: 'gfm', Context: '/acme/widgets' })
  assert.deepEqual(v.timeline.map((e) => [e.kind, e.who, e.state]), [['comment', 'alice', undefined], ['review', 'bob', 'CHANGES_REQUESTED']])
  assert.equal(v.header.state, 'open')
  const [failing, passing] = v.checks
  assert.equal(failing.name, 'ci / test (pull_request)')
  assert.equal(failing.url, `${BASE}/acme/widgets/actions/runs/4/jobs/1`)
  assert.equal(failing.tail, '##[group]Run npm test\nFAIL a.test.js\n##[error]exit 1')
  assert.equal(passing.conclusion, 'success')
  const runQ = paths(w.srv).find((p) => p.startsWith('/api/v1/repos/acme/widgets/actions/runs?'))
  assert.equal(new URL(runQ, BASE).searchParams.get('run_number'), '4')
  assert.ok(paths(w.srv).includes('/api/v1/repos/acme/widgets/actions/jobs/31/logs'), 'the job id from runs/77/jobs')
  assert.ok(!paths(w.srv).some((p) => /\/jobs\/90\d/.test(p)), 'a task id is never used as a job id')
  assert.equal(v.checks.find((c) => c.task), undefined)
})

test('PR on current Gitea: run by head_sha matched by run_number, job by name', async () => {
  const w = world()
  const v = await d.detailsOf(w.client, prItem, w.env(GITEA))
  assert.match(v.checks[0].tail, /##\[error\]exit 1$/)
  assert.ok(paths(w.srv).some((p) => p.includes('/actions/runs?') && p.includes('head_sha=abc1234')))
  assert.ok(paths(w.srv).includes('/api/v1/repos/acme/widgets/actions/runs/77/jobs?limit=100'))
})

test('PR on Gitea 1.23: no runs API, no tails, the failed status links to its job page', async () => {
  const w = world()
  const v = await d.detailsOf(w.client, prItem, w.env(OLD))
  assert.equal(v.checks[0].failed, true)
  assert.equal(v.checks[0].tail, undefined)
  assert.equal(v.checks[0].url, `${BASE}/acme/widgets/actions/runs/4/jobs/1`)
  assert.ok(!paths(w.srv).some((p) => p.includes('/actions/')))
})

test('a failed job with no matching status gets a row of its own; two same-name jobs without task ids give no tail', async () => {
  const w = world({ tasks: [task(905, 'build')], jobs: [{ id: 33, name: 'build', status: 'completed', conclusion: 'failure' }, { id: 34, name: 'build', status: 'completed', conclusion: 'failure' }] })
  const v = await d.detailsOf(w.client, prItem, w.env(GITEA))
  const row = v.checks.find((c) => c.name === 'build')
  assert.ok(row && row.failed)
  assert.equal(row.tail, undefined)
  assert.match(row.tailError, /not found/)
  assert.ok(!paths(w.srv).some((p) => p.includes('/actions/jobs/')))
})

test('a log that cannot be fetched says so; the view still opens', async () => {
  const w = world({ flavour: 'forgejo', routes: [['GET', '/repos/acme/widgets/actions/jobs/31/logs', () => json({ message: 'gone' }, 404)]] })
  const v = await d.detailsOf(w.client, prItem, w.env(FORGEJO))
  assert.equal(v.checks[0].tail, '')
  assert.match(v.checks[0].tailError, /404/)
  assert.ok(w.logs.some((m) => /log of acme\/widgets run #4 test/.test(m)))
})

test('files: patches from the .diff split per file; a binary file has none; a cut diff marks its last file too big', async () => {
  const w = world()
  const v = await d.detailsOf(w.client, prItem, w.env(OLD))
  assert.deepEqual(v.files.map((f) => [f.name, f.patch !== undefined, !!f.noPatch]), [['src/a.js', true, false], ['src/b.js', true, false], ['img.png', false, true]])
  assert.equal(v.files[0].patch, '@@ -1 +1 @@\n-old\n+new')
  const big = 'x'.repeat(d.DIFF_CAP)
  const cut = world({ diff: () => text(`${DIFF}diff --git a/img.png b/img.png\n@@ -0,0 +1 @@\n+${big}`) })
  const v2 = await d.detailsOf(cut.client, prItem, cut.env(OLD))
  assert.ok(v2.files.find((f) => f.name === 'img.png').tooBig)
  assert.equal(v2.filesCut, 1)
  const failing = world({ diff: () => json({ message: 'no' }, 500) })
  const v3 = await d.detailsOf(failing.client, prItem, failing.env(OLD))
  assert.ok(v3.files.every((f) => f.noPatch))
})

test('render budget: at most 20 renders a view, the rest as escaped text; cached by text across views', async () => {
  const comments = Array.from({ length: 25 }, (_, i) => comment('alice', 1, `c${i} <b>x</b>`))
  const w = world({ comments, reviews: [] })
  const env = w.env(OLD)
  const v = await d.detailsOf(w.client, prItem, env)
  assert.equal(w.renders.length, d.MAX_RENDERS)
  const escaped = v.timeline.filter((e) => e.html.startsWith('<p>c') && e.html.includes('&lt;b&gt;'))
  assert.equal(escaped.length, 26 - d.MAX_RENDERS)
  await d.detailsOf(w.client, prItem, env)
  assert.equal(w.renders.length, 26, 'the 20 rendered texts are cached; the other 6 are rendered now')
})

test('a render the server refuses falls back to escaped text', async () => {
  const w = world({ routes: [['POST', '/markdown', () => json({ message: 'no' }, 500)]] })
  const v = await d.detailsOf(w.client, issueItem, w.env(OLD))
  assert.equal(v.body, '<p>It broke</p>')
})

test('issue: body, assignees and comments', async () => {
  const w = world()
  const v = await d.detailsOf(w.client, issueItem, w.env(OLD))
  assert.deepEqual([v.kind, v.header.author, v.header.assignees], ['issue', 'alice', ['me']])
  assert.deepEqual(v.timeline.map((e) => e.who), ['bob'])
})

test('run: jobs from the tasks of that run number (latest attempt per job); tails only with the runs API', async () => {
  const tasks = [task(901, 'test'), task(903, 'test', 'failure'), task(902, 'lint', 'success'), task(800, 'other', 'success', 3)]
  const old = world({ tasks })
  const v = await d.detailsOf(old.client, runIt, old.env(OLD))
  assert.deepEqual(v.jobs.map((j) => [j.name, j.failed, j.conclusion]), [['test', true, 'failure'], ['lint', false, 'success']])
  assert.equal(v.header.attempt, 2)
  assert.equal(v.header.status, 'completed')
  assert.equal(v.jobs[0].tail, undefined)
  const fj = world({ flavour: 'forgejo', tasks, jobs: [{ id: 31, name: 'test', status: 'failure', task_id: 903 }] })
  const v2 = await d.detailsOf(fj.client, runIt, fj.env(FORGEJO))
  assert.match(v2.jobs[0].tail, /exit 1/)
})

test('discussText: names the host and quotes its content', async () => {
  const w = world({ flavour: 'forgejo' })
  const v = await d.detailsOf(w.client, prItem, w.env(FORGEJO))
  const t = d.discussText(v)
  assert.ok(t.startsWith(`acme/widgets#1 Fix login\nURL: ${BASE}/acme/widgets/pulls/1\nPull request on Forgejo in acme/widgets`))
  assert.match(t, /content from Forgejo, quoted/)
  assert.match(t, /Review by bob \(changes requested\):\nAdd a test/)
  assert.match(t, /End of the log of ci \/ test \(pull_request\):/)
})

test('helpers: absolutize keeps absolute and protocol-relative links; under a prefix', () => {
  const s = parseServer(`${BASE}/git`).server
  assert.equal(d.absolutize('<a href="/acme/x">a</a><a href="/git/acme/y">b</a><a href="//evil.example/z">c</a><a href="https://o.example/">d</a>', s), `<a href="${BASE}/git/acme/x">a</a><a href="${BASE}/git/acme/y">b</a><a href="//evil.example/z">c</a><a href="https://o.example/">d</a>`)
  assert.equal(d.absoluteUrl('javascript:alert(1)', s), '')
  assert.equal(d.statusOfJob('ci / test (push)', 'test'), true)
  assert.equal(d.statusOfJob('ci / testing (push)', 'test'), false)
  assert.equal(d.jobFor({ id: 1, name: 'a' }, [{ id: 5, name: 'a', failed: false }]).id, 5)
})
