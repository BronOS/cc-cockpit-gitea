'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRuns, repoSet, runItem, runUrl, linkPrRuns, MAX_REPOS } = require('../dist/lib/runs')
const { createClient, createBinding } = require('../dist/lib/client')
const { parseServer, normalize } = require('../dist/lib/settings')
const { fakeServer, memStore, json, BASE, TOKEN, NOW } = require('./fakes')
const { T, worldRoutes } = require('./builders')

const quiet = { info() {}, warn() {}, error() {} }
const settings = normalize({ serverUrl: BASE })
const now = NOW

function setup(world, extra = []) {
  const logs = []
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {} }
  const srv = fakeServer({ routes: [...extra, ...worldRoutes(world)] })
  const client = createClient({ fetch: srv.fetch, server: parseServer(BASE).server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), now: () => now, log })
  return { srv, client, runs: createRuns({ log }), logs }
}

let nextId = 100
const task = (o = {}) => ({
  id: o.id || nextId++,
  run_number: o.run || 1,
  name: o.name || 'test',
  workflow_id: o.wf || 'ci.yml',
  status: o.status || 'failure',
  head_sha: o.sha === undefined ? 'sha1' : o.sha,
  head_branch: o.branch || 'feature',
  event: 'pull_request',
  display_title: 'Fix login',
  created_at: o.at || T(8),
  updated_at: o.at || T(8),
  url: o.url || `https://gitea.internal/acme/widgets/actions/runs/${o.run || 1}`,
})
const pr = (repo = 'acme/widgets', sha = 'sha1', head = 'feature') => ({ labels: ['pr', 'my-pr', 'ci:failed'], _: { kind: 'pr', repo, sha, head, number: 1 } })
const call = (s, prs) => s.runs.failedRuns(s.client, prs, now, settings)

test('a failure on an open PR head is a run item; another sha is not', async () => {
  const s = setup({ tasks: { 'acme/widgets': [task({ run: 4 }), task({ run: 5, sha: 'other' })] } })
  const { runs, answered } = await call(s, [pr()])
  assert.deepEqual(runs.map((r) => r.runNumber), [4])
  assert.deepEqual(answered, ['acme/widgets'])
  const it = runItem(runs[0], BASE)
  assert.equal(it.id, 'run:acme/widgets/4')
  assert.equal(it.title, 'acme/widgets CI failed: ci on feature')
  assert.deepEqual(it.labels, ['run', 'ci:failed', 'repo:acme/widgets', 'owner:acme'])
  assert.equal(it._.url, `${BASE}/acme/widgets/actions/runs/4`, 'rebased off the server ROOT_URL')
  assert.equal(it._.status, 'completed')
})

test('branch fallback only for a task with no sha; a fork PR with the same branch name is not matched', async () => {
  const s = setup({ tasks: { 'acme/widgets': [task({ run: 6, sha: '' }), task({ run: 7, sha: 'forksha', branch: 'feature' })] } })
  const { runs } = await call(s, [pr()])
  assert.deepEqual(runs.map((r) => r.runNumber), [6])
})

test('superseded only by a later success of the same job; another job passing keeps the failure', async () => {
  const tasks = [
    task({ run: 1, name: 'lint', at: T(2) }),
    task({ run: 2, name: 'lint', status: 'success', at: T(3) }),
    task({ run: 1, name: 'test', at: T(2) }),
    task({ run: 2, name: 'build', status: 'success', at: T(3) }),
  ]
  const s = setup({ tasks: { 'acme/widgets': tasks } })
  const { runs, failures } = await call(s, [pr()])
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].failed.map((t) => t.name), ['test'])
  assert.equal(failures.length, 2, 'every failed task is kept for linking')
})

test('older than 7 days is left out', async () => {
  const old = new Date(now - 8 * 864e5).toISOString()
  const s = setup({ tasks: { 'acme/widgets': [task({ at: old })] } })
  assert.deepEqual((await call(s, [pr()])).runs, [])
})

test('a 404 repo is skipped alone and remembered until forget; a sign-out stops', async () => {
  const s = setup({ tasks: { 'acme/off': 404, 'acme/widgets': [task({ run: 3 })] } })
  const prs = [pr('acme/off'), pr()]
  const first = await call(s, prs)
  assert.deepEqual(first.runs.map((r) => r.repo), ['acme/widgets'])
  assert.deepEqual(s.runs.skipped, ['acme/off'])
  await call(s, prs)
  const asked = () => s.srv.calls.filter((c) => c.url.includes('/acme/off/actions/tasks')).length
  assert.equal(asked(), 1, 'not asked again')
  s.runs.forget()
  await call(s, prs)
  assert.equal(asked(), 2)
  const out = setup({}, [['GET', '/repos/acme/widgets/actions/tasks', () => json({ message: 'no' }, 401)]])
  await assert.rejects(call(out, [pr()]), (e) => e.signedOut)
})

test('a re-run keeps the id; the rev moves with the newest failed task; in progress while a task runs', async () => {
  const a = setup({ tasks: { 'acme/widgets': [task({ id: 10, run: 9, at: T(2) })] } })
  const first = runItem((await call(a, [pr()])).runs[0], BASE)
  const b = setup({ tasks: { 'acme/widgets': [task({ id: 10, run: 9, at: T(2), status: 'failure' }), task({ id: 11, run: 9, at: T(3) }), task({ id: 12, run: 9, name: 'other', status: 'running', at: T(3) })] } })
  const { runs } = await call(b, [pr()])
  const second = runItem(runs[0], BASE)
  assert.equal(second.id, first.id)
  assert.notEqual(second.rev, first.rev)
  assert.equal(second._.status, 'in_progress')
})

test('repoSet: excluded out, no duplicates, at most 10', () => {
  const s = normalize({ serverUrl: BASE, exclude: ['acme/secret'] })
  assert.deepEqual(repoSet(['acme/a', 'ACME/a', 'acme/secret', 'bad'], s), ['acme/a'])
  assert.equal(repoSet(Array.from({ length: 15 }, (_, i) => `o/r${i}`), settings).length, MAX_REPOS)
})

test('runUrl: a task url of another repo is not trusted', () => {
  const run = { repo: 'acme/widgets', runNumber: 3, failed: [task({ run: 3, url: 'https://evil.example/other/repo/actions/runs/3' })] }
  assert.equal(runUrl(BASE, run), `${BASE}/acme/widgets/actions/runs/3`)
  run.failed[0].url = 'not a url'
  assert.equal(runUrl(BASE, run), `${BASE}/acme/widgets/actions/runs/3`)
})

test('linkPrRuns: a failing own PR gets its newest failed run', () => {
  const p = pr()
  const other = { labels: ['pr', 'review-requested', 'ci:failed'], _: { kind: 'pr', repo: 'acme/widgets', sha: 'sha1' } }
  const failures = [{ ...task({ id: 1, run: 2 }), _repo: 'acme/widgets' }, { ...task({ id: 5, run: 3 }), _repo: 'acme/widgets' }]
  linkPrRuns([p, other], failures, [{ repo: 'acme/widgets', runNumber: 3, active: true }])
  assert.equal(p._.runNumber, 3)
  assert.equal(p._.runStatus, 'in_progress')
  assert.equal(other._.runNumber, undefined)
})
