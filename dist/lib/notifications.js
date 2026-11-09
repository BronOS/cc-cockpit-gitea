'use strict'
// Keeps the server's notification bell in step with Mark read / Done, best-effort. Adapted from cc-cockpit-github's
// notifications.js; keep in step.
//
// The item's thread is found among its repo's unread PR and issue notifications, then marked read with
// `PATCH /notifications/threads/{id}?to-status=read`. Gitea and Forgejo have no "done" on the server, so Done marks
// the thread read too (Done itself is local). Only a thread id the server just listed is ever sent back; any
// failure is logged and the local mark stands. Runs have no thread.
//
// A thread is matched by the PATH of its subject `url` (API) or `html_url` (web page), never the host: the server
// writes both from its own ROOT_URL, which can be another host name than the one the person configured. A PR and
// an issue share one number space in a repo, so `pulls/n` and `issues/n` are the same item.

const CACHE_MS = 60_000

/** `/<owner>/<repo>/(pulls|issues)/<n>` matcher of an item, or null (a run, a broken item). */
function subjectMatcher(item) {
  const x = item && item._
  if (!x || typeof x.repo !== 'string' || !Number.isInteger(x.number) || (x.kind !== 'pr' && x.kind !== 'issue')) return null
  const tail = (kind) => `/${x.repo}/${kind}/${x.number}`.toLowerCase()
  const ends = [tail('pulls'), tail('issues')]
  return (u) => {
    if (typeof u !== 'string' || !u) return false
    let path
    try {
      path = new URL(u).pathname.replace(/\/+$/, '').toLowerCase()
    } catch {
      return false
    }
    return ends.some((e) => path.endsWith(e))
  }
}

/** `getClient()` the current client (it is rebuilt when the settings change), or null when signed out. */
function createNotifications({ getClient, now = Date.now, log }) {
  const cache = new Map() // repo (lower case) -> { at, threads }

  async function threadsOf(client, repo) {
    const k = repo.toLowerCase()
    const c = cache.get(k)
    if (c && now() - c.at < CACHE_MS) return c.threads
    const [owner, name] = repo.split('/')
    const threads = await client.pages(`/repos/${owner}/${name}/notifications`, {
      query: { 'status-types': 'unread', 'subject-type': ['pull', 'issue'] },
      pages: 2,
      limit: 50,
    })
    cache.set(k, { at: now(), threads })
    return threads
  }

  async function markRead(item) {
    const match = subjectMatcher(item)
    if (!match) return false
    const client = getClient()
    if (!client) return false
    try {
      const threads = await threadsOf(client, item._.repo)
      const t = threads.find((th) => th && th.subject && (match(th.subject.url) || match(th.subject.html_url)))
      const id = t && /^\d{1,20}$/.test(String(t.id)) ? String(t.id) : null
      if (!id) return false
      await client.rest('PATCH', `/notifications/threads/${id}`, { query: { 'to-status': 'read' } })
      cache.delete(item._.repo.toLowerCase())
      return true
    } catch (e) {
      log.warn(`gitea: could not mark the notification of ${item.id} read: ${e && e.message ? e.message : e}`)
      return false
    }
  }

  return {
    /** Mark the item's thread read. Resolves whether a thread was marked; never rejects. */
    markRead,
    /** No "done" on the server: the thread is marked read. */
    markDone: markRead,
  }
}

module.exports = { createNotifications, subjectMatcher }
