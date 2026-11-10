'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalize, isExcluded, parseServer, tokenOf } = require('../dist/lib/settings')
const { TOKEN } = require('./fakes')

test('defaults for an empty or missing project: no server, no token', () => {
  for (const raw of [undefined, null, {}, 'x']) {
    const s = normalize(raw)
    assert.deepEqual({ ...s, serverProblem: '' }, {
      server: null,
      serverProblem: '',
      hasToken: false,
      lanes: { reviewRequested: true, myPrs: true, issues: true, failedRuns: true },
      rowsPerLane: 10,
      markReadOnOpen: true,
      myIssues: false,
      exclude: [],
      pollMinutes: 2,
      warnings: [],
    })
    assert.match(s.serverProblem, /Set the server address/)
  }
})

test('the token never appears in the normalised settings, only whether it is set', () => {
  const s = normalize({ serverUrl: 'https://git.example.com', token: TOKEN })
  assert.equal(s.hasToken, true)
  assert.ok(!JSON.stringify(s).includes(TOKEN))
  assert.equal(tokenOf({ token: ` ${TOKEN} ` }), TOKEN)
  for (const raw of [{}, { token: '' }, { token: '  ' }, { token: 7 }, null]) assert.equal(tokenOf(raw), null)
})

test('lanes, numbers and the flag: kept when valid, clamped or defaulted otherwise', () => {
  const s = normalize({ lanes: { issues: false, failedRuns: 'no' }, rowsPerLane: 999, pollMinutes: 1, markReadOnOpen: false })
  assert.deepEqual(s.lanes, { reviewRequested: true, myPrs: true, issues: false, failedRuns: true })
  assert.equal(s.rowsPerLane, 300)
  assert.equal(s.pollMinutes, 2)
  assert.equal(s.markReadOnOpen, false)
  assert.equal(normalize({ myIssues: true }).myIssues, true)
  assert.equal(normalize({ myIssues: 'yes' }).myIssues, false)
  assert.equal(normalize({ pollMinutes: 99 }).pollMinutes, 15)
  assert.equal(normalize({ rowsPerLane: 2.5 }).rowsPerLane, 10)
})

test('exclude: owners and repos lower-cased and deduped, Gitea names with dots and underscores, junk dropped', () => {
  const s = normalize({ exclude: ['Acme', ' acme/Widgets ', 'acme', 'a/b/c', '-bad', 'acme/..', '', 'my_org.x/x.y_z', 42] })
  assert.deepEqual(s.exclude, ['acme', 'acme/widgets', 'my_org.x/x.y_z'])
  assert.equal(s.warnings.length, 5)
  assert.match(s.warnings[0], /a\/b\/c/)
})

test('isExcluded: by owner or by exact repo, any case', () => {
  const s = normalize({ exclude: ['acme', 'globex/secret'] })
  assert.equal(isExcluded('ACME/widgets', s), true)
  assert.equal(isExcluded('globex/secret', s), true)
  assert.equal(isExcluded('globex/public', s), false)
  assert.equal(isExcluded('acmeco/x', s), false)
  assert.equal(isExcluded(undefined, s), false)
})

test('server address: https with or without a path prefix and a port, trailing slash dropped', () => {
  const ok = (v, base, prefix) => {
    const r = parseServer(v)
    assert.ok(r.server, `${v}: ${r.problem}`)
    assert.equal(r.server.base, base)
    assert.equal(r.server.prefix, prefix)
  }
  ok('https://git.example.com', 'https://git.example.com', '')
  ok(' https://git.example.com/ ', 'https://git.example.com', '')
  ok('https://example.com/gitea/', 'https://example.com/gitea', '/gitea')
  ok('https://git.example.com:3000', 'https://git.example.com:3000', '')
  ok('http://localhost:3000', 'http://localhost:3000', '')
  ok('http://127.0.0.1:3000/', 'http://127.0.0.1:3000', '')
  ok('http://[::1]:3000', 'http://[::1]:3000', '')
})

test('server address: refused with a sentence that says why', () => {
  for (const v of [
    'http://git.example.com',
    'http://10.0.0.5:3000',
    'https://me:secret@git.example.com',
    'https://git.example.com/?x=1',
    'https://git.example.com/#top',
    'https://git.example.com/a/../b',
    'https://git.example.com/%2e%2e',
    'ftp://git.example.com',
    'javascript:alert(1)',
    'git.example.com',
    'not a url',
  ]) {
    const r = parseServer(v)
    assert.equal(r.server, undefined, v)
    assert.ok(r.problem && r.problem.length > 10, v)
  }
  assert.match(parseServer('http://git.example.com').problem, /https/)
  // The sentence reaches the panel and the log: a password typed into the address never shows in it.
  assert.ok(!parseServer('https://me:secret@git.example.com').problem.includes('secret'))
  assert.ok(!parseServer('https://me:secret@git.example.com/?x').problem.includes('secret'))
})
