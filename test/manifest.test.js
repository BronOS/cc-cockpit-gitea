'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'))
const props = manifest.contributes.settings.project.properties

test('manifest: id, entry points and the inbox-feed v2 it provides', () => {
  assert.equal(manifest.id, 'bronos.gitea')
  assert.equal(manifest.api, 1)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(fs.existsSync(path.join(root, manifest.main)))
  assert.deepEqual(manifest.services.provides, { 'inbox-feed': 2 })
  const panel = manifest.contributes.panels[0]
  assert.equal(panel.id, 'main')
  assert.ok(fs.existsSync(path.join(root, panel.icon)))
  assert.ok(fs.existsSync(path.join(root, panel.entry)))
  assert.ok(manifest.description.length <= 600)
})

test('settings: defaults as the plan says; every field but the secret has one', () => {
  assert.deepEqual(props.lanes.default, { reviewRequested: true, myPrs: true, issues: true, failedRuns: true })
  assert.equal(props.rowsPerLane.default, 10)
  assert.equal(props.markReadOnOpen.default, true)
  assert.deepEqual(props.exclude.default, [])
  assert.equal(props.pollMinutes.default, 2)
  assert.equal(props.serverUrl.default, '')
  assert.ok(!('ghPath' in props))
  for (const [k, v] of Object.entries(props)) if (k !== 'token') assert.ok('default' in v, `${k} has a default`)
})

test('the token is a secret field the app accepts: top level, string, no default, only the allowed keywords', () => {
  const t = props.token
  assert.equal(t.type, 'string')
  assert.equal(t.format, 'secret')
  assert.ok(!('default' in t))
  for (const k of Object.keys(t)) assert.ok(['type', 'format', 'title', 'description', '$comment'].includes(k), `keyword ${k}`)
})

test('settings: no regex or reference keyword anywhere, and the only secret is the token', () => {
  const secrets = []
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      assert.ok(!['pattern', 'patternProperties', '$ref', '$anchor', '$id', '$dynamicRef'].includes(k), `keyword at ${at}.${k}`)
      if (v === 'secret') secrets.push(at)
      walk(v, `${at}.${k}`)
    }
  }
  walk(manifest.contributes.settings, 'settings')
  assert.deepEqual(secrets, ['settings.project.properties.token'])
})
