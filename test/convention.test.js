'use strict'
// Convention drift: every label and action id this plugin produces is in the shared code-host convention
// (cc-cockpit-github docs/item-convention.md, copied in test/fixtures/convention-ids.json) and in the README, so one
// set of Inbox rules covers GitHub and Gitea / Forgejo.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { labelsFor } = require('../dist/lib/feed')

const root = path.join(__dirname, '..')
const conv = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/convention-ids.json'), 'utf8'))
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

/** The fixed labels a source file pushes: string literals in `labels.push(...)` / `labels = [...]` (both arms of a `?:` inside one). */
function labelsIn(file) {
  const src = fs.readFileSync(path.join(root, 'dist/lib', file), 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/labels(?:\.push\(|\s*=\s*\[)([^)\]]*)/g)) for (const s of m[1].matchAll(/'([a-z:-]+)'/g)) out.add(s[1])
  return out
}

test('every fixed label in model.js and runs.js is in the convention and the README', () => {
  const labels = new Set([...labelsIn('model.js'), ...labelsIn('runs.js')])
  assert.ok(labels.size >= 12, [...labels].join(' '))
  for (const l of labels) {
    assert.ok(conv.labels.includes(l), `convention lacks ${l}`)
    assert.ok(readme.includes(`\`${l}\``), `README lacks ${l}`)
  }
  for (const l of conv.labels) assert.ok(readme.includes(`\`${l}\``), `README lacks ${l}`)
})

test('the repo: and owner: prefixes are the ones the model writes', () => {
  const src = fs.readFileSync(path.join(root, 'dist/lib/model.js'), 'utf8') + fs.readFileSync(path.join(root, 'dist/lib/runs.js'), 'utf8')
  for (const p of conv.labelPrefixes) assert.ok(src.includes(`\`${p}\${`), p)
})

test('every action id is in the convention', () => {
  for (const id of Object.keys(labelsFor('Gitea'))) assert.ok(conv.actions.includes(id), `convention lacks action ${id}`)
  assert.deepEqual(Object.keys(labelsFor('Forgejo')).sort(), [...conv.actions].sort())
})
