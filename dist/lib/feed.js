'use strict'
// Copied from cc-cockpit-github dist/lib/feed.js; keep in step. Changes: the host name ("Gitea" or "Forgejo", from
// the probe) in the action labels and describe(); Re-run keyed on the run number and offered only where the server
// has the re-run API (probe features.rerun).
//
// The inbox-feed v2 provider (cc-cockpit-inbox docs/design-v2.md, "The feed contract"): facts only, every item in
// scope, `item` / `gone` events from a diff of each poll against what was last told, a whole `sync` whenever the
// state changes or Inbox might have missed something. Items here carry `_` (this plugin's own facts); it is
// stripped before anything leaves.
//
// After a restart the last list is restored from storage and answered as stale (`state: 'error'`, "Not refreshed
// yet") until the first poll succeeds, so an Inbox asking for a snapshot in between keeps its rows instead of
// seeing an empty `ok` and dropping them.

const MAX_ITEMS = 1000
const MAX_GONE = 500
const MSG = 300

/** Action labels for a host name ("Gitea", "Forgejo"); before the first probe the name is not known yet. */
function labelsFor(hostName) {
  const on = hostName ? ` on ${hostName}` : ' on the server'
  return { open: 'Open', markRead: 'Mark read', markUnread: 'Mark unread', done: `Done${on}`, rerun: 'Re-run failed jobs', openWeb: `Open${on}` }
}

/** describe() label, badge and colour per flavour (the inbox palette has green and amber). */
const LOOKS = {
  gitea: { label: 'Gitea', badge: 'GT', color: 'green' },
  forgejo: { label: 'Forgejo', badge: 'FJ', color: 'amber' },
  none: { label: 'Gitea / Forgejo', badge: 'GT', color: 'green' },
}

const LANE_WORDS = { reviewRequested: 'review requests', myPrs: 'your pull requests', issues: 'your issues', failedRuns: 'your failed runs' }

function cut(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** describe().scope: what the feed holds, from the settings. */
function scopeLine(settings) {
  const on = Object.keys(LANE_WORDS).filter((k) => settings.lanes[k])
  if (!on.length) return 'Nothing: every lane is off in the plugin settings'
  const words = on.map((k) => LANE_WORDS[k])
  let s = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]
  s = s[0].toUpperCase() + s.slice(1)
  if (settings.exclude.length) s += `; leaves out ${settings.exclude.length} owner${settings.exclude.length === 1 ? '' : 's'} or repo${settings.exclude.length === 1 ? '' : 's'}`
  return cut(s, 120)
}

/**
 * Whether Re-run applies now: a run, or an own failing PR linked to its run; never while the run is going, and only
 * on a server with the re-run API (`host.features.rerun`).
 */
function canRerun(item, host) {
  const x = item._
  if (!host || !host.features || !host.features.rerun) return false
  if (!x || !Number.isInteger(x.runNumber)) return false
  const status = x.kind === 'run' ? x.status : x.runStatus
  return status === 'completed' || status === undefined
}

/** `host`: the probe's info (`{ hostName, features }`) or null before the first probe. */
function actionsOf(item, host) {
  const labels = labelsFor(host && host.hostName)
  const ids = ['open', item.read ? 'markUnread' : 'markRead', 'done']
  if (canRerun(item, host)) ids.push('rerun')
  ids.push('openWeb')
  return ids.map((id) => ({ id, label: labels[id] }))
}

/** The item as Inbox sees it: no `_`, actions from its current state. */
function toFeed(item, host) {
  const { _, ...rest } = item
  return { ...rest, actions: actionsOf(item, host) }
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

function sorted(items) {
  return [...items].sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1)).slice(0, MAX_ITEMS)
}

/**
 * `emit(event, data)` is ctx.services.emit bound to 'inbox-feed'; `getSettings()` the normalised settings;
 * `getHost()` the probe's info or null;
 * `handlers` `{ mark(item, action), open(item), rerun(item), openWeb(item) }`, each resolving
 * `{ ok, message? }` or nothing (ok). Returns `{ provider, setItems, setState, restore, current, items, told }`.
 */
function createFeed({ emit, getSettings, getHost = () => null, handlers, now = Date.now, log }) {
  const feedOf = (item) => toFeed(item, getHost())
  let list = [] // the items (with `_`) last told
  let told = new Map() // id -> feed item as last told
  let state = 'error'
  let message = 'Not refreshed yet'
  let asOf = 0

  function send(event, data) {
    try {
      emit(event, data)
    } catch (e) {
      log.warn(`gitea: inbox-feed ${event}: ${e && e.message ? e.message : e}`)
    }
  }

  function syncData() {
    const items = sorted(list).map(feedOf)
    const s = { items, state, asOf: asOf || now() }
    if (state !== 'ok' && message) s.message = cut(message, MSG)
    return s
  }

  function remember() {
    told = new Map(sorted(list).map((i) => [i.id, feedOf(i)]))
  }

  const provider = {
    describe() {
      const h = getHost()
      const look = LOOKS[(h && h.flavour) || 'none'] || LOOKS.none
      return { ...look, kind: 'issues', scope: scopeLine(getSettings()) }
    },
    features() {
      return []
    },
    snapshot() {
      return syncData()
    },
    async act(id, action) {
      const item = list.find((i) => i.id === id)
      if (!item) return { ok: false, message: 'That item is no longer in the list.' }
      if (!actionsOf(item, getHost()).some((a) => a.id === action)) return { ok: false, message: `"${cut(action, 40)}" is not an action of that item now.` }
      try {
        let r
        if (action === 'markRead' || action === 'markUnread' || action === 'done') r = await handlers.mark(item, action)
        else if (action === 'open') r = await handlers.open(item)
        else if (action === 'rerun') r = await handlers.rerun(item)
        else if (action === 'openWeb') r = await handlers.openWeb(item)
        if (r && r.ok === false) return { ok: false, message: cut(r.message || 'It did not work.', MSG) }
        return { ok: true }
      } catch (e) {
        return { ok: false, message: cut(e && e.message ? e.message : 'It did not work.', MSG) }
      }
    },
  }

  return {
    provider,

    /** A successful poll's items (read set, done ones out). Emits a whole sync after a non-ok state, else the diff. */
    setItems(items, at = now()) {
      list = sorted(items)
      asOf = at
      if (state !== 'ok') {
        state = 'ok'
        message = ''
        remember()
        send('sync', syncData())
        return
      }
      const next = list.map(feedOf)
      const changed = next.filter((i) => !told.has(i.id) || stable(told.get(i.id)) !== stable(i))
      const nowIds = new Set(next.map((i) => i.id))
      const gone = [...told.keys()].filter((id) => !nowIds.has(id))
      for (const i of changed) send('item', i)
      for (let k = 0; k < gone.length; k += MAX_GONE) send('gone', { ids: gone.slice(k, k + MAX_GONE) })
      remember()
    },

    /** One item changed locally (marked read, done): tell it at once instead of waiting for the poll. */
    update(item) {
      const i = list.findIndex((x) => x.id === item.id)
      if (i < 0) return
      list[i] = item
      const f = feedOf(item)
      if (stable(told.get(item.id)) === stable(f)) return
      told.set(item.id, f)
      if (state === 'ok') send('item', f)
    },

    /** An item hidden locally (Done). */
    remove(id) {
      const had = list.some((x) => x.id === id)
      list = list.filter((x) => x.id !== id)
      if (!had) return
      told.delete(id)
      if (state === 'ok') send('gone', { ids: [id] })
    },

    /** `signedOut` or `error` with a message: Inbox keeps the last list and marks the source stale. */
    setState(next, msg) {
      if (next === state && msg === message) return
      state = next
      message = msg || ''
      send('sync', syncData())
    },

    /** The stored list after a restart: answered as stale until the first poll. */
    restore(stored) {
      if (!stored || !Array.isArray(stored.items)) return
      list = sorted(stored.items.filter((i) => i && typeof i.id === 'string' && i._))
      asOf = Number.isFinite(stored.asOf) ? stored.asOf : 0
      state = 'error'
      message = 'Not refreshed yet'
      remember()
    },

    /** What to store: the current list with `_`, and when it was fetched. */
    persisted() {
      return { items: list, asOf }
    },

    current(id) {
      return list.find((i) => i.id === id) || null
    },
    get items() {
      return list
    },
    get state() {
      return state
    },
    get message() {
      return message
    },
  }
}

module.exports = { createFeed, toFeed, actionsOf, canRerun, scopeLine, labelsFor, LOOKS, MAX_ITEMS, MAX_GONE }
