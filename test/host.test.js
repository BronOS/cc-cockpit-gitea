'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { hashOf } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, fakeCtx, fakeClock, memStore, json, BASE, TOKEN, TOKEN2, NOW } = require('./fakes')
const { T, issue, pull, worldRoutes } = require('./builders')

const OTHER = 'https://code.example.org/git'
const flush = () => new Promise((r) => setImmediate(r))
const noTimers = { set: () => 0, clear() {} }
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush()
}

/** Boot the host against one fake server (or `opts.fetch`); `world` as in builders.worldRoutes. */
async function boot(world, opts = {}) {
  const srv = fakeServer({ flavour: opts.flavour, routes: [...(opts.routes || []), ...worldRoutes(world)] })
  const ctx = fakeCtx({ appStorage: opts.appStorage, project: opts.project })
  const clock = fakeClock()
  const h = host._start(ctx, { fetch: opts.fetch || srv.fetch, now: clock.now, timers: noTimers })
  await h.ready
  await settle()
  return { srv, ctx, clock, h }
}
const snapshot = (ctx) => ctx.callService('inbox-feed', 'snapshot')

test('start: provides inbox-feed, polls, seeds read marks, posts lanes to the panel, sets the header', async () => {
  const { ctx, h } = await boot({ search: { myPrs: [issue(1), issue(2)] } })
  assert.ok(ctx.provided['inbox-feed'])
  const s = await snapshot(ctx)
  assert.equal(s.state, 'ok')
  assert.deepEqual(s.items.map((i) => [i.id, i.read]).sort(), [['pr:acme/widgets#1', true], ['pr:acme/widgets#2', true]])
  const st = ctx.lastState()
  assert.equal(st.login, 'me')
  assert.equal(st.server, BASE)
  assert.equal(st.hostName, 'Gitea')
  assert.equal(st.rows.length, 2)
  assert.equal(st.rows[0].url, undefined)
  assert.ok(st.rows[0].actions.some((a) => a.label === 'Open on Gitea'))
  assert.equal(ctx.headers.at(-1).meta, 'me · git.example.com')
  assert.equal(ctx.headers.at(-1).actions[0].id, 'refresh')
  assert.equal(h.login, 'me')
  assert.ok(ctx.logs.some(([, m]) => m === 'gitea: poll ok as me on Gitea 1.23.1: 2 PRs/issues, 0 failed runs, 0 unread'))
})

test('a Forgejo says so in the labels and describe()', async () => {
  const { ctx } = await boot({ search: { myPrs: [issue(1)] } }, { flavour: 'forgejo-17' })
  assert.equal((await ctx.callService('inbox-feed', 'describe')).label, 'Forgejo')
  assert.ok((await snapshot(ctx)).items[0].actions.some((a) => a.label === 'Done on Forgejo'))
})

test('panel: hello answers the state; act runs through the feed; a refusal comes back as a notice', async () => {
  const { ctx } = await boot({ search: { myPrs: [issue(1)] } })
  ctx.posts.length = 0
  await ctx.sendPanel({ type: 'hello' })
  assert.equal(ctx.posts[0].type, 'state')
  await ctx.sendPanel({ type: 'act', id: 'pr:acme/widgets#1', action: 'markUnread' })
  assert.equal(ctx.lastState().rows[0].read, false)
  await ctx.sendPanel({ type: 'act', id: 'pr:acme/nope#1', action: 'markRead' })
  assert.equal(ctx.posts.at(-1).type, 'notice')
})

test('Open on the server opens only an address under the configured base', async () => {
  const { ctx } = await boot({ search: { myPrs: [issue(1)] } })
  assert.deepEqual(await ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'openWeb']), { ok: true })
  assert.deepEqual(ctx.externals, [`${BASE}/acme/widgets/pulls/1`])
  const server = parseServer(`${BASE}/git`).server
  assert.equal(host._webUrl({ _: { url: `${BASE}/git/a/b/pulls/1` } }, server), `${BASE}/git/a/b/pulls/1`)
  assert.equal(host._webUrl({ _: { url: `${BASE}/gitx/a/b` } }, server), null)
  assert.equal(host._webUrl({ _: { url: `${BASE}/a/b` } }, server), null)
  assert.equal(host._webUrl({ _: { url: 'https://evil.example/git/a' } }, server), null)
  assert.equal(host._webUrl({ _: { url: 'javascript:alert(1)' } }, server), null)
  assert.equal(host._webUrl({ _: { url: `${BASE}/git/a` } }, null), null)
})

test('done hides the item, tells Inbox gone, survives the next poll, marks the server notification read', async () => {
  let patched = 0
  const routes = [
    ['GET', '/repos/acme/widgets/notifications', () => json([{ id: 4, subject: { url: `${BASE}/api/v1/repos/acme/widgets/pulls/1` } }])],
    ['PATCH', '/notifications/threads/4', () => (patched++, new Response(null, { status: 205 }))],
  ]
  const { ctx, h } = await boot({ search: { myPrs: [issue(1), issue(2)] } }, { routes })
  ctx.emitted.length = 0
  await ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'done'])
  assert.deepEqual(ctx.emitted.map((e) => [e.event, e.data.ids]), [['gone', ['pr:acme/widgets#1']]])
  await h.pollOnce()
  assert.deepEqual((await snapshot(ctx)).items.map((i) => i.id), ['pr:acme/widgets#2'])
  await settle()
  assert.equal(patched, 1)
})

test('a lane switched off: not searched, its items gone', async () => {
  const { srv, ctx, h } = await boot({ search: { myPrs: [issue(1)] } })
  ctx.emitted.length = 0
  srv.calls.length = 0
  await ctx.changeSettings({ serverUrl: BASE, token: TOKEN, lanes: { myPrs: false } })
  await settle()
  await h.pollOnce()
  const searches = srv.calls.filter((c) => c.url.includes('/repos/issues/search')).map((c) => new URL(c.url).searchParams)
  assert.ok(searches.length > 0)
  assert.ok(!searches.some((q) => q.get('created') === 'true'))
  assert.ok(ctx.emitted.some((e) => e.event === 'gone' && e.data.ids.includes('pr:acme/widgets#1')))
})

test('failed runs: on the first poll, at most every 5 minutes, linked to the failing own PR; runs API learned', async () => {
  const world = {
    search: { myPrs: [issue(3)] },
    pulls: { 'acme/widgets#3': { pull: pull(3, { sha: 'shaX', headRef: 'b3' }) } },
    status: { shaX: 'failure' },
    tasks: { 'acme/widgets': [{ id: 70, run_number: 5, name: 'test', workflow_id: 'ci.yml', status: 'failure', head_sha: 'shaX', head_branch: 'b3', created_at: T(10), updated_at: T(10), url: `${BASE}/acme/widgets/actions/runs/5` }] },
    runsApi: true,
  }
  const { srv, clock, ctx, h } = await boot(world, { flavour: 'gitea-latest' })
  const snap = await snapshot(ctx)
  assert.deepEqual(snap.items.map((i) => i.id).sort(), ['pr:acme/widgets#3', 'run:acme/widgets/5'])
  assert.equal(h.probe.current.features.runsApi, true)
  assert.ok(snap.items.find((i) => i.id === 'pr:acme/widgets#3').actions.some((a) => a.id === 'rerun'), 'a server with re-run')
  const taskCalls = () => srv.calls.filter((c) => c.url.includes('/actions/tasks')).length
  const before = taskCalls()
  clock.advance(2 * 60_000)
  await h.pollOnce()
  assert.equal(taskCalls(), before)
  clock.advance(3 * 60_000)
  await h.pollOnce()
  assert.ok(taskCalls() > before)
})

test('Gitea 1.23: runs from tasks, no re-run offered, runs API learned as missing', async () => {
  const world = {
    search: { myPrs: [issue(3)] },
    pulls: { 'acme/widgets#3': { pull: pull(3, { sha: 'shaX' }) } },
    status: { shaX: 'failure' },
    tasks: { 'acme/widgets': [{ id: 70, run_number: 5, name: 'test', workflow_id: 'ci.yml', status: 'failure', head_sha: 'shaX', head_branch: 'b3', created_at: T(10), updated_at: T(10) }] },
  }
  const { ctx, h } = await boot(world)
  const snap = await snapshot(ctx)
  assert.ok(snap.items.some((i) => i.id === 'run:acme/widgets/5'))
  assert.ok(!snap.items.some((i) => i.actions.some((a) => a.id === 'rerun')))
  assert.equal(h.probe.current.features.runsApi, false)
})

for (const [name, project, reason, re] of [
  ['no server address', { token: TOKEN }, 'noServer', /server address/],
  ['an http server address', { serverUrl: 'http://git.example.com', token: TOKEN }, 'noServer', /https/],
  ['no token', { serverUrl: BASE }, 'noToken', /access token/],
]) {
  test(`signed out: ${name}; no request made`, async () => {
    const { srv, ctx } = await boot({}, { project })
    const s = await snapshot(ctx)
    assert.equal(s.state, 'signedOut')
    assert.match(s.message, re)
    assert.equal(ctx.lastState().reason, reason)
    assert.ok(ctx.headers.at(-1).meta.includes('signed out'))
    assert.equal(srv.calls.length, 0)
  })
}

test('signed out: a refused token', async () => {
  const { ctx } = await boot({}, { project: { serverUrl: BASE, token: TOKEN2 } })
  const s = await snapshot(ctx)
  assert.equal(s.state, 'signedOut')
  assert.match(s.message, /refused the access token/)
  assert.equal(ctx.lastState().reason, 'refused')
})

test('signed out: a token bound to another server, until the person rebinds it', async () => {
  const appStorage = memStore()
  await appStorage.set('tokens', { [hashOf(TOKEN)]: OTHER })
  const { srv, ctx } = await boot({ search: { myPrs: [issue(1)] } }, { appStorage })
  const s = await snapshot(ctx)
  assert.equal(s.state, 'signedOut')
  assert.match(s.message, /belongs to https:\/\/code\.example\.org\/git/)
  assert.deepEqual([ctx.lastState().reason, ctx.lastState().boundTo], ['bound', OTHER])
  assert.equal(srv.calls.length, 0, 'not a single request with the token')
  await ctx.sendPanel({ type: 'rebind' })
  await settle()
  assert.equal((await snapshot(ctx)).state, 'ok')
  assert.equal((await appStorage.get('tokens'))[hashOf(TOKEN)], BASE)
  assert.equal(ctx.lastState().boundTo, '')
})

test('rebind does nothing unless the token is refused for being bound elsewhere', async () => {
  const appStorage = memStore()
  const { ctx } = await boot({}, { appStorage })
  await ctx.sendPanel({ type: 'rebind' })
  assert.equal((await appStorage.get('tokens'))[hashOf(TOKEN)], BASE)
  assert.ok(!ctx.logs.some(([, m]) => /now used for/.test(m)))
})

test('restart: the stored list answers at once as stale; read marks shared through appStorage', async () => {
  const shared = memStore()
  const first = await boot({ search: { myPrs: [issue(1)] } }, { appStorage: shared })
  await first.ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'markUnread'])
  first.h.stop()
  const ctx = fakeCtx({ appStorage: shared })
  const h = host._start(ctx, { fetch: async () => Promise.reject(new TypeError('offline')), now: () => NOW, timers: noTimers })
  await h.ready
  await settle()
  const s = await snapshot(ctx)
  assert.equal(s.state, 'error')
  assert.deepEqual(s.items.map((i) => [i.id, i.read]), [['pr:acme/widgets#1', false]])
  h.stop()
})

test('a server switch keeps the lists apart; switching back restores the first one', async () => {
  const shared = memStore()
  const a = fakeServer({ routes: worldRoutes({ search: { myPrs: [issue(1)] } }) })
  const b = fakeServer({ base: OTHER, flavour: 'forgejo-17', token: TOKEN2, routes: worldRoutes({ search: { myPrs: [issue(7, { repo: 'team/app' })] } }) })
  const fetch = (url, init) => (String(url).startsWith(OTHER) ? b.fetch(url, init) : a.fetch(url, init))
  const { ctx, h } = await boot({}, { appStorage: shared, fetch })
  assert.deepEqual((await snapshot(ctx)).items.map((i) => i.id), ['pr:acme/widgets#1'])
  await ctx.changeSettings({ serverUrl: OTHER, token: TOKEN2 })
  await settle()
  assert.deepEqual((await snapshot(ctx)).items.map((i) => i.id), ['pr:team/app#7'])
  assert.equal(ctx.lastState().hostName, 'Forgejo')
  assert.ok(!b.calls.some((c) => c.auth === `token ${TOKEN}`), 'the first token never went to the second server')
  // Back: the first server's list is restored before its poll answers.
  ctx.emitted.length = 0
  await ctx.changeSettings({ serverUrl: BASE, token: TOKEN })
  assert.deepEqual(h.feed.items.map((i) => i.id), ['pr:acme/widgets#1'])
  await settle()
  assert.equal((await snapshot(ctx)).state, 'ok')
  assert.ok([...shared.map.keys()].includes(`list:${BASE}/me`) && [...shared.map.keys()].includes(`list:${OTHER}/me`))
  assert.ok([...shared.map.keys()].includes(`seen:${BASE}/me`) && [...shared.map.keys()].includes(`seen:${OTHER}/me`))
})

test('two hosts on two servers with one appStorage stay apart', async () => {
  const shared = memStore()
  const one = await boot({ search: { myPrs: [issue(1)] } }, { appStorage: shared })
  const b = fakeServer({ base: OTHER, token: TOKEN2, routes: worldRoutes({ search: { myPrs: [issue(9, { repo: 'team/app' })] } }) })
  const two = await boot({}, { appStorage: shared, fetch: b.fetch, project: { serverUrl: OTHER, token: TOKEN2 } })
  await one.h.pollOnce()
  assert.deepEqual((await snapshot(one.ctx)).items.map((i) => i.id), ['pr:acme/widgets#1'])
  assert.deepEqual((await snapshot(two.ctx)).items.map((i) => i.id), ['pr:team/app#9'])
})

test('the token never reaches storage, posts, emits, headers, logs or overlays; its hash only in tokens', async () => {
  const shared = memStore()
  const routes = [['GET', '/repos/acme/widgets/pulls/1', () => json({ number: 1, state: 'open', body: '', head: { ref: 'b1', sha: 'abc1234' }, base: { ref: 'main' } })]]
  const { ctx } = await boot({ search: { myPrs: [issue(1)] } }, { appStorage: shared, routes })
  await ctx.sendPanel({ type: 'hello' })
  await ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'open'])
  await settle()
  const overlays = ctx.overlays.map((o) => [o.spec, o.posts, o.discuss && o.discuss()])
  assert.ok(overlays.length)
  const all = JSON.stringify([[...shared.map.entries()], [...ctx.storage.map.entries()], ctx.posts, ctx.emitted, ctx.headers, ctx.logs, overlays])
  assert.ok(!all.includes(TOKEN))
  assert.deepEqual(Object.keys(await shared.get('tokens')), [hashOf(TOKEN)])
})

test('a rate limit keeps the last list and reports the time', async () => {
  let limited = false
  const slow = () => (limited ? json({ message: 'slow down' }, 429, { 'retry-after': '600' }) : null)
  const { ctx, h } = await boot({ search: { myPrs: [issue(1)] } }, { routes: [['GET', '/repos/issues/search', slow]] })
  limited = true
  const r = await h.pollOnce()
  assert.equal(r.until, NOW + 600_000)
  const s = await snapshot(ctx)
  assert.equal(s.state, 'error')
  assert.match(s.message, /wait/)
  assert.deepEqual(s.items.map((i) => i.id), ['pr:acme/widgets#1'])
})

test('the header Refresh action polls again', async () => {
  const { srv, ctx } = await boot({ search: { myPrs: [issue(1)] } })
  const before = srv.calls.filter((c) => c.url.includes('/repos/issues/search')).length
  await ctx.clickAction('refresh')
  await settle()
  assert.ok(srv.calls.filter((c) => c.url.includes('/repos/issues/search')).length > before)
})

test('storable trims the oldest items until the list fits', () => {
  const big = Array.from({ length: 3000 }, (_, i) => ({ id: `i${i}`, time: i, title: 'x'.repeat(400), _: {} }))
  const s = host._storable({ items: big, asOf: 1 })
  assert.ok(JSON.stringify(s).length <= 900 * 1024)
  assert.equal(s.items[0].id, 'i2999')
})

test('Open: the overlay opens, gets the details from the server and offers its buttons', async () => {
  const routes = [
    ['GET', '/repos/acme/widgets/pulls/1', () => json({ number: 1, state: 'open', body: '', head: { ref: 'b1', sha: 'abc1234' }, base: { ref: 'main' }, user: { login: 'me' } })],
    ['GET', '/repos/acme/widgets/pulls/1/files', () => json([])],
    ['GET', '/repos/acme/widgets/pulls/1.diff', () => new Response('', { status: 200 })],
  ]
  const { ctx } = await boot({ search: { myPrs: [issue(1)] } }, { routes })
  assert.deepEqual(await ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'open']), { ok: true })
  assert.equal(ctx.overlays.length, 1)
  assert.deepEqual(ctx.overlays[0].spec.type, { name: 'inbox-item', data: { source: 'bronos.gitea', id: 'pr:acme/widgets#1' } })
  await settle()
  const posted = ctx.overlays[0].posts.find((m) => m.type === 'details')
  assert.ok(posted, JSON.stringify(ctx.overlays[0].posts))
  assert.equal(posted.details.host, 'Gitea')
  const buttons = ctx.buttonProviders[0].provider({ type: ctx.overlays[0].spec.type, opener: 'bronos.gitea' })
  assert.equal(buttons[0].label, 'Open on Gitea')
})
