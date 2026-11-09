'use strict'
// Made-up server data shaped like Gitea's API answers, for the suites. acme/widgets, alice, bob and me only.

const { json } = require('./fakes')

const T = (h, d = 9) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`

/** A search result (Issue) for a PR or an issue. */
function issue(n, over = {}) {
  const repo = over.repo || 'acme/widgets'
  const pr = over.pr !== false
  const out = {
    id: 1000 + n,
    number: n,
    title: over.title || `${pr ? 'PR' : 'Issue'} ${n}`,
    html_url: `https://git.example.com/${repo}/${pr ? 'pulls' : 'issues'}/${n}`,
    user: { login: over.author || 'me' },
    repository: { full_name: repo, name: repo.split('/')[1], owner: repo.split('/')[0] },
    pull_request: pr ? { draft: !!over.draft, merged: false, html_url: `https://git.example.com/${repo}/pulls/${n}` } : null,
    state: 'open',
    created_at: over.created || T(1),
    updated_at: over.updated || T(2),
    comments: 0,
    assignees: (over.assignees || []).map((login) => ({ login })),
    labels: [],
  }
  delete out.pr
  return out
}

/** `pulls/{n}`. */
function pull(n, over = {}) {
  return {
    number: n,
    draft: !!over.draft,
    mergeable: over.mergeable !== false,
    head: { ref: over.headRef || `b${n}`, sha: over.sha || `sha${n}` },
    base: { ref: 'main' },
    requested_reviewers: (over.reviewers || []).map((login) => ({ login })),
    requested_reviewers_teams: (over.teams || []).map((id) => ({ id, name: `team${id}` })),
  }
}

const review = (user, state, h, body = '') => ({ user: { login: user }, state, submitted_at: T(h), body, dismissed: false })
const comment = (user, h, body = 'hello') => ({ user: { login: user }, created_at: T(h), body })

/**
 * Routes for a world: `search` maps a lane key (reviewRequested, myPrs, assigned, mentioned) to Issue lists, `pulls`
 * maps `repo#n` to `{ pull, reviews, comments, status }`, `teams` the person's team ids, `tasks` maps repo to its
 * Actions task list (or a status number for an error).
 */
function worldRoutes(world) {
  const laneOf = (q) => (q.get('review_requested') ? 'reviewRequested' : q.get('created') ? 'myPrs' : q.get('assigned') ? 'assigned' : 'mentioned')
  return [
    ['GET', '/repos/issues/search', (u) => (u.searchParams.get('page') && u.searchParams.get('page') !== '1' ? json([]) : json((world.search || {})[laneOf(u.searchParams)] || []))],
    ['GET', '/user/teams', () => json((world.teams || []).map((id) => ({ id, name: `team${id}` })))],
    ['GET', /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/, (u, i, m) => {
      const p = (world.pulls || {})[`${m[1]}#${m[2]}`]
      return p ? json(p.pull || pull(Number(m[2]))) : json({ message: 'Not Found' }, 404)
    }],
    ['GET', /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/, (u, i, m) => json(((world.pulls || {})[`${m[1]}#${m[2]}`] || {}).reviews || [])],
    ['GET', /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/, (u, i, m) => json(((world.pulls || {})[`${m[1]}#${m[2]}`] || (world.issues || {})[`${m[1]}#${m[2]}`] || {}).comments || [])],
    ['GET', /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/status$/, (u, i, m) => {
      const s = (world.status || {})[m[2]]
      return json(s ? { state: s, total_count: 1, statuses: [] } : { state: 'pending', total_count: 0, statuses: [] })
    }],
    ['GET', /^\/repos\/([^/]+\/[^/]+)\/actions\/tasks$/, (u, i, m) => {
      const t = (world.tasks || {})[m[1]]
      if (typeof t === 'number') return json({ message: 'nope' }, t)
      const page = Number(u.searchParams.get('page') || 1)
      return json({ workflow_runs: page === 1 ? t || [] : [], total_count: (t || []).length })
    }],
    ['GET', /^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/, () => (world.runsApi ? json({ workflow_runs: [], total_count: 0 }) : json({ message: 'Not Found' }, 404))],
  ]
}

module.exports = { T, issue, pull, review, comment, worldRoutes }
