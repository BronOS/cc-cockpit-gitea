'use strict'
// Copied from cc-cockpit-github test/poll.test.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPoller, MAX_BACKOFF } = require('../dist/lib/poll')
const { fakeCtx, fakeClock } = require('./fakes')

/** Timers a test fires by hand: `next()` runs the pending one and returns its delay. */
function fakeTimers() {
  let pending = null
  let id = 0
  return {
    set(fn, ms) {
      pending = { fn, ms, id: ++id }
      return pending.id
    },
    clear(t) {
      if (pending && pending.id === t) pending = null
    },
    get delay() {
      return pending ? pending.ms : null
    },
    async fire() {
      const p = pending
      pending = null
      await p.fn()
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

function setup(results) {
  const t = fakeTimers()
  const clock = fakeClock()
  let n = 0
  const runs = []
  const p = createPoller({
    run: async () => {
      runs.push(clock.now())
      return results[n++] || { ok: true }
    },
    minutes: () => 2,
    now: clock.now,
    timers: t,
    log: fakeCtx().log,
  })
  return { t, clock, p, runs }
}

test('polls at once, then every pollMinutes', async () => {
  const { t, p, runs } = setup([])
  p.now()
  await flush()
  assert.equal(runs.length, 1)
  assert.equal(t.delay, 120_000)
  await t.fire()
  assert.equal(runs.length, 2)
  assert.equal(t.delay, 120_000)
})

test('network failures back off ×2, capped at 15 minutes; success resets', async () => {
  const { t, p } = setup([{ ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: true }])
  p.now()
  await flush()
  const delays = [t.delay]
  for (let i = 0; i < 5; i++) {
    await t.fire()
    delays.push(t.delay)
  }
  assert.deepEqual(delays, [240_000, 480_000, 900_000, MAX_BACKOFF, MAX_BACKOFF, 120_000])
})

test('a rate limit waits until the reset', async () => {
  const clock = fakeClock()
  const { t, p } = setup([{ ok: false, until: clock.now() + 600_000 }])
  p.now()
  await flush()
  assert.equal(t.delay, 601_000)
})

test('signed out waits the normal interval', async () => {
  const { t, p } = setup([{ ok: false, signedOut: true }])
  p.now()
  await flush()
  assert.equal(t.delay, 120_000)
})

test('a refresh while polling runs one more poll right after, never two at once', async () => {
  const t = fakeTimers()
  let release
  let active = 0
  let max = 0
  let count = 0
  const p = createPoller({
    run: async () => {
      count++
      active++
      max = Math.max(max, active)
      if (count === 1) await new Promise((r) => (release = r))
      active--
      return { ok: true }
    },
    minutes: () => 2,
    timers: t,
    log: fakeCtx().log,
  })
  p.now()
  await flush()
  p.now()
  p.now()
  release()
  await flush()
  assert.equal(t.delay, 1000)
  await t.fire()
  assert.equal(count, 2)
  assert.equal(max, 1)
  assert.equal(t.delay, 120_000)
})

test('a throwing run is logged and backs off; stop ends it', async () => {
  const ctx = fakeCtx()
  const t = fakeTimers()
  const p = createPoller({ run: async () => Promise.reject(new Error('boom')), minutes: () => 2, timers: t, log: ctx.log })
  p.now()
  await flush()
  assert.ok(ctx.logs.some(([, m]) => /poll failed: boom/.test(m)))
  assert.equal(t.delay, 240_000)
  p.stop()
  p.now()
  await flush()
  assert.equal(t.delay, null)
})
