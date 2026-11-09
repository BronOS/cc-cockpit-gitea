'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createProbe, parseVersion, infoOf, TTL } = require('../dist/lib/probe')
const { createClient, createBinding } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, fakeClock, memStore, json, BASE, TOKEN } = require('./fakes')

function setup(opts = {}) {
  const logs = []
  const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error() {} }
  const srv = fakeServer(opts)
  const clock = fakeClock()
  const client = createClient({ fetch: srv.fetch, server: parseServer(BASE).server, token: TOKEN, binding: createBinding({ store: memStore(), log }), now: clock.now, log })
  return { srv, clock, client, probe: createProbe({ now: clock.now, log }), logs }
}

const runsRoute = (status) => ['GET', '/repos/acme/widgets/actions/runs', () => (status === 200 ? json({ workflow_runs: [], total_count: 0 }) : json({ message: 'Not Found' }, status))]

test('version strings: numbers compared, Forgejo never read as Gitea, junk is null', () => {
  assert.deepEqual(parseVersion('1.23.1'), [1, 23, 1])
  assert.deepEqual(parseVersion('29.0.0+dev-160-g55186ca39b'), [29, 0, 0])
  assert.deepEqual(parseVersion('17.0.0-99-322c239+gitea-1.22.0'), [17, 0, 0])
  for (const junk of ['', 'dev', null, 7, 'x1.2.3']) assert.equal(parseVersion(junk), null)
  assert.equal(infoOf('gitea', '1.25.9', true).features.rerun, false)
  assert.equal(infoOf('gitea', '1.26.0', true).features.rerun, true)
  assert.equal(infoOf('gitea', '29.0.0+dev-1', true).features.rerun, true)
  assert.equal(infoOf('forgejo', '16.2.0', true).features.rerun, false)
  assert.equal(infoOf('forgejo', '17.0.0-99-322c239', true).features.rerun, true)
})

test('Gitea 1.23: flavour gitea, runs API unknown until learned, then off when the runs list 404s', async () => {
  const { client, probe } = setup({ flavour: 'gitea-1.23', routes: [runsRoute(404)] })
  const info = await probe.get(client)
  assert.equal(info.flavour, 'gitea')
  assert.equal(info.hostName, 'Gitea')
  assert.deepEqual(info.version, [1, 23, 1])
  assert.deepEqual(info.features, { runsApi: null, jobLogs: false, rerun: false })
  const after = await probe.learnRuns(client, 'acme/widgets')
  assert.deepEqual(after.features, { runsApi: false, jobLogs: false, rerun: false })
})

test('current Gitea: runs API learned on, job logs and rerun on', async () => {
  const { client, probe } = setup({ flavour: 'gitea-latest', routes: [runsRoute(200)] })
  await probe.get(client)
  const info = await probe.learnRuns(client, 'acme/widgets')
  assert.deepEqual(info.features, { runsApi: true, jobLogs: true, rerun: true })
})

test('Forgejo 17: flavour from its own endpoint, host name Forgejo, rerun on with the runs API', async () => {
  const { client, probe } = setup({ flavour: 'forgejo-17', routes: [runsRoute(200)] })
  const info = await probe.get(client)
  assert.equal(info.flavour, 'forgejo')
  assert.equal(info.hostName, 'Forgejo')
  assert.deepEqual(info.version, [17, 0, 0])
  assert.deepEqual((await probe.learnRuns(client, 'acme/widgets')).features, { runsApi: true, jobLogs: true, rerun: true })
})

test('a Forgejo whose own version endpoint fails is still told from its /version text', async () => {
  const { client, probe } = setup({ flavour: 'gitea-1.23', routes: [['GET', '/version', () => json({ version: '16.1.0+gitea-1.22.0' })]] })
  const info = await probe.get(client)
  assert.equal(info.flavour, 'forgejo')
  assert.deepEqual(info.version, [16, 1, 0])
})

test('cached for 6 hours per server; reset drops it', async () => {
  const { srv, clock, client, probe } = setup()
  await probe.get(client)
  const n = srv.calls.length
  await probe.get(client)
  assert.equal(srv.calls.length, n)
  clock.advance(TTL)
  await probe.get(client)
  assert.ok(srv.calls.length > n)
  const m = srv.calls.length
  probe.reset()
  assert.equal(probe.current, null)
  await probe.get(client)
  assert.ok(srv.calls.length > m)
})

test('a version that cannot be read: every optional feature off, logged once, the poll goes on', async () => {
  const { client, probe, logs } = setup({ routes: [['GET', '/version', () => json({ message: 'boom' }, 500)], runsRoute(200)] })
  const info = await probe.get(client)
  assert.deepEqual(info.features, { runsApi: false, jobLogs: false, rerun: false })
  assert.equal((await probe.learnRuns(client, 'acme/widgets')).features.runsApi, false)
  assert.equal(logs.filter((l) => l[0] === 'warn').length, 1)
})

test('learnRuns: an error other than 404 leaves it unknown; a sign-out propagates', async () => {
  const { client, probe } = setup({ flavour: 'gitea-latest', routes: [['GET', '/repos/acme/widgets/actions/runs', () => json({ message: 'boom' }, 500)]] })
  await probe.get(client)
  assert.equal((await probe.learnRuns(client, 'acme/widgets')).features.runsApi, null)
})
