'use strict'
// Copied from cc-cockpit-github test/itemview.test.js; keep in step (identifiers kept as is, so a sync is a plain diff;
// only user-visible host names differ).
const test = require('node:test')
const assert = require('node:assert/strict')
const { DOMParser, parseHTML } = require('linkedom')
const { render } = require('../panels/itemview')
const { sanitize } = require('../panels/sanitize')

const { document } = parseHTML('<!doctype html><html><body></body></html>')
const s = { sanitize, parse: (html) => new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html') }

const pr = (over = {}) => ({
  kind: 'pr',
  title: 'acme/widgets#12 Fix login',
  url: 'https://github.com/acme/widgets/pull/12',
  header: { repo: 'acme/widgets', number: 12, state: 'open', head: 'fix', base: 'main', author: 'me', additions: 3, deletions: 1, changedFiles: 2, status: 'changes requested' },
  body: '<p>Fixes <script>x</script>login</p>',
  timeline: [{ kind: 'review', who: 'alice', at: 1, state: 'CHANGES_REQUESTED', html: '<p>Add a test</p>' }],
  checks: [],
  files: [{ name: 'a.js', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }, { name: 'big.bin', tooBig: true, additions: 0, deletions: 0 }],
  filesCut: 1,
  ...over,
})

test('PR: header, three tabs, Conversation first; GitHub HTML sanitised', () => {
  const v = render(document, pr(), s)
  assert.equal(v.querySelector('.gh-title').textContent, 'acme/widgets#12 Fix login')
  assert.equal(v.querySelector('.gh-meta .cc-badge').textContent, 'changes requested')
  assert.ok(v.querySelector('.gh-meta .cc-badge').className.includes('amber'))
  const tabs = [...v.querySelectorAll('[data-tab]')].map((b) => [b.getAttribute('data-tab'), b.getAttribute('aria-selected')])
  assert.deepEqual(tabs, [['conversation', 'true'], ['checks', 'false'], ['files', 'false']])
  assert.equal(v.querySelector('[data-pane="checks"]').hidden, true)
  assert.ok(!v.innerHTML.includes('<script'))
  assert.equal(v.querySelector('.gh-body').textContent, 'Fixes login')
  assert.match(v.querySelector('.gh-event').textContent, /alice requested changes/)
})

test('PR with failing CI opens on Checks, with the log tail as text', () => {
  const v = render(document, pr({ checks: [{ name: 'test', conclusion: 'failure', failed: true, url: 'https://github.com/acme/widgets/runs/1', tail: '<b>not html</b>\n##[error]exit 1' }, { name: 'lint', conclusion: 'success', failed: false }] }), s)
  assert.equal(v.querySelector('[data-tab="checks"]').getAttribute('aria-selected'), 'true')
  assert.match(v.querySelector('[data-tab="checks"]').textContent, /✗/)
  const log = v.querySelector('pre.gh-log')
  assert.equal(log.textContent, '<b>not html</b>\n##[error]exit 1')
  assert.equal(log.querySelector('b'), null)
  assert.equal(v.querySelector('.gh-check .gh-link').getAttribute('href'), 'https://github.com/acme/widgets/runs/1')
})

test('Files: diff lines classed, a too-big file and the cut count said', () => {
  const v = render(document, pr(), s)
  const files = v.querySelector('[data-pane="files"]')
  assert.deepEqual([...files.querySelectorAll('pre.gh-diff span')].map((x) => x.className), ['gh-diff-hunk', 'gh-diff-del', 'gh-diff-add'])
  assert.match(files.textContent, /Too large to show here/)
  assert.match(files.textContent, /1 file is too large/)
})

test('issue and run views', () => {
  const i = render(document, { kind: 'issue', title: 'acme/widgets#5 Crash', header: { state: 'open', author: 'bob', assignees: ['me'] }, body: '', timeline: [] }, s)
  assert.match(i.textContent, /No description\./)
  assert.match(i.textContent, /assigned to me/)
  const r = render(
    document,
    { kind: 'run', title: 'acme/widgets CI failed: CI on main', header: { workflow: 'CI', branch: 'main', sha: 'abc', event: 'push', runNumber: 5, attempt: 2, commit: 'Fix login' }, jobs: [{ name: 'test', conclusion: 'failure', failed: true, failedSteps: ['Run npm test'], tailError: 'GitHub answered 410' }] },
    s
  )
  assert.match(r.querySelector('.gh-meta').textContent, /attempt 2/)
  assert.match(r.textContent, /Failed step: Run npm test/)
  assert.match(r.textContent, /Log: GitHub answered 410/)
})
