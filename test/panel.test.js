'use strict'
// panels/main.js in a DOM (linkedom): the signed-out banners the host's `reason` asks for, and the rebind button.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parseHTML } = require('linkedom')
const rows = require('../panels/rowlogic')

function load() {
  const html = fs.readFileSync(path.join(__dirname, '../panels/main.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '')
  const { window, document } = parseHTML(html)
  const posts = []
  let listener = null
  const intervals = []
  const sandbox = {
    document,
    window,
    ghRows: rows,
    ccPanel: { post: (m) => posts.push(m), onMessage: (fn) => (listener = fn) },
    setInterval: (fn) => intervals.push(fn),
    setTimeout: () => 0,
    clearTimeout() {},
    Date,
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../panels/main.js'), 'utf8'), sandbox)
  return { document, posts, send: (m) => listener(m) }
}

const base = { type: 'state', lanes: { reviewRequested: true, myPrs: true, issues: true, failedRuns: true }, rowsPerLane: 10, rows: [], asOf: 0 }

test('the page says hello, then a Settings hint for a missing token', () => {
  const p = load()
  assert.equal(JSON.stringify(p.posts), '[{"type":"hello"}]')
  p.send({ ...base, state: 'signedOut', reason: 'noToken', message: 'Set an access token in Settings, then Refresh.' })
  const banner = p.document.getElementById('banner')
  assert.equal(banner.hidden, false)
  assert.deepEqual([...banner.querySelectorAll('p')].map((e) => e.textContent), ['Set an access token in Settings, then Refresh.', 'The gear in this panel’s header opens Settings.'])
  assert.equal(banner.querySelector('button'), null)
})

test('a token bound elsewhere: the rebind button posts rebind once', () => {
  const p = load()
  p.send({ ...base, state: 'signedOut', reason: 'bound', boundTo: 'https://code.example.org', server: 'https://git.example.com', message: 'This access token belongs to https://code.example.org' })
  const btn = p.document.getElementById('banner').querySelector('button')
  assert.equal(btn.textContent, 'Use this token for https://git.example.com')
  btn.click()
  btn.click()
  assert.equal(p.posts.filter((m) => m.type === 'rebind').length, 1)
  p.send({ ...base, state: 'ok' })
  assert.equal(p.document.getElementById('banner').hidden, true)
})
