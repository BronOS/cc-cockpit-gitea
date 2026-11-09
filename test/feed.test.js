'use strict'
// Copied from cc-cockpit-github test/feed.test.js; keep in step (host name, run number, re-run feature).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createFeed, toFeed, actionsOf, scopeLine, MAX_GONE } = require('../dist/lib/feed')
const { infoOf } = require('../dist/lib/probe')
const { normalize } = require('../dist/lib/settings')
const { fakeCtx, NOW } = require('./fakes')

// A Gitea with the re-run API, a 1.23 without it, a Forgejo with it.
const GITEA = infoOf('gitea', '1.26.0', true)
const OLD = infoOf('gitea', '1.23.1', false)
const FORGEJO = infoOf('forgejo', '17.0.0', true)

function item(id, over = {}) {
  return {
    id,
    rev: 'r1',
    title: `acme/widgets#${id} Title`,
    time: NOW - Number(String(id).replace(/\D/g, '') || 0),
    read: false,
    place: { kind: 'project', name: 'acme/widgets', status: 'open' },
    labels: ['pr'],
    actions: [],
    _: { kind: 'pr', url: 'https://git.example.com/acme/widgets/pulls/1', repo: 'acme/widgets', number: 1 },
    ...over,
  }
}

function setup(settings = normalize({}), host = GITEA) {
  const ctx = fakeCtx()
  const calls = []
  const handlers = {
    mark: async (it, a) => (calls.push(['mark', it.id, a]), undefined),
    open: async (it) => (calls.push(['open', it.id]), undefined),
    rerun: async (it) => (calls.push(['rerun', it.id]), { ok: false, message: 'The run is still going.' }),
    openWeb: async (it) => (calls.push(['openWeb', it.id]), undefined),
  }
  const events = []
  const feed = createFeed({ emit: (e, d) => events.push([e, structuredClone(d)]), getSettings: () => settings, getHost: () => host, handlers, now: () => NOW, log: ctx.log })
  return { feed, events, calls, ctx }
}

test('describe and scope', () => {
  const { feed } = setup()
  assert.deepEqual(feed.provider.describe(), {
    label: 'Gitea',
    badge: 'GT',
    color: 'green',
    kind: 'issues',
    scope: 'Review requests, your pull requests, your issues and your failed runs',
  })
  assert.equal(scopeLine(normalize({ lanes: { reviewRequested: false, issues: false, failedRuns: false }, exclude: ['acme'] })), 'Your pull requests; leaves out 1 owner or repo')
  assert.match(scopeLine(normalize({ lanes: { reviewRequested: false, myPrs: false, issues: false, failedRuns: false } })), /^Nothing/)
  assert.deepEqual(feed.provider.features(), [])
  const fj = setup(normalize({}), FORGEJO).feed.provider.describe()
  assert.deepEqual([fj.label, fj.badge, fj.color], ['Forgejo', 'FJ', 'amber'])
  const none = setup(normalize({}), null).feed.provider.describe()
  assert.deepEqual([none.label, none.badge], ['Gitea / Forgejo', 'GT'])
})

test('before the first poll: snapshot is stale, never an empty ok', () => {
  const { feed } = setup()
  const s = feed.provider.snapshot()
  assert.equal(s.state, 'error')
  assert.equal(s.message, 'Not refreshed yet')
  assert.deepEqual(s.items, [])
})

test('a restart restores the stored list as stale; the first poll sends a whole ok sync', () => {
  const { feed, events } = setup()
  feed.restore({ items: [item('a1'), { junk: true }, null], asOf: NOW - 5000 })
  const s = feed.provider.snapshot()
  assert.equal(s.state, 'error')
  assert.deepEqual(s.items.map((i) => i.id), ['a1'])
  assert.equal(s.asOf, NOW - 5000)
  assert.equal(s.items[0]._, undefined)
  feed.setItems([item('a1'), item('a2')])
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'sync')
  assert.equal(events[0][1].state, 'ok')
  assert.equal(events[0][1].message, undefined)
})

test('after ok: item for new or changed, gone for missing, nothing for unchanged', () => {
  const { feed, events } = setup()
  feed.setItems([item('a1'), item('a2'), item('a3')])
  events.length = 0
  feed.setItems([item('a1'), item('a2', { rev: 'r2', preview: 'new' }), item('a4')])
  assert.deepEqual(
    events.map(([e, d]) => [e, d.id || d.ids]),
    [
      ['item', 'a2'],
      ['item', 'a4'],
      ['gone', ['a3']],
    ]
  )
  assert.equal(events[0][1]._, undefined)
})

test('gone is sent in chunks of 500', () => {
  const { feed, events } = setup()
  feed.setItems(Array.from({ length: 1200 }, (_, i) => item(`i${i}`)))
  events.length = 0
  feed.setItems([])
  const gone = events.filter(([e]) => e === 'gone')
  // 1200 polled, 1000 kept (the feed's cap), so 1000 gone: two events of 500.
  assert.deepEqual(gone.map(([, d]) => d.ids.length), [MAX_GONE, MAX_GONE])
})

test('actions follow the item: read flips the mark, rerun only for a completed linked run on a server that can', () => {
  assert.deepEqual(actionsOf(item('a1'), GITEA).map((a) => a.id), ['open', 'markRead', 'done', 'openWeb'])
  assert.deepEqual(actionsOf(item('a1', { read: true }), GITEA).map((a) => a.id), ['open', 'markUnread', 'done', 'openWeb'])
  const run = item('r1', { _: { kind: 'run', runNumber: 9, status: 'completed' } })
  assert.ok(actionsOf(run, GITEA).some((a) => a.id === 'rerun'))
  assert.ok(actionsOf(run, FORGEJO).some((a) => a.id === 'rerun'))
  assert.ok(!actionsOf(run, OLD).some((a) => a.id === 'rerun'), 'no re-run API on 1.23')
  assert.ok(!actionsOf(run, null).some((a) => a.id === 'rerun'), 'not before the probe')
  assert.ok(!actionsOf(item('r2', { _: { kind: 'run', runNumber: 9, status: 'in_progress' } }), GITEA).some((a) => a.id === 'rerun'))
  assert.ok(actionsOf(item('p1', { _: { kind: 'pr', runNumber: 9, runStatus: 'completed' } }), GITEA).some((a) => a.id === 'rerun'))
  const label = (h, id) => actionsOf(item('a1'), h).find((a) => a.id === id).label
  assert.equal(label(GITEA, 'done'), 'Done on Gitea')
  assert.equal(label(FORGEJO, 'openWeb'), 'Open on Forgejo')
  assert.equal(label(null, 'openWeb'), 'Open on the server')
  assert.deepEqual(Object.keys(toFeed(item('a1'), GITEA)).includes('_'), false)
})

test('act: checks the id and the action, calls the handler, passes its refusal on', async () => {
  const { feed, calls } = setup()
  feed.setItems([item('a1'), item('r1', { _: { kind: 'run', runNumber: 9, status: 'completed' } })])
  assert.deepEqual(await feed.provider.act('nope', 'open'), { ok: false, message: 'That item is no longer in the list.' })
  assert.equal((await feed.provider.act('a1', 'rerun')).ok, false)
  assert.equal((await feed.provider.act('a1', 'markUnread')).ok, false, 'unread item cannot be marked unread')
  assert.deepEqual(await feed.provider.act('a1', 'markRead'), { ok: true })
  assert.deepEqual(await feed.provider.act('a1', 'open'), { ok: true })
  assert.deepEqual(await feed.provider.act('a1', 'openWeb'), { ok: true })
  assert.deepEqual(await feed.provider.act('a1', 'done'), { ok: true })
  assert.deepEqual(await feed.provider.act('r1', 'rerun'), { ok: false, message: 'The run is still going.' })
  assert.deepEqual(calls, [
    ['mark', 'a1', 'markRead'],
    ['open', 'a1'],
    ['openWeb', 'a1'],
    ['mark', 'a1', 'done'],
    ['rerun', 'r1'],
  ])
})

test('act: a handler that throws is a refusal with its message', async () => {
  const ctx = fakeCtx()
  const feed = createFeed({ emit() {}, getSettings: () => normalize({}), handlers: { open: async () => Promise.reject(new Error('Too many overlays open')) }, now: () => NOW, log: ctx.log })
  feed.setItems([item('a1')])
  assert.deepEqual(await feed.provider.act('a1', 'open'), { ok: false, message: 'Too many overlays open' })
})

test('setState: signedOut and error as a whole sync with the last list and the message', () => {
  const { feed, events } = setup()
  feed.setItems([item('a1')])
  events.length = 0
  feed.setState('signedOut', 'Set an access token in Settings')
  feed.setState('signedOut', 'Set an access token in Settings')
  assert.equal(events.length, 1)
  const [, s] = events[0]
  assert.equal(s.state, 'signedOut')
  assert.equal(s.message, 'Set an access token in Settings')
  assert.deepEqual(s.items.map((i) => i.id), ['a1'])
  // Back to ok: a whole sync again.
  events.length = 0
  feed.setItems([item('a1')])
  assert.equal(events[0][0], 'sync')
  assert.equal(events[0][1].state, 'ok')
})

test('update and remove tell one item at once', () => {
  const { feed, events } = setup()
  feed.setItems([item('a1'), item('a2')])
  events.length = 0
  feed.update(item('a1', { read: true }))
  feed.update(item('a1', { read: true }))
  feed.remove('a2')
  feed.remove('a2')
  assert.deepEqual(events.map(([e, d]) => [e, d.id || d.ids]), [
    ['item', 'a1'],
    ['gone', ['a2']],
  ])
  assert.equal(events[0][1].actions[1].id, 'markUnread')
})

test('a throwing emit is logged, not thrown', () => {
  const ctx = fakeCtx()
  const feed = createFeed({ emit: () => { throw new Error('host gone') }, getSettings: () => normalize({}), handlers: {}, now: () => NOW, log: ctx.log })
  feed.setItems([item('a1')])
  assert.ok(ctx.logs.some(([, m]) => /inbox-feed sync: host gone/.test(m)))
})
