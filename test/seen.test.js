'use strict'
// Copied from cc-cockpit-github test/seen.test.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createSeen, keyOf, PRUNE_AFTER } = require('../dist/lib/seen')
const { memStore, fakeClock, fakeCtx } = require('./fakes')

const item = (id, rev = 'r1') => ({ id, rev, title: id, read: false })

function setup(store = memStore()) {
  const clock = fakeClock()
  const seen = createSeen({ store, now: clock.now, log: fakeCtx().log })
  return { store, clock, seen }
}

test('first poll for a login seeds every current item as read', async () => {
  const { seen, store } = setup()
  await seen.use('Me')
  const out = await seen.apply([item('a'), item('b')])
  assert.deepEqual(out.map((i) => i.read), [true, true])
  assert.equal((await store.get('seen:me')).seeded, true)
  // A later item is new: unread.
  const next = await seen.apply([item('a'), item('b'), item('c')])
  assert.deepEqual(next.map((i) => [i.id, i.read]), [['a', true], ['b', true], ['c', false]])
})

test('a new rev makes an item unread; markRead / markUnread', async () => {
  const { seen } = setup()
  await seen.use('me')
  await seen.apply([item('a')])
  let [a] = await seen.apply([item('a', 'r2')])
  assert.equal(a.read, false)
  await seen.markRead(item('a', 'r2'))
  ;[a] = await seen.apply([item('a', 'r2')])
  assert.equal(a.read, true)
  await seen.markUnread(item('a', 'r2'))
  ;[a] = await seen.apply([item('a', 'r2')])
  assert.equal(a.read, false)
})

test('done hides the item until something new happens, then it is back unread', async () => {
  const { seen } = setup()
  await seen.use('me')
  await seen.apply([item('a'), item('b')])
  await seen.done(item('a'))
  assert.equal(seen.isDone(item('a')), true)
  assert.deepEqual((await seen.apply([item('a'), item('b')])).map((i) => i.id), ['b'])
  const back = await seen.apply([item('a', 'r2'), item('b')])
  assert.deepEqual(back.map((i) => [i.id, i.read]), [['a', false], ['b', true]])
})

test('marks of ids gone for 30 days are pruned; recent ones kept', async () => {
  const { seen, clock, store } = setup()
  await seen.use('me')
  await seen.apply([item('a'), item('b')])
  clock.advance(PRUNE_AFTER - 1000)
  await seen.apply([item('b')])
  assert.ok((await store.get('seen:me')).items.a)
  clock.advance(2000)
  await seen.apply([item('b')])
  assert.equal((await store.get('seen:me')).items.a, undefined)
  assert.ok((await store.get('seen:me')).items.b)
})

test('per login: a second login starts seeded on its own, not mixed', async () => {
  const { seen, store } = setup()
  await seen.use('me')
  await seen.apply([item('a')])
  await seen.markUnread(item('a'))
  await seen.use('other')
  const [a] = await seen.apply([item('a')])
  assert.equal(a.read, true)
  assert.deepEqual((await store.keys()).sort(), [keyOf('me'), keyOf('other')])
})

test('two windows share the marks: a mark in one is seen by the other next poll', async () => {
  const shared = memStore()
  const w1 = setup(shared).seen
  const w2 = setup(shared).seen
  await w1.use('me')
  await w2.use('me')
  await w1.apply([item('a'), item('b')])
  await w2.apply([item('a', 'r2'), item('b')])
  await w1.markRead(item('a', 'r2'))
  await w2.markUnread(item('b'))
  const [a, b] = await w1.apply([item('a', 'r2'), item('b')])
  assert.equal(a.read, true)
  assert.equal(b.read, false)
})

test('a store that fails: logged, nothing thrown, items still come back', async () => {
  const broken = { get: async () => Promise.reject(new Error('down')), set: async () => Promise.reject(new Error('down')) }
  const ctx = fakeCtx()
  const seen = createSeen({ store: broken, log: ctx.log })
  await seen.use('me')
  const out = await seen.apply([item('a')])
  assert.equal(out.length, 1)
  await seen.markRead(item('a'))
  assert.ok(ctx.logs.some(([, m]) => /read marks/.test(m)))
})
