'use strict'
// Search results + enrichment to items, by the shared convention (cc-cockpit-github docs/item-convention.md).
// Adapted from cc-cockpit-github's model.js: the facts come from REST (search.js) instead of GraphQL nodes.
//
// An item is the inbox-feed v2 item plus `_`, this plugin's own facts (kind, url, lanes, repo, number, head) that
// never leave the host except to its own panel and overlay; feed.js strips `_` before an item reaches Inbox.
//
// `rev` moves only when someone else did something (their comment, their review, a head going into failure), so the
// person's own comment, review or green push never makes their item unread again or brings back an Inbox Done.
//
// Gitea has no review decision: it is the newest review per reviewer (a dismissed review and a plain comment
// review do not count); any "request changes" among them wins over approvals.
//
// URLs are built from the base the person configured, never taken from the server's `html_url`: the server writes
// that from its own ROOT_URL, which can be another host name or scheme than the one the person can reach.

const { isExcluded } = require('./settings')

const CAP = { title: 300, preview: 1000, place: 120, status: 60, label: 40, from: 120 }

function line(s, n) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function ms(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** `@login` as a whole word: not part of an email (`x@me.com`) or a longer login (`@meow`). */
function mentions(body, me) {
  if (!body || !me) return false
  const esc = me.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_.-])@${esc}(?![A-Za-z0-9_.-]*[A-Za-z0-9_-])`, 'i').test(body)
}

const login = (a) => (a && typeof a.login === 'string' ? a.login : '')
const same = (a, b) => a.toLowerCase() === b.toLowerCase()

const REVIEW_VERB = { APPROVED: 'approved', REQUEST_CHANGES: 'requested changes', COMMENT: 'reviewed', REQUEST_REVIEW: 'asked for a review' }

/** What other people did, newest first: `{ kind, who, at, text, state? }`. */
function othersEvents(e, me) {
  const ev = []
  for (const c of (e && e.comments) || []) {
    if (!c.user || same(c.user, me) || !c.at) continue
    ev.push({ kind: 'comment', who: c.user, at: c.at, text: c.body })
  }
  for (const r of (e && e.reviews) || []) {
    if (!r.user || same(r.user, me) || !r.at || r.state === 'PENDING' || r.state === 'REQUEST_REVIEW') continue
    ev.push({ kind: 'review', who: r.user, at: r.at, text: r.body, state: r.state })
  }
  return ev.sort((a, b) => b.at - a.at)
}

function eventText(e) {
  if (e.kind === 'review') {
    const verb = REVIEW_VERB[e.state] || 'reviewed'
    return e.text ? `${e.who} ${verb}: ${e.text}` : `${e.who} ${verb}`
  }
  return `${e.who} commented: ${e.text}`
}

/** `approved`, `changes-requested` or '' from the newest counting review of each reviewer. */
function decision(reviews) {
  const last = new Map()
  for (const r of [...(reviews || [])].sort((a, b) => a.at - b.at)) {
    if (r.dismissed || (r.state !== 'APPROVED' && r.state !== 'REQUEST_CHANGES')) continue
    last.set(r.user.toLowerCase(), r.state)
  }
  const states = [...last.values()]
  if (states.includes('REQUEST_CHANGES')) return 'changes-requested'
  if (states.includes('APPROVED')) return 'approved'
  return ''
}

function repoLabels(full) {
  const out = []
  const repo = `repo:${full.toLowerCase()}`
  // A label is at most 40 characters: a long owner/repo has no repo: label (rules can use owner: or the place).
  if (repo.length <= CAP.label) out.push(repo)
  const owner = `owner:${full.split('/')[0].toLowerCase()}`
  if (owner.length <= CAP.label) out.push(owner)
  return out
}

/** The web page of a PR or issue on the configured server. */
function webOf(base, full, kind, n) {
  return `${base}/${full}/${kind === 'pr' ? 'pulls' : 'issues'}/${n}`
}

/**
 * A PR to an item. `it`: the search result; `e`: its enrichment (or undefined before the first one); `inLanes`:
 * `reviewRequested` / `myPrs`; `ctx`: `{ me, base, teamIds }`.
 */
function prItem(it, e, inLanes, { me, base, teamIds }) {
  const full = it.repository.full_name
  const pr = e && e.pr
  const state = e ? e.status : ''
  const failing = state === 'failure' || state === 'error'
  const pending = state === 'pending'
  const conflict = !!pr && pr.mergeable === false
  const draft = pr ? pr.draft : !!(it.pull_request && it.pull_request.draft)
  const dec = decision(e && e.reviews)
  const ev = othersEvents(e, me)
  const newest = ev[0]
  const labels = ['pr']
  let to
  if (inLanes.includes('reviewRequested')) {
    // The search says the person's review is requested; the PR says whether directly or through a team. Before the
    // PR was read (or when it lists neither), it counts as direct.
    const direct = !pr || pr.requestedUsers.some((u) => same(u, me)) || !pr.requestedTeamIds.some((id) => teamIds && teamIds.has(id))
    labels.push(direct ? 'review-requested' : 'team-review-requested')
    to = direct ? 'direct' : 'group'
  }
  if (inLanes.includes('myPrs')) labels.push('my-pr')
  if (draft) labels.push('draft')
  if (dec) labels.push(dec)
  if (failing) labels.push('ci:failed')
  if (pending) labels.push('ci:pending')
  if (conflict) labels.push('conflict')
  labels.push(...repoLabels(full))
  const status = draft ? 'draft' : conflict ? 'conflict' : failing ? 'failing' : dec === 'changes-requested' ? 'changes requested' : dec === 'approved' ? 'approved' : 'open'
  const author = login(it.user)
  let preview
  if (newest) preview = eventText(newest)
  else if (inLanes.includes('reviewRequested') && !inLanes.includes('myPrs')) preview = `${author || 'Someone'} asked for your review`
  else preview = `Opened by ${author || 'you'}`
  if (failing && inLanes.includes('myPrs')) preview = `CI failed · ${preview}`
  const newestComment = ev.find((x) => x.kind === 'comment')
  const newestReview = ev.find((x) => x.kind === 'review')
  const sha = pr ? pr.headSha : ''
  const rev = [`c:${newestComment ? newestComment.at : 0}`, `r:${newestReview ? newestReview.at : 0}`, `f:${failing ? sha : ''}`].join('|')
  const item = {
    id: `pr:${full}#${it.number}`,
    rev,
    title: line(`${full}#${it.number} ${it.title}`, CAP.title),
    preview: line(preview, CAP.preview),
    time: Math.max(newest ? newest.at : 0, ms(it.created_at)) || ms(it.updated_at) || 1,
    read: false,
    place: { kind: 'project', name: line(full, CAP.place), status },
    labels,
    actions: [],
    _: {
      kind: 'pr',
      url: webOf(base, full, 'pr', it.number),
      lanes: inLanes.includes('reviewRequested') ? ['reviewRequested'].concat(inLanes.includes('myPrs') ? ['myPrs'] : []) : ['myPrs'],
      repo: full,
      number: it.number,
      sha,
      ci: state,
      author,
      head: pr ? pr.headRef : '',
      base: pr ? pr.baseRef : '',
    },
  }
  const fromWho = newest ? newest.who : author
  if (fromWho) item.from = { name: line(fromWho, CAP.from) }
  if (to) item.to = to
  if (newest && mentions(newest.text, me)) item.mentionsMe = true
  return item
}

/** An issue to an item. `inQueries`: `assigned` and/or `mentioned`. */
function issueItem(it, e, inQueries, { me, base }) {
  const full = it.repository.full_name
  const assigned = (it.assignees || []).some((a) => same(login(a), me)) || inQueries.includes('assigned')
  const ev = othersEvents(e, me)
  const newest = ev[0]
  const labels = ['issue']
  if (assigned) labels.push('assigned')
  if (inQueries.includes('mentioned')) labels.push('mentioned')
  labels.push(...repoLabels(full))
  const author = login(it.user)
  const item = {
    id: `issue:${full}#${it.number}`,
    rev: `c:${newest ? newest.at : ms(it.created_at)}`,
    title: line(`${full}#${it.number} ${it.title}`, CAP.title),
    preview: line(newest ? eventText(newest) : `Opened by ${author || 'someone'}`, CAP.preview),
    time: Math.max(newest ? newest.at : 0, ms(it.created_at)) || ms(it.updated_at) || 1,
    read: false,
    place: { kind: 'project', name: line(full, CAP.place), status: 'open' },
    labels,
    to: assigned ? 'direct' : 'cc',
    actions: [],
    _: { kind: 'issue', url: webOf(base, full, 'issue', it.number), lanes: ['issues'], repo: full, number: it.number, author },
  }
  const fromWho = newest ? newest.who : author
  if (fromWho) item.from = { name: line(fromWho, CAP.from) }
  if (newest && mentions(newest.text, me)) item.mentionsMe = true
  return item
}

function valid(it) {
  const full = it && it.repository && it.repository.full_name
  return typeof full === 'string' && /^[^/\s]+\/[^/\s]+$/.test(full) && Number.isInteger(it.number) && it.number > 0 && typeof it.title === 'string'
}

/**
 * Every item from one poll: `results` (`{ reviewRequested, myPrs, assigned, mentioned }` search lists), `enriched`
 * (search.js: Map `owner/repo#n` → facts), `ctx` `{ me, base, teamIds }`. Excluded repos are left out; a result in
 * two searches is one item with both facts.
 */
function buildItems(results, enriched, settings, ctx) {
  const prLanes = new Map()
  const issueQs = new Map()
  const byKey = new Map()
  const note = (map, it, key) => {
    const k = `${it.repository.full_name}#${it.number}`
    if (!map.has(k)) map.set(k, [])
    if (!map.get(k).includes(key)) map.get(k).push(key)
    byKey.set(k, it)
  }
  for (const key of ['reviewRequested', 'myPrs']) {
    for (const it of results[key] || []) if (valid(it) && it.pull_request && !isExcluded(it.repository.full_name, settings)) note(prLanes, it, key)
  }
  for (const key of ['assigned', 'mentioned']) {
    for (const it of results[key] || []) if (valid(it) && !it.pull_request && !isExcluded(it.repository.full_name, settings)) note(issueQs, it, key)
  }
  const items = []
  for (const [k, lanes] of prLanes) items.push(prItem(byKey.get(k), enriched && enriched.get(k), lanes, ctx))
  for (const [k, qs] of issueQs) items.push(issueItem(byKey.get(k), enriched && enriched.get(k), qs, ctx))
  return items
}

module.exports = { buildItems, prItem, issueItem, mentions, decision, line, webOf, CAP }
