'use strict'
// The lane searches and what a PR needs on top of them. Gitea and Forgejo have no GraphQL: `/repos/issues/search`
// answers issues (a PR is an issue with `pull_request`), with no review state, no head commit and no CI. So each PR
// costs REST calls of its own, kept down by a cache:
//   - `pulls/{n}`, its reviews and its newest comments are fetched again only when the PR's `updated_at` moved
//     (a new comment, review, push or edit moves it);
//   - the head commit's combined status is fetched on every poll, because CI finishing does NOT move `updated_at`;
//   - at most MAX_ENRICH PRs a poll, newest first; the rest keep their last state (or none yet).
// Issues get their newest comments the same way (cache by `updated_at`, at most MAX_ENRICH a poll): the item's
// `rev` is built from OTHER people's comments, so the person's own comment never makes their issue unread, and the
// search answers no comment text.
// One PR that fails is logged and keeps its cached state; a sign-out, a rate limit or a network failure stops the
// poll (they would fail every other call too).

const SEARCH_PAGES = 2
const SEARCH_LIMIT = 50
const MAX_ENRICH = 30
const KEEP_COMMENTS = 5
const KEEP_REVIEWS = 50
const COMMENTS_CAP = 2 * 1024 * 1024
const TEAMS_TTL = 3600_000

/**
 * The searches each enabled lane needs, by key. Issues are two searches (assigned, mentioned), merged later, and a
 * third (`created`) when the person wants the issues they opened too: on a team where nobody assigns, the issues a
 * person files for themselves are their work, and neither assigned nor mentioned finds them.
 */
function queries(lanes, { myIssues = false } = {}) {
  const q = {}
  const base = { state: 'open' }
  if (lanes.reviewRequested) q.reviewRequested = { ...base, type: 'pulls', review_requested: true }
  if (lanes.myPrs) q.myPrs = { ...base, type: 'pulls', created: true }
  if (lanes.issues) {
    q.assigned = { ...base, type: 'issues', assigned: true }
    q.mentioned = { ...base, type: 'issues', mentioned: true }
    if (myIssues) q.created = { ...base, type: 'issues', created: true }
  }
  return q
}

const stops = (e) => e && (e.signedOut || e.rateLimited || e.network)

/** `{ results: { key: Issue[] } }`: one search per query, 2 pages of 50 at most. */
async function searchAll(client, lanes, opts) {
  const results = {}
  for (const [key, query] of Object.entries(queries(lanes, opts))) {
    results[key] = await client.pages('/repos/issues/search', { query, pages: SEARCH_PAGES, limit: SEARCH_LIMIT })
  }
  return { results }
}

/** `owner/repo#n` of a search result, or null when it is not one we can address. */
function keyOf(issue) {
  const full = issue && issue.repository && issue.repository.full_name
  if (typeof full !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(full) || !Number.isInteger(issue.number)) return null
  return `${full}#${issue.number}`
}

const login = (u) => (u && typeof u.login === 'string' ? u.login : '')
const time = (s) => {
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

/** The parts of `pulls/{n}` the model uses. */
function prPart(pr) {
  return {
    draft: pr.draft === true,
    mergeable: pr.mergeable !== false,
    headSha: pr.head && typeof pr.head.sha === 'string' ? pr.head.sha : '',
    headRef: pr.head && typeof pr.head.ref === 'string' ? pr.head.ref : '',
    baseRef: pr.base && typeof pr.base.ref === 'string' ? pr.base.ref : '',
    requestedUsers: Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers.map(login).filter(Boolean) : [],
    requestedTeamIds: Array.isArray(pr.requested_reviewers_teams) ? pr.requested_reviewers_teams.map((t) => t && t.id).filter(Number.isInteger) : [],
  }
}

const reviewPart = (r) => ({ user: login(r.user), state: typeof r.state === 'string' ? r.state : '', at: time(r.submitted_at), body: typeof r.body === 'string' ? r.body : '', dismissed: r.dismissed === true })
const commentPart = (c) => ({ user: login(c.user), at: time(c.created_at), body: typeof c.body === 'string' ? c.body : '' })

/**
 * `{ enrich(client, results), teams(client), cache }`: the per-PR cache lives across polls (one per host).
 * `enrich` returns a Map `owner/repo#n` → `{ pr, reviews, comments, status }` for the PRs in `results` (and keeps
 * the cache to those PRs, so it never grows past what is open).
 */
function createEnricher({ now = Date.now, log }) {
  const cache = new Map() // key → { updatedAt, pr, reviews, comments, status }
  let teams = null // { at, ids: Set }

  async function teamIds(client) {
    if (teams && now() - teams.at < TEAMS_TTL) return teams.ids
    try {
      const list = await client.pages('/user/teams', { pages: 2, limit: 50 })
      teams = { at: now(), ids: new Set(list.map((t) => t && t.id).filter(Number.isInteger)) }
    } catch (e) {
      if (stops(e)) throw e
      log.warn(`gitea: could not read your teams (team review requests show as direct ones): ${e.message}`)
      teams = { at: now(), ids: new Set() }
    }
    return teams.ids
  }

  async function details(client, owner, repo, n) {
    const p = `/repos/${owner}/${repo}`
    const { data: pr } = await client.rest('GET', `${p}/pulls/${n}`)
    const reviews = await client.pages(`${p}/pulls/${n}/reviews`, { pages: 1, limit: KEEP_REVIEWS })
    const { data: comments } = await client.rest('GET', `${p}/issues/${n}/comments`, { maxBytes: COMMENTS_CAP })
    return {
      pr: prPart(pr || {}),
      reviews: reviews.map(reviewPart).filter((r) => r.user && r.state !== 'PENDING'),
      comments: (Array.isArray(comments) ? comments : []).slice(-KEEP_COMMENTS).map(commentPart).filter((c) => c.user),
    }
  }

  async function statusOf(client, owner, repo, sha) {
    if (!sha) return ''
    const { data } = await client.rest('GET', `/repos/${owner}/${repo}/commits/${sha}/status`)
    // No statuses at all reads as "pending" on some versions: with total_count 0 there is no CI to speak of.
    if (!data || data.total_count === 0) return ''
    return typeof data.state === 'string' ? data.state : ''
  }

  async function issueComments(client, owner, repo, n) {
    const { data: comments } = await client.rest('GET', `/repos/${owner}/${repo}/issues/${n}/comments`, { maxBytes: COMMENTS_CAP })
    return { pr: null, reviews: [], comments: (Array.isArray(comments) ? comments : []).slice(-KEEP_COMMENTS).map(commentPart).filter((c) => c.user) }
  }

  async function enrich(client, results) {
    const prs = new Map()
    const issues = new Map()
    for (const list of Object.values(results)) {
      for (const it of list || []) {
        const k = keyOf(it)
        if (k) (it.pull_request ? prs : issues).set(k, it)
      }
    }
    for (const k of [...cache.keys()]) if (!prs.has(k) && !issues.has(k)) cache.delete(k)
    const newest = (m) => [...m.entries()].sort((a, b) => time(b[1].updated_at) - time(a[1].updated_at)).slice(0, MAX_ENRICH)
    for (const [key, it, isPr] of [...newest(prs).map(([k, v]) => [k, v, true]), ...newest(issues).map(([k, v]) => [k, v, false])]) {
      const [full, n] = key.split('#')
      const [owner, repo] = full.split('/')
      try {
        let c = cache.get(key)
        if (!c || c.updatedAt !== it.updated_at) {
          const fresh = isPr ? await details(client, owner, repo, n) : await issueComments(client, owner, repo, n)
          c = { updatedAt: it.updated_at, status: c ? c.status : '', ...fresh }
          cache.set(key, c)
        }
        if (isPr) c.status = await statusOf(client, owner, repo, c.pr.headSha)
      } catch (e) {
        if (stops(e)) throw e
        log.warn(`gitea: could not read ${key}: ${e.message}`)
      }
    }
    const out = new Map()
    for (const [k, c] of cache) out.set(k, { pr: c.pr, reviews: c.reviews, comments: c.comments, status: c.status })
    return out
  }

  return { enrich, teams: teamIds, cache }
}

module.exports = { queries, searchAll, createEnricher, keyOf, MAX_ENRICH, SEARCH_LIMIT }
