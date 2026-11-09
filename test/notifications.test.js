'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNotifications, subjectMatcher } = require('../dist/lib/notifications')
const { createClient, createBinding } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, fakeCtx, fakeClock, memStore, json, BASE, TOKEN } = require('./fakes')

const pr = { id: 'pr:acme/widgets#12', _: { kind: 'pr', repo: 'acme/widgets', number: 12 } }
const iss = { id: 'issue:acme/widgets#5', _: { kind: 'issue', repo: 'acme/widgets', number: 5 } }
const runIt = { id: 'run:acme/widgets/9', _: { kind: 'run', repo: 'acme/widgets', runNumber: 9 } }

// The server writes subject urls from its own ROOT_URL: another host than the configured base.
const ROOT = 'http://gitea.internal:3000'
const thread = (id, kind, n, over = {}) => ({ id, subject: { type: kind === 'pulls' ? 'Pull' : 'Issue', url: `${ROOT}/api/v1/repos/acme/widgets/${kind}/${n}`, html_url: `${ROOT}/acme/widgets/${kind}/${n}`, ...over } })

function setup(threads, extra = []) {
  const ctx = fakeCtx()
  const clock = fakeClock()
  const srv = fakeServer({
    routes: [
      ...extra,
      ['GET', '/repos/acme/widgets/notifications', (u) => json(u.searchParams.get('page') && u.searchParams.get('page') !== '1' ? [] : threads)],
      ['PATCH', /^\/notifications\/threads\/(\d+)$/, () => new Response(null, { status: 205 })],
    ],
  })
  const client = createClient({ fetch: srv.fetch, server: parseServer(BASE).server, token: TOKEN, binding: createBinding({ store: memStore(), log: ctx.log }), now: clock.now, log: ctx.log })
  let current = client
  const n = createNotifications({ getClient: () => current, now: clock.now, log: ctx.log })
  return { ctx, srv, clock, n, signOut: () => (current = null) }
}
const writes = (srv) => srv.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, new URL(c.url).pathname + new URL(c.url).search])

test('subjectMatcher: by path, any host, pulls and issues alike; nothing for a run', () => {
  const m = subjectMatcher(pr)
  assert.equal(m(`${ROOT}/api/v1/repos/acme/widgets/pulls/12`), true)
  assert.equal(m('https://other.example/ACME/Widgets/issues/12/'), true)
  assert.equal(m(`${ROOT}/acme/widgets/pulls/120`), false)
  assert.equal(m(`${ROOT}/other/acme/widgets-x/pulls/12`), false)
  assert.equal(m('not a url'), false)
  assert.equal(subjectMatcher(runIt), null)
})

test('markRead finds the thread and PATCHes it to read; asks for unread PR and issue threads only', async () => {
  const { srv, n } = setup([thread(1, 'issues', 99), thread(2, 'pulls', 12), thread(3, 'issues', 5, { url: '' })])
  assert.equal(await n.markRead(pr), true)
  assert.equal(await n.markDone(iss), true, 'Done marks read; matched by html_url')
  assert.deepEqual(writes(srv), [
    ['PATCH', '/api/v1/notifications/threads/2?to-status=read'],
    ['PATCH', '/api/v1/notifications/threads/3?to-status=read'],
  ])
  const q = new URL(srv.calls.find((c) => c.method === 'GET' && c.url.includes('/notifications')).url).searchParams
  assert.equal(q.get('status-types'), 'unread')
  assert.deepEqual(q.getAll('subject-type'), ['pull', 'issue'])
})

test('no matching thread, a run, a bad id or no client: nothing is written', async () => {
  const s = setup([thread(1, 'issues', 99), thread('1; drop', 'pulls', 12)])
  assert.equal(await s.n.markRead(pr), false)
  assert.equal(await s.n.markRead(runIt), false)
  s.signOut()
  assert.equal(await s.n.markRead(iss), false)
  assert.equal(writes(s.srv).length, 0)
})

test('the thread list is cached for 60 s per repo', async () => {
  const { srv, clock, n } = setup([thread(1, 'issues', 99)])
  await n.markRead(pr)
  await n.markRead(iss)
  const lists = () => srv.calls.filter((c) => c.method === 'GET' && c.url.includes('/notifications')).length
  assert.equal(lists(), 1)
  clock.advance(61_000)
  await n.markRead(pr)
  assert.equal(lists(), 2)
})

test('failures are logged and resolve false', async () => {
  const s = setup([], [['GET', '/repos/acme/widgets/notifications', () => json({ message: 'boom' }, 500)]])
  assert.equal(await s.n.markRead(pr), false)
  assert.ok(s.ctx.logs.some(([lvl, m]) => lvl === 'warn' && /could not mark the notification of pr:acme\/widgets#12 read/.test(m)))
})
