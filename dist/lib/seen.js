'use strict'
// Copied from cc-cockpit-github dist/lib/seen.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
// Read and done marks, account-wide: `ctx.appStorage` under one key per GitHub login, so every project window
// agrees (each window runs its own host and the feed is the same account everywhere). An item is read while its
// stored read rev equals its current rev, and hidden while its done rev does; any new rev (someone commented, a
// new failure) makes it unread and visible again.
//
// The first poll for a login records every current item as read: a fresh install would otherwise open on a wall
// of unread items that are old news. Each change re-reads the stored document first and writes it straight back,
// so two windows marking at nearly the same time lose at most that one race, never the whole list.

const PRUNE_AFTER = 30 * 864e5
const VERSION = 1

function keyOf(login) {
  return `seen:${String(login).toLowerCase()}`
}

function empty() {
  return { v: VERSION, seeded: false, items: {} }
}

function valid(doc) {
  return doc && doc.v === VERSION && typeof doc.items === 'object' && doc.items !== null && !Array.isArray(doc.items)
}

/** `store` is ctx.appStorage (a memStore in tests). */
function createSeen({ store, now = Date.now, log }) {
  let login = null
  let doc = empty()

  async function load() {
    if (!login) return empty()
    try {
      const d = await store.get(keyOf(login))
      return valid(d) ? d : empty()
    } catch (e) {
      log.warn(`gitea: could not read read marks: ${e && e.message ? e.message : e}`)
      return empty()
    }
  }

  async function save() {
    if (!login) return
    try {
      await store.set(keyOf(login), doc)
    } catch (e) {
      log.warn(`gitea: could not save read marks: ${e && e.message ? e.message : e}`)
    }
  }

  /** Re-read, change, write back: `fn(doc.items)` returns whether it changed something. */
  async function change(fn) {
    doc = await load()
    if (fn(doc.items)) await save()
  }

  return {
    /** Switch to a login (after sign-in); loads its marks. */
    async use(l) {
      login = l
      doc = await load()
    },
    get login() {
      return login
    },

    /**
     * The poll's items with `read` set and done ones left out. Seeds on the first poll for the login, notes when
     * each id was last present, and prunes marks of ids gone for 30 days.
     */
    async apply(items) {
      doc = await load()
      const t = now()
      let dirty = false
      if (!doc.seeded) {
        for (const it of items) doc.items[it.id] = { r: it.rev, t }
        doc.seeded = true
        dirty = true
      }
      const present = new Set()
      const out = []
      for (const it of items) {
        present.add(it.id)
        const e = doc.items[it.id]
        if (e && e.t !== t) {
          e.t = t
          dirty = true
        }
        if (e && e.d === it.rev) continue
        out.push({ ...it, read: Boolean(e && e.r === it.rev) })
      }
      for (const [id, e] of Object.entries(doc.items)) {
        if (!present.has(id) && !(t - (e.t || 0) < PRUNE_AFTER)) {
          delete doc.items[id]
          dirty = true
        }
      }
      if (dirty) await save()
      return out
    },

    async markRead(item) {
      await change((m) => {
        const e = m[item.id] || (m[item.id] = { t: now() })
        if (e.r === item.rev) return false
        e.r = item.rev
        return true
      })
    },

    async markUnread(item) {
      await change((m) => {
        const e = m[item.id]
        if (!e || e.r === undefined) return false
        delete e.r
        return true
      })
    },

    /** Hidden until its rev changes; also read, so it comes back unread only for something new. */
    async done(item) {
      await change((m) => {
        const e = m[item.id] || (m[item.id] = { t: now() })
        e.r = item.rev
        e.d = item.rev
        return true
      })
    },

    /** Whether an id is hidden as done at this rev (for act() on an item that just went). */
    isDone(item) {
      const e = doc.items[item.id]
      return Boolean(e && e.d === item.rev)
    },
  }
}

module.exports = { createSeen, keyOf, PRUNE_AFTER }
