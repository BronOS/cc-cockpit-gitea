'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient, createBinding, HttpError, checkPath, hashOf } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, fakeClock, memStore, json, text, BASE, TOKEN, TOKEN2 } = require('./fakes')

const quiet = { info() {}, warn() {}, error() {} }

function setup(opts = {}) {
  const srv = fakeServer(opts)
  const store = opts.store || memStore()
  const clock = fakeClock()
  const server = parseServer(opts.base || BASE).server
  const client = createClient({ fetch: srv.fetch, server, token: opts.clientToken || TOKEN, binding: createBinding({ store, log: quiet }), now: clock.now, log: quiet })
  return { srv, store, clock, client, server }
}

test('requests go to <base>/api/v1 with the token header and never follow a redirect', async () => {
  const { srv, client } = setup({ routes: [['GET', '/repos/acme/widgets', () => json({ full_name: 'acme/widgets' })]] })
  const { data } = await client.rest('GET', '/repos/acme/widgets', { query: { a: 1, skip: undefined, t: ['pull', 'issue'] } })
  assert.equal(data.full_name, 'acme/widgets')
  const c = srv.calls.at(-1)
  assert.equal(c.url, `${BASE}/api/v1/repos/acme/widgets?a=1&t=pull&t=issue`)
  assert.equal(c.auth, `token ${TOKEN}`)
  assert.equal(c.redirect, 'manual')
})

test('a path prefix is kept, for the API and for the Forgejo version', async () => {
  const { srv, client } = setup({ base: 'https://example.com/git', flavour: 'forgejo-17' })
  assert.equal((await client.user()).login, 'me')
  assert.equal(srv.calls.at(-1).url, 'https://example.com/git/api/v1/user')
  assert.equal(await client.forgejoVersion(), '17.0.0-99-322c239')
  assert.equal(srv.calls.at(-1).url, 'https://example.com/git/api/forgejo/v1/version')
})

test('forgejoVersion is null on a Gitea', async () => {
  const { client } = setup({ flavour: 'gitea-1.23' })
  assert.equal(await client.forgejoVersion(), null)
})

test('a redirect is an error and the token is not sent on', async () => {
  const { srv, client } = setup({ routes: [['GET', '/user', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })]] })
  await assert.rejects(client.rest('GET', '/user'), (e) => e instanceof HttpError && e.status === 302)
  assert.ok(srv.calls.every((c) => c.url.startsWith(BASE)))
})

test('paths are checked before they are joined', async () => {
  const { client } = setup()
  for (const bad of ['../x', '/a/../b', '/a//b', '/a%2e%2e', 'https://evil.example/x', '/a?b=1', '/a\\b']) {
    await assert.rejects(client.rest('GET', bad), /refused API path/, bad)
  }
  assert.equal(checkPath('/repos/acme/my_repo.x/issues/5'), '/repos/acme/my_repo.x/issues/5')
})

test('pages follows Link next only under this server, up to the cap', async () => {
  let n = 0
  const { srv, client } = setup({
    routes: [
      ['GET', '/repos/issues/search', (u) => {
        n++
        const page = Number(u.searchParams.get('page') || 1)
        const next = page === 1 ? `<${BASE}/api/v1/repos/issues/search?page=2&limit=50>; rel="next"` : page === 2 ? '<https://evil.example/api/v1/x?page=3>; rel="next"' : ''
        return json([{ id: page }], 200, next ? { link: next } : {})
      }],
    ],
  })
  const all = await client.pages('/repos/issues/search', { query: { type: 'pulls' } })
  assert.deepEqual(all.map((x) => x.id), [1, 2])
  assert.equal(n, 2)
  assert.match(srv.calls[0].url, /limit=50/)
  assert.ok(srv.calls.every((c) => c.url.startsWith(BASE)))
})

test('401 is signed out (refused); a rate limit blocks every call until it passes', async () => {
  const { client } = setup({ token: TOKEN2 })
  await assert.rejects(client.rest('GET', '/user'), (e) => e.signedOut && e.reason === 'refused' && /refused the access token/.test(e.message))
  let limited = true
  const r = setup({ routes: [['GET', '/user', () => (limited ? json({ message: 'slow down' }, 429, { 'retry-after': '120' }) : json({ login: 'me' }))]] })
  await assert.rejects(r.client.rest('GET', '/user'), (e) => e.rateLimited && e.until === r.clock.now() + 120_000)
  limited = false
  const before = r.srv.calls.length
  await assert.rejects(r.client.rest('GET', '/user'), (e) => e.rateLimited)
  assert.equal(r.srv.calls.length, before)
  r.clock.advance(121_000)
  assert.equal((await r.client.rest('GET', '/user')).data.login, 'me')
})

test('a 403 without Retry-After is an ordinary HttpError; errors carry the server message', async () => {
  const { client } = setup({ routes: [['GET', '/repos/acme/x/actions/tasks', () => json({ message: 'Actions disabled' }, 403)]] })
  await assert.rejects(client.rest('GET', '/repos/acme/x/actions/tasks'), (e) => e instanceof HttpError && e.status === 403 && /Actions disabled/.test(e.message))
})

test('network failure and timeout are NetworkError', async () => {
  const server = parseServer(BASE).server
  const client = createClient({ fetch: async () => Promise.reject(new TypeError('offline')), server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), log: quiet })
  await assert.rejects(client.rest('GET', '/user'), (e) => e.network)
})

test('an unreachable server says why: unknown name, refused, bad certificate, other', async () => {
  const server = parseServer(BASE).server
  const host = new URL(BASE).host
  const failing = (code) => {
    const e = new TypeError('fetch failed')
    e.cause = Object.assign(new Error(code), { code })
    return createClient({ fetch: async () => Promise.reject(e), server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), log: quiet })
  }
  const msg = async (code) => client_msg(failing(code))
  const client_msg = async (c) => {
    try {
      await c.rest('GET', '/user')
    } catch (e) {
      assert.ok(e.network)
      return e.message
    }
    assert.fail('no error')
  }
  assert.equal(await msg('ENOTFOUND'), `Could not find ${host}: check the server address in Settings`)
  assert.match(await msg('ECONNREFUSED'), /refused the connection/)
  assert.match(await msg('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), /certificate was not accepted \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/)
  assert.equal(await msg('ECONNRESET'), `Could not reach ${host} (ECONNRESET)`)
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
  const slow = createClient({ fetch: async () => Promise.reject(timeout), server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), log: quiet })
  assert.equal(await client_msg(slow), 'The server did not answer in time')
})

test('JSON over the cap is refused; raw is cut and flagged', async () => {
  const big = 'x'.repeat(2000)
  const { client } = setup({ routes: [['GET', '/big', () => json({ big })], ['GET', '/raw', () => text(big)]] })
  await assert.rejects(client.rest('GET', '/big', { maxBytes: 100 }), /more than the plugin reads/)
  const r = await client.rest('GET', '/raw', { raw: true, maxBytes: 100 })
  assert.equal(r.data.length, 100)
  assert.equal(r.truncated, true)
})

test('token binding: the first sign-in binds the token to this server; another server is refused before any request', async () => {
  const store = memStore()
  const a = setup({ store })
  await a.client.user()
  assert.deepEqual(await store.get('tokens'), { [hashOf(TOKEN)]: BASE })
  assert.ok(!JSON.stringify(await store.get('tokens')).includes(TOKEN))
  // A project overriding only the URL: same (global) token, another server.
  const b = setup({ store, base: 'https://other.example.org' })
  await assert.rejects(b.client.user(), (e) => e.signedOut && e.reason === 'bound' && e.boundTo === BASE && /belongs to https:\/\/git.example.com/.test(e.message))
  assert.equal(b.srv.calls.length, 0, 'the token never reached the other server')
  await assert.rejects(b.client.rest('GET', '/repos/acme/x'), (e) => e.reason === 'bound')
  assert.equal(b.srv.calls.length, 0)
})

test('token binding: two servers on one host under different prefixes are different servers', async () => {
  const store = memStore()
  await setup({ store, base: 'https://example.com/one' }).client.user()
  const two = setup({ store, base: 'https://example.com/two' })
  await assert.rejects(two.client.user(), (e) => e.reason === 'bound')
})

test('token binding: rebind is the person moving the token; another token is free', async () => {
  const store = memStore()
  const binding = createBinding({ store, log: quiet })
  await binding.bind(TOKEN, BASE)
  assert.deepEqual(await binding.check(TOKEN, 'https://new.example.com'), { ok: false, boundTo: BASE })
  await binding.rebind(TOKEN, 'https://new.example.com')
  assert.deepEqual(await binding.check(TOKEN, 'https://new.example.com'), { ok: true })
  assert.deepEqual(await binding.check(TOKEN, BASE), { ok: false, boundTo: 'https://new.example.com' })
  assert.deepEqual(await binding.check(TOKEN2, BASE), { ok: true })
  assert.equal(await binding.bind(TOKEN, BASE), false)
})

test('token binding: at most 50 tokens remembered', async () => {
  const store = memStore()
  const binding = createBinding({ store, log: quiet })
  for (let i = 0; i < 60; i++) await binding.bind(`t${i}`, BASE)
  assert.equal(Object.keys(await store.get('tokens')).length, 50)
})

test('tail: the last bytes of a log; a server ignoring Range is read as a stream; the read is capped', async () => {
  const log = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
  const { client } = setup({ routes: [['GET', '/repos/acme/widgets/actions/jobs/7/logs', () => text(log)]] })
  const r = await client.tail('/repos/acme/widgets/actions/jobs/7/logs', { keep: 100 })
  assert.equal(r.text, log.slice(-100))
  assert.equal(r.truncated, true)
})

test('tail: a redirect is followed once, https only, without the token', async () => {
  const blobs = []
  const { srv, client } = setup({
    routes: [
      ['GET', '/repos/acme/widgets/actions/jobs/7/logs', () => new Response(null, { status: 302, headers: { location: 'https://store.example.net/logs/7?sig=abc' } })],
      ['GET', '/repos/acme/widgets/actions/jobs/8/logs', () => new Response(null, { status: 302, headers: { location: 'http://store.example.net/logs/8' } })],
    ],
    other: async (u, init, headers) => {
      blobs.push({ url: String(u), auth: headers.get('authorization') })
      return text('the end')
    },
  })
  assert.equal((await client.tail('/repos/acme/widgets/actions/jobs/7/logs')).text, 'the end')
  assert.deepEqual(blobs, [{ url: 'https://store.example.net/logs/7?sig=abc', auth: null }])
  await assert.rejects(client.tail('/repos/acme/widgets/actions/jobs/8/logs'), /non-https/)
  assert.ok(srv.calls.filter((c) => c.auth).every((c) => c.url.startsWith(BASE)))
})
