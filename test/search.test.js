'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { queries, searchAll, createEnricher, keyOf, MAX_ENRICH } = require('../dist/lib/search')
const { createClient, createBinding } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, fakeClock, memStore, json, BASE, TOKEN } = require('./fakes')
const { T, issue, pull, review, comment, worldRoutes } = require('./builders')

const quiet = { info() {}, warn() {}, error() {} }
const ALL = { reviewRequested: true, myPrs: true, issues: true, failedRuns: true }

function setup(world, extra = []) {
  const logs = []
  const log = { info() {}, warn: (m) => logs.push(m), error() {} }
  const srv = fakeServer({ routes: [...extra, ...worldRoutes(world)] })
  const clock = fakeClock()
  const client = createClient({ fetch: srv.fetch, server: parseServer(BASE).server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), now: clock.now, log })
  return { srv, clock, client, enricher: createEnricher({ now: clock.now, log }), logs }
}
const count = (srv, re) => srv.calls.filter((c) => re.test(new URL(c.url).pathname)).length

test('queries: one per enabled lane, issues as assigned + mentioned, open only', () => {
  const q = queries(ALL)
  assert.deepEqual(Object.keys(q), ['reviewRequested', 'myPrs', 'assigned', 'mentioned'])
  assert.deepEqual(q.reviewRequested, { state: 'open', type: 'pulls', review_requested: true })
  assert.deepEqual(q.myPrs, { state: 'open', type: 'pulls', created: true })
  assert.deepEqual(q.mentioned, { state: 'open', type: 'issues', mentioned: true })
  assert.deepEqual(Object.keys(queries({ ...ALL, issues: false, reviewRequested: false })), ['myPrs'])
  // Issues I opened: a third issues search, only with the setting and only with the Issues lane on.
  assert.deepEqual(queries(ALL, { myIssues: true }).created, { state: 'open', type: 'issues', created: true })
  assert.equal(queries(ALL).created, undefined)
  assert.equal(queries({ ...ALL, issues: false }, { myIssues: true }).created, undefined)
})

test('searchAll: with myIssues, the issues the person opened come back under created', async () => {
  const { srv, client } = setup({ search: { created: [issue(7, { pr: false })] } })
  const { results } = await searchAll(client, ALL, { myIssues: true })
  assert.deepEqual(results.created.map((i) => i.number), [7])
  const searches = srv.calls.filter((c) => c.url.includes('/repos/issues/search')).map((c) => new URL(c.url).searchParams)
  assert.ok(searches.some((s) => s.get('created') === 'true' && s.get('type') === 'issues'))
})

test('searchAll: each lane searched with its flags, 2 pages of 50 at most', async () => {
  const { srv, client } = setup({ search: { myPrs: [issue(1)], assigned: [issue(5, { pr: false })] } })
  const { results } = await searchAll(client, ALL)
  assert.deepEqual(results.myPrs.map((i) => i.number), [1])
  assert.deepEqual(results.assigned.map((i) => i.number), [5])
  const searches = srv.calls.filter((c) => c.url.includes('/repos/issues/search')).map((c) => new URL(c.url).searchParams)
  assert.ok(searches.every((s) => s.get('limit') === '50' && s.get('state') === 'open'))
  assert.ok(searches.some((s) => s.get('review_requested') === 'true' && s.get('type') === 'pulls'))
})

test('keyOf: owner/repo#n, or null for a result we cannot address', () => {
  assert.equal(keyOf(issue(3)), 'acme/widgets#3')
  assert.equal(keyOf({ number: 3, repository: { full_name: 'a/b/c' } }), null)
  assert.equal(keyOf({ number: 'x', repository: { full_name: 'a/b' } }), null)
  assert.equal(keyOf(null), null)
})

test('enrich: PR state, reviews (no pending), newest comments, head status; an issue gets its comments only', async () => {
  const world = {
    pulls: {
      'acme/widgets#1': {
        pull: pull(1, { draft: true, mergeable: false, reviewers: ['me'], teams: [7], sha: 'abc' }),
        reviews: [review('alice', 'APPROVED', 3), review('bob', 'PENDING', 4)],
        comments: Array.from({ length: 8 }, (_, i) => comment('bob', i + 1, `c${i}`)),
      },
    },
    status: { abc: 'failure' },
    issues: { 'acme/widgets#9': { comments: [comment('alice', 5, 'ping')] } },
  }
  const { srv, client, enricher } = setup(world)
  const out = await enricher.enrich(client, { myPrs: [issue(1)], assigned: [issue(9, { pr: false })] })
  assert.deepEqual([...out.keys()].sort(), ['acme/widgets#1', 'acme/widgets#9'])
  assert.deepEqual(out.get('acme/widgets#9'), { pr: null, reviews: [], comments: [{ user: 'alice', at: Date.parse(T(5)), body: 'ping' }], status: '' })
  assert.equal(count(srv, /\/pulls\/9$|\/commits\//), 1, 'only the PR head status, nothing PR-like for the issue')
  const e = out.get('acme/widgets#1')
  assert.deepEqual(e.pr, { draft: true, mergeable: false, headSha: 'abc', headRef: 'b1', baseRef: 'main', requestedUsers: ['me'], requestedTeamIds: [7] })
  assert.deepEqual(e.reviews.map((r) => [r.user, r.state]), [['alice', 'APPROVED']])
  assert.deepEqual(e.comments.map((c) => c.body), ['c3', 'c4', 'c5', 'c6', 'c7'])
  assert.equal(e.status, 'failure')
})

test('enrich: details again only when updated_at moved; the status on every poll', async () => {
  const world = { pulls: { 'acme/widgets#1': {} }, status: { sha1: 'pending' } }
  const { srv, client, enricher } = setup(world)
  await enricher.enrich(client, { myPrs: [issue(1)] })
  assert.equal(count(srv, /\/pulls\/1$/), 1)
  world.status.sha1 = 'success'
  const second = await enricher.enrich(client, { myPrs: [issue(1)] })
  assert.equal(count(srv, /\/pulls\/1$/), 1, 'cached')
  assert.equal(count(srv, /\/commits\/sha1\/status$/), 2)
  assert.equal(second.get('acme/widgets#1').status, 'success')
  await enricher.enrich(client, { myPrs: [issue(1, { updated: T(5) })] })
  assert.equal(count(srv, /\/pulls\/1$/), 2, 'updated_at moved')
})

test('enrich: no statuses at all is no CI, not pending', async () => {
  const { client, enricher } = setup({ pulls: { 'acme/widgets#1': {} } })
  assert.equal((await enricher.enrich(client, { myPrs: [issue(1)] })).get('acme/widgets#1').status, '')
})

test('enrich: at most 30 PRs a poll, newest first; the cache keeps only open PRs', async () => {
  const many = Array.from({ length: 40 }, (_, i) => issue(i + 1, { updated: new Date(Date.parse(T(1)) + i * 60_000).toISOString() }))
  const pulls = Object.fromEntries(many.map((i) => [`acme/widgets#${i.number}`, {}]))
  const { srv, client, enricher } = setup({ pulls })
  const out = await enricher.enrich(client, { myPrs: many })
  assert.equal(out.size, MAX_ENRICH)
  assert.ok(out.has('acme/widgets#40') && !out.has('acme/widgets#1'))
  assert.equal(count(srv, /\/pulls\/\d+$/), MAX_ENRICH)
  await enricher.enrich(client, { myPrs: [many[39]] })
  assert.deepEqual([...enricher.cache.keys()], ['acme/widgets#40'])
})

test('enrich: one broken PR is logged and skipped; a sign-out stops the poll', async () => {
  const { client, enricher, logs } = setup({ pulls: { 'acme/widgets#2': {} } })
  const out = await enricher.enrich(client, { myPrs: [issue(1), issue(2)] })
  assert.deepEqual([...out.keys()], ['acme/widgets#2'])
  assert.match(logs.join('\n'), /could not read acme\/widgets#1/)
  const s = setup({}, [['GET', '/repos/acme/widgets/pulls/1', () => json({ message: 'no' }, 401)]])
  await assert.rejects(s.enricher.enrich(s.client, { myPrs: [issue(1)] }), (e) => e.signedOut)
})

test('teams: read once an hour; a failure is logged and means no teams', async () => {
  const { srv, clock, client, enricher } = setup({ teams: [7, 8] })
  assert.deepEqual([...(await enricher.teams(client))], [7, 8])
  await enricher.teams(client)
  assert.equal(count(srv, /\/user\/teams$/), 1)
  clock.advance(3600_000)
  await enricher.teams(client)
  assert.equal(count(srv, /\/user\/teams$/), 2)
  const bad = setup({}, [['GET', '/user/teams', () => json({ message: 'scope' }, 403)]])
  assert.equal((await bad.enricher.teams(bad.client)).size, 0)
  assert.match(bad.logs.join('\n'), /could not read your teams/)
})
