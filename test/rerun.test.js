'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { rerun } = require('../dist/lib/details')
const { infoOf } = require('../dist/lib/probe')
const { createClient, createBinding } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, memStore, json, BASE, TOKEN } = require('./fakes')

const quiet = { info() {}, warn() {}, error() {} }
const OLD = infoOf('gitea', '1.23.1', false)
const NO_RERUN = infoOf('gitea', '1.25.0', true) // runs API, but before rerun-failed-jobs
const GITEA = infoOf('gitea', '1.26.0', true)
const FORGEJO = infoOf('forgejo', '17.0.0', true)

const runItem = { id: 'run:acme/widgets/4', _: { kind: 'run', repo: 'acme/widgets', runNumber: 4, sha: 'abc' } }
const prItem = { id: 'pr:acme/widgets#1', _: { kind: 'pr', repo: 'acme/widgets', number: 1, sha: 'abc', runNumber: 4 } }

function setup({ run = { status: 'completed', conclusion: 'failure', run_attempt: 1 }, fjRun = { status: 'failure' }, jobs, postStatus = 201 } = {}) {
  const routes = [
    ['GET', '/repos/acme/widgets/actions/runs', (u) => {
      if (u.searchParams.has('run_number')) return json({ workflow_runs: [{ id: 77, index_in_repo: 4, ...fjRun }] })
      return json({ workflow_runs: [{ id: 77, run_number: 4, ...run }] })
    }],
    ['GET', '/repos/acme/widgets/actions/runs/77/jobs', () => json(jobs || [{ id: 31, name: 'test', status: 'failure', task_id: 901 }, { id: 32, name: 'e2e', status: 'failure', task_id: 902 }, { id: 33, name: 'lint', status: 'success', task_id: 903 }])],
    ['POST', '/repos/acme/widgets/actions/runs/77/rerun-failed-jobs', () => json({ id: 77 }, postStatus)],
    ['POST', /^\/repos\/acme\/widgets\/actions\/jobs\/(\d+)\/rerun$/, () => (postStatus === 201 ? new Response(null, { status: 204 }) : json({ message: 'no' }, postStatus))],
  ]
  const srv = fakeServer({ routes })
  const client = createClient({ fetch: srv.fetch, server: parseServer(BASE).server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), log: quiet })
  return { srv, client, posts: () => srv.calls.filter((c) => c.method === 'POST').map((c) => new URL(c.url).pathname) }
}

test('Gitea: rerun-failed-jobs once per attempt, from the run or the linked PR', async () => {
  const s = setup()
  const attempts = new Set()
  assert.deepEqual(await rerun(s.client, runItem, attempts, GITEA), { ok: true })
  assert.deepEqual(s.posts(), ['/api/v1/repos/acme/widgets/actions/runs/77/rerun-failed-jobs'])
  assert.deepEqual(await rerun(s.client, prItem, attempts, GITEA), { ok: false, message: 'This run attempt was already re-run.' })
  assert.equal(s.posts().length, 1)
  const run = s.srv.calls.find((c) => c.url.includes('/actions/runs?'))
  assert.equal(new URL(run.url).searchParams.get('head_sha'), 'abc')
})

test('Gitea: a new attempt can be re-run again', async () => {
  const attempts = new Set()
  await rerun(setup().client, runItem, attempts, GITEA)
  const second = setup({ run: { status: 'completed', conclusion: 'failure', run_attempt: 2 } })
  assert.deepEqual(await rerun(second.client, runItem, attempts, GITEA), { ok: true })
})

test('Forgejo: each failed job re-run, not the whole run; once per attempt', async () => {
  const s = setup()
  const attempts = new Set()
  assert.deepEqual(await rerun(s.client, runItem, attempts, FORGEJO), { ok: true })
  assert.deepEqual(s.posts(), ['/api/v1/repos/acme/widgets/actions/jobs/31/rerun', '/api/v1/repos/acme/widgets/actions/jobs/32/rerun'])
  assert.equal((await rerun(s.client, runItem, attempts, FORGEJO)).message, 'This run attempt was already re-run.')
  const next = setup({ jobs: [{ id: 31, name: 'test', status: 'failure', task_id: 911 }] })
  assert.deepEqual(await rerun(next.client, runItem, attempts, FORGEJO), { ok: true }, 'new tasks: a new attempt')
})

test('refused: no re-run API, no run, still going, passed since, nothing failed', async () => {
  const msg = async (s, item, info) => (await rerun(s.client, item, new Set(), info)).message
  assert.match(await msg(setup(), runItem, OLD), /not available on this Gitea/)
  assert.match(await msg(setup(), runItem, NO_RERUN), /not available/)
  assert.match(await msg(setup(), runItem, null), /not available on this server/)
  assert.equal(await msg(setup(), { id: 'x', _: { kind: 'pr', repo: 'acme/widgets' } }, GITEA), 'That item has no run to re-run.')
  assert.equal(await msg(setup(), { ...runItem, _: { ...runItem._, runNumber: 9 } }, GITEA), 'The run was not found on the server.')
  assert.equal(await msg(setup({ run: { status: 'in_progress', conclusion: '' } }), runItem, GITEA), 'The run is still going.')
  assert.equal(await msg(setup({ fjRun: { status: 'running' } }), runItem, FORGEJO), 'The run is still going.')
  assert.equal(await msg(setup({ run: { status: 'completed', conclusion: 'success', run_attempt: 2 } }), runItem, GITEA), 'The run passed since.')
  assert.equal(await msg(setup({ fjRun: { status: 'success' } }), runItem, FORGEJO), 'The run passed since.')
  assert.equal(await msg(setup({ jobs: [{ id: 33, name: 'lint', status: 'success', task_id: 903 }] }), runItem, FORGEJO), 'No job of that run failed.')
})

test('a refused POST leaves the attempt open for another try', async () => {
  const attempts = new Set()
  const s = setup({ postStatus: 403 })
  await assert.rejects(rerun(s.client, runItem, attempts, GITEA), (e) => e.status === 403)
  await assert.rejects(rerun(s.client, runItem, attempts, FORGEJO), (e) => e.status === 403)
  assert.equal(attempts.size, 0)
})
