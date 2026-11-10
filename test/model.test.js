'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildItems, mentions, decision, line, CAP } = require('../dist/lib/model')
const { normalize } = require('../dist/lib/settings')
const { BASE } = require('./fakes')
const { T, issue } = require('./builders')

const settings = normalize({ serverUrl: BASE })
const ctx = { me: 'me', base: BASE, teamIds: new Set([7]) }
const at = (h) => Date.parse(T(h))
const prFacts = (over = {}) => ({
  pr: { draft: false, mergeable: true, headSha: 'abc', headRef: 'feature', baseRef: 'main', requestedUsers: [], requestedTeamIds: [], ...over.pr },
  reviews: over.reviews || [],
  comments: over.comments || [],
  status: over.status || '',
})
const rv = (user, state, h, body = '', dismissed = false) => ({ user, state, at: at(h), body, dismissed })
const cm = (user, h, body = 'hello') => ({ user, at: at(h), body })
const build = (results, enriched = new Map(), c = ctx) => buildItems(results, enriched, settings, c)

test('my PR: id, title, place, labels, URL from the configured base, author preview', () => {
  const [it] = build({ myPrs: [issue(1, { title: 'Fix login' })] }, new Map([['acme/widgets#1', prFacts()]]))
  assert.equal(it.id, 'pr:acme/widgets#1')
  assert.equal(it.title, 'acme/widgets#1 Fix login')
  assert.deepEqual(it.labels, ['pr', 'my-pr', 'repo:acme/widgets', 'owner:acme'])
  assert.deepEqual(it.place, { kind: 'project', name: 'acme/widgets', status: 'open' })
  assert.equal(it.preview, 'Opened by me')
  assert.equal(it._.url, `${BASE}/acme/widgets/pulls/1`)
  assert.equal(it._.sha, 'abc')
  assert.equal(it.to, undefined)
})

test('the URL ignores the server html_url (its ROOT_URL may be another host)', () => {
  const i = issue(1)
  i.html_url = 'http://gitea.internal:3000/acme/widgets/pulls/1'
  const [it] = build({ myPrs: [i] }, new Map(), { ...ctx, base: 'https://example.com/git' })
  assert.equal(it._.url, 'https://example.com/git/acme/widgets/pulls/1')
})

test('review requested: direct, through a team, or direct before the PR was read', () => {
  const direct = build({ reviewRequested: [issue(2, { author: 'alice' })] }, new Map([['acme/widgets#2', prFacts({ pr: { requestedUsers: ['ME'] } })]]))[0]
  assert.ok(direct.labels.includes('review-requested'))
  assert.equal(direct.to, 'direct')
  assert.equal(direct.preview, 'alice asked for your review')
  const team = build({ reviewRequested: [issue(2)] }, new Map([['acme/widgets#2', prFacts({ pr: { requestedTeamIds: [7] } })]]))[0]
  assert.ok(team.labels.includes('team-review-requested'))
  assert.equal(team.to, 'group')
  const otherTeam = build({ reviewRequested: [issue(2)] }, new Map([['acme/widgets#2', prFacts({ pr: { requestedTeamIds: [9] } })]]))[0]
  assert.ok(otherTeam.labels.includes('review-requested'))
  assert.ok(build({ reviewRequested: [issue(2)] })[0].labels.includes('review-requested'))
})

test('a PR in both lanes is one item with both labels', () => {
  const items = build({ reviewRequested: [issue(3)], myPrs: [issue(3)] })
  assert.equal(items.length, 1)
  assert.ok(items[0].labels.includes('review-requested') && items[0].labels.includes('my-pr'))
  assert.deepEqual(items[0]._.lanes, ['reviewRequested', 'myPrs'])
})

test('decision: newest review per reviewer; changes requested wins; dismissed and comment reviews do not count', () => {
  assert.equal(decision([rv('alice', 'REQUEST_CHANGES', 1), rv('alice', 'APPROVED', 2)]), 'approved')
  assert.equal(decision([rv('alice', 'APPROVED', 2), rv('bob', 'REQUEST_CHANGES', 1)]), 'changes-requested')
  assert.equal(decision([rv('alice', 'APPROVED', 1), rv('alice', 'COMMENT', 2)]), 'approved')
  assert.equal(decision([rv('alice', 'REQUEST_CHANGES', 1, '', true)]), '')
  assert.equal(decision([]), '')
})

test('state labels: draft, conflict, CI failed and pending, with place status', () => {
  const e = new Map([['acme/widgets#1', prFacts({ pr: { draft: true, mergeable: false }, status: 'failure' })]])
  const [it] = build({ myPrs: [issue(1)] }, e)
  for (const l of ['draft', 'conflict', 'ci:failed']) assert.ok(it.labels.includes(l), l)
  assert.equal(it.place.status, 'draft')
  assert.match(it.preview, /^CI failed · /)
  const [p] = build({ myPrs: [issue(1)] }, new Map([['acme/widgets#1', prFacts({ status: 'pending' })]]))
  assert.ok(p.labels.includes('ci:pending'))
  const [err] = build({ myPrs: [issue(1)] }, new Map([['acme/widgets#1', prFacts({ status: 'error' })]]))
  assert.ok(err.labels.includes('ci:failed'))
  assert.ok(build({ myPrs: [issue(1, { draft: true })] })[0].labels.includes('draft'), 'draft from the search before enrichment')
})

test('preview and from: the newest thing someone else did; mentionsMe', () => {
  const e = new Map([['acme/widgets#1', prFacts({ reviews: [rv('alice', 'REQUEST_CHANGES', 3, 'Please add a test')], comments: [cm('bob', 4, 'ping @me please'), cm('me', 5, 'done')] })]])
  const [it] = build({ myPrs: [issue(1)] }, e)
  assert.equal(it.preview, 'bob commented: ping @me please')
  assert.deepEqual(it.from, { name: 'bob' })
  assert.equal(it.mentionsMe, true)
  assert.equal(it.time, at(4))
  assert.ok(it.labels.includes('changes-requested'))
})

test('rev: the person own comments, reviews and a green CI never move it; a failing head does', () => {
  const base = prFacts({ comments: [cm('bob', 3)] })
  const rev = (facts) => build({ myPrs: [issue(1)] }, new Map([['acme/widgets#1', facts]]))[0].rev
  const r0 = rev(base)
  assert.equal(rev({ ...base, comments: [...base.comments, cm('me', 6)] }), r0)
  assert.equal(rev({ ...base, reviews: [rv('me', 'APPROVED', 7)] }), r0)
  assert.equal(rev({ ...base, status: 'success' }), r0)
  assert.equal(rev({ ...base, status: 'pending' }), r0)
  assert.notEqual(rev({ ...base, status: 'failure' }), r0)
  assert.notEqual(rev({ ...base, comments: [...base.comments, cm('alice', 8)] }), r0)
})

test('issues: assigned and mentioned merged; to direct or cc; rev from others comments', () => {
  const i = issue(5, { pr: false, assignees: ['me'], author: 'alice' })
  const e = new Map([['acme/widgets#5', { pr: null, reviews: [], comments: [cm('bob', 6, 'any news?'), cm('me', 7, 'soon')] }]])
  const items = build({ assigned: [i], mentioned: [i] }, e)
  assert.equal(items.length, 1)
  const it = items[0]
  assert.equal(it.id, 'issue:acme/widgets#5')
  assert.deepEqual(it.labels, ['issue', 'assigned', 'mentioned', 'repo:acme/widgets', 'owner:acme'])
  assert.equal(it.to, 'direct')
  assert.equal(it.preview, 'bob commented: any news?')
  assert.equal(it.rev, `c:${at(6)}`)
  assert.equal(it._.url, `${BASE}/acme/widgets/issues/5`)
  const cc = build({ mentioned: [issue(6, { pr: false, author: 'alice' })] })[0]
  assert.equal(cc.to, 'cc')
  assert.equal(cc.preview, 'Opened by alice')
})

test('issues I opened: my-issue, no to; also assigned to me: both labels and direct', () => {
  const mine = build({ created: [issue(8, { pr: false, author: 'me' })] })[0]
  assert.equal(mine.id, 'issue:acme/widgets#8')
  assert.deepEqual(mine.labels, ['issue', 'my-issue', 'repo:acme/widgets', 'owner:acme'])
  assert.equal(mine.to, undefined)
  assert.equal(mine.preview, 'Opened by me')
  assert.deepEqual(mine._.lanes, ['issues'])
  const both = issue(9, { pr: false, author: 'me', assignees: ['me'] })
  const it = build({ assigned: [both], created: [both] })
  assert.equal(it.length, 1)
  assert.deepEqual(it[0].labels, ['issue', 'assigned', 'my-issue', 'repo:acme/widgets', 'owner:acme'])
  assert.equal(it[0].to, 'direct')
  // A pull request in the created search is not an issue (the PR lane has it).
  assert.equal(build({ created: [issue(10, { author: 'me' })] }).length, 0)
})

test('mentions: a whole login only, dots allowed in Gitea logins', () => {
  assert.equal(mentions('ping @me', 'me'), true)
  assert.equal(mentions('thanks @me.', 'me'), true)
  assert.equal(mentions('@meow', 'me'), false)
  assert.equal(mentions('@me.x is someone else', 'me'), false)
  assert.equal(mentions('write to x@me.com', 'me'), false)
  assert.equal(mentions('', 'me'), false)
})

test('excluded repos and broken results are left out; caps', () => {
  const s = normalize({ serverUrl: BASE, exclude: ['acme/secret'] })
  const items = buildItems(
    {
      myPrs: [issue(1, { repo: 'acme/secret' }), { number: 2, title: 'x', repository: { full_name: 'bad' }, pull_request: {} }, issue(3, { title: 'x'.repeat(500) })],
      assigned: [issue(4)], // a PR in an issue search: not an issue
    },
    new Map(),
    s,
    ctx
  )
  assert.deepEqual(items.map((i) => i.id), ['pr:acme/widgets#3'])
  assert.equal(items[0].title.length, CAP.title)
  assert.equal(line('a\n\tb  c', 10), 'a b c')
  const long = build({ myPrs: [issue(1, { repo: 'a-very-long-organisation-name/an-even-longer-repository' })] })[0]
  assert.ok(!long.labels.some((l) => l.startsWith('repo:')))
})
