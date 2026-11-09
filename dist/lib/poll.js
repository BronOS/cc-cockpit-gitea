'use strict'
// Copied from cc-cockpit-github dist/lib/poll.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// When to poll: every `pollMinutes`, sooner on a refresh (coalesced: a refresh during a poll runs one more poll
// after it, never two at once), later after a failure. A network or server error backs off ×2 up to 15 minutes;
// a rate limit waits until GitHub's reset; signed out waits for a refresh or the normal interval (the person
// may run `gh auth login` meanwhile).

const MINUTE = 60_000
const MAX_BACKOFF = 15 * MINUTE

/**
 * `run()` does one poll and resolves `{ ok: true }` or `{ ok: false, until? , signedOut? }`. `minutes()` the
 * current interval. `timers` `{ set, clear }` (setTimeout / clearTimeout; fakes in tests).
 */
function createPoller({ run, minutes, now = Date.now, timers = { set: setTimeout, clear: clearTimeout }, log }) {
  let timer = null
  let running = false
  let again = false
  let stopped = false
  let failures = 0

  function schedule(ms) {
    if (stopped) return
    if (timer) timers.clear(timer)
    timer = timers.set(tick, Math.max(1000, ms))
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  async function tick() {
    timer = null
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = true
    let r
    try {
      r = await run()
    } catch (e) {
      log.warn(`gitea: poll failed: ${e && e.message ? e.message : e}`)
      r = { ok: false }
    }
    running = false
    if (stopped) return
    const base = minutes() * MINUTE
    if (r && r.ok) {
      failures = 0
      schedule(again ? 0 : base)
    } else if (r && Number.isFinite(r.until)) {
      schedule(Math.max(r.until - now(), 0) + 1000)
    } else if (r && r.signedOut) {
      schedule(base)
    } else {
      failures++
      schedule(Math.min(MAX_BACKOFF, base * 2 ** Math.min(failures, 4)))
    }
    again = false
  }

  return {
    /** Poll now (start, a refresh, settings changed). */
    now() {
      if (stopped) return
      if (running) {
        again = true
        return
      }
      schedule(0)
      // schedule() clamps to 1 s; a refresh should not wait that long.
      if (timer) timers.clear(timer)
      timer = null
      void tick()
    },
    stop() {
      stopped = true
      if (timer) timers.clear(timer)
      timer = null
    },
    get running() {
      return running
    },
  }
}

module.exports = { createPoller, MAX_BACKOFF }
