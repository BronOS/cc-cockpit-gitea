'use strict'
// Fakes shared by the suites: a Gitea or Forgejo server behind a fake fetch (answers from a test's own routes, never
// the network), a cc-cockpit ctx written from `ccc guide api` (adapted from cc-cockpit-github's test/fakes.js), and a
// settable clock. Every name in here is made up: the server is git.example.com.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BASE = 'https://git.example.com'
const TOKEN = 'testTokenNeverReal0123456789abcdef01234567'
const TOKEN2 = 'secondTokenNeverReal9876543210fedcba7654321'
const ME = 'me'
const NOW = Date.parse('2026-11-09T12:00:00Z')

/** What each flavour answers on its version endpoints (strings as the real servers write them). */
const FLAVOURS = {
  'gitea-1.23': { version: '1.23.1' },
  'gitea-1.24': { version: '1.24.0' },
  'gitea-latest': { version: '29.0.0+dev-160-g55186ca39b' },
  'forgejo-17': { version: '17.0.0-99-322c239+gitea-1.22.0', forgejo: '17.0.0-99-322c239' },
}

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })

/**
 * A fake server at `base` (default BASE, a path prefix allowed). `flavour` picks the version answers (FLAVOURS).
 * `routes` is a list of `[method, pathOrRegExp, handler]` matched in order against the path AFTER `<base>/api/v1`
 * (so `'/user'`); a handler gets `(url, init, match)` and returns a Response. `/version`, `/user` and the Forgejo
 * version endpoint answer by default. Requests to any other origin go to `other(url, init, headers)` or throw.
 * `token` is the token the server accepts (`Authorization: token <t>`; another one gets 401). Every request is in
 * `calls` with its auth header, so a test can prove where the token went.
 */
function fakeServer(opts = {}) {
  const calls = []
  const base = new URL(opts.base || BASE)
  const prefix = base.pathname.replace(/\/$/, '')
  const flavour = FLAVOURS[opts.flavour || 'gitea-1.23']
  let accepted = opts.token === undefined ? TOKEN : opts.token
  const login = opts.login || ME
  async function fetch(url, init = {}) {
    const headers = new Headers(init.headers || {})
    const u = new URL(url)
    const method = init.method || 'GET'
    calls.push({ url: String(url), method, auth: headers.get('authorization'), headers, body: init.body, redirect: init.redirect })
    if (u.origin !== base.origin || !u.pathname.startsWith(`${prefix}/`)) {
      if (opts.other) return opts.other(u, init, headers)
      throw new Error(`fake server: unexpected address ${u.origin}${u.pathname}`)
    }
    const p = u.pathname.slice(prefix.length)
    if (p === '/api/forgejo/v1/version') return flavour.forgejo ? json({ version: flavour.forgejo }) : json({ message: 'Not Found' }, 404)
    if (!p.startsWith('/api/v1/')) return text('not an api path', 404)
    const rest = p.slice('/api/v1'.length)
    const route = () => {
      for (const [m, r, handler] of opts.routes || []) {
        if (m !== method) continue
        const match = typeof r === 'string' ? (rest === r ? [r] : null) : rest.match(r)
        // A handler that answers null passes the request on to the next matching route.
        const answer = match && handler(u, init, match)
        if (answer) return answer
      }
      return null
    }
    // /version is public on a real server: a test's own route for it wins, with or without a token.
    if (method === 'GET' && rest === '/version') return route() || json({ version: flavour.version })
    if (headers.get('authorization') !== `token ${accepted}`) return json({ message: 'token is required' }, 401)
    const answered = route()
    if (answered) return answered
    if (method === 'GET' && rest === '/user') return json({ id: 1, login, full_name: 'Me', email: '' })
    if (method === 'GET' && rest === '/user/teams') return json([])
    return json({ message: 'Not Found' }, 404)
  }
  return {
    fetch,
    calls,
    accept(token) {
      accepted = token
    },
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gitea-test-'))
}

/** An in-memory key-value store with the shape of ctx.storage / ctx.appStorage. */
function memStore() {
  const map = new Map()
  return {
    map,
    async get(k) {
      return map.has(k) ? structuredClone(map.get(k)) : undefined
    },
    async set(k, v) {
      map.set(k, structuredClone(v))
    },
    async delete(k) {
      map.delete(k)
    },
    async keys() {
      return [...map.keys()]
    },
    async increment(k, by = 1) {
      const v = (map.get(k) || 0) + by
      map.set(k, v)
      return v
    },
  }
}

/**
 * A ctx good enough for dist/host.js: storage and appStorage in memory (pass `appStorage` to share one between two
 * ctxs, as two windows do), recorded posts, headers, logs, execs, emits, overlays and opened URLs. The project settings
 * default to the fake server and TOKEN; `exec` is recorded only (this plugin runs no program).
 */
function fakeCtx(opts = {}) {
  const panelListeners = []
  const actionListeners = []
  const settingsListeners = []
  const dataDir = opts.dataDir || tmpDir()
  const ctx = {
    api: 1,
    pluginId: 'bronos.gitea',
    projectDir: dataDir,
    dataDir,
    appDataDir: dataDir,
    settings: Object.freeze({ project: opts.project || { serverUrl: BASE, token: TOKEN }, app: {} }),
    posts: [],
    headers: [],
    logs: [],
    execs: [],
    overlays: [],
    buttonProviders: [],
    externals: [],
    provided: {},
    emitted: [],
    storage: memStore(),
    appStorage: opts.appStorage || memStore(),
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    async changeSettings(project) {
      ctx.settings = Object.freeze({ project, app: {} })
      for (const fn of settingsListeners) await fn(ctx.settings)
    },
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    async exec(argv, o) {
      ctx.execs.push({ argv, o })
      if (opts.exec) return opts.exec(argv, o)
      return { code: 1, stdout: '', stderr: 'no exec in this plugin' }
    },
    async openExternal(url) {
      ctx.externals.push(url)
    },
    panels: {
      post: (panel, m) => ctx.posts.push(structuredClone(m)),
      onMessage: (panel, fn) => (panelListeners.push(fn), () => {}),
      header: (panel, h) => ctx.headers.push(structuredClone(h)),
      onAction: (panel, fn) => (actionListeners.push(fn), () => {}),
      show() {},
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(structuredClone(m))
    },
    async clickAction(id) {
      for (const fn of actionListeners) await fn(id)
    },
    overlay: {
      start(spec) {
        if (opts.overlayRefuse) {
          const err = new Error(opts.overlayRefuse)
          return { result: Promise.reject(err), post() {}, onMessage: () => () => {}, onDiscuss: () => () => {}, close() {}, focus() {} }
        }
        const o = { spec, posts: [], listeners: [] }
        ctx.overlays.push(o)
        let close
        const result = new Promise((r) => (close = r))
        o.close = (answer) => close(answer || { kind: 'dismissed' })
        o.send = async (m) => {
          for (const fn of o.listeners) await fn(structuredClone(m))
        }
        return {
          result,
          post: (m) => o.posts.push(structuredClone(m)),
          onMessage: (fn) => (o.listeners.push(fn), () => {}),
          onDiscuss: (fn) => ((o.discuss = fn), () => {}),
          close() {
            o.closed = true
            close({ kind: 'dismissed' })
          },
          focus() {},
        }
      },
      buttons: (name, provider) => (ctx.buttonProviders.push({ name, provider }), () => {}),
    },
    services: {
      provide(name, impl) {
        ctx.provided[name] = impl
        return () => {}
      },
      emit(service, event, data) {
        ctx.emitted.push({ service, event, data: structuredClone(data) })
      },
      caller: () => ctx.callerId,
    },
    callerId: undefined,
    /** Call a provided service method the way another plugin would: arguments and result cloned. */
    async callService(name, method, args = [], as = 'bronos.inbox') {
      const impl = ctx.provided[name]
      if (!impl) throw new Error(`no provider of ${name}`)
      ctx.callerId = as
      try {
        return structuredClone(await impl[method](...structuredClone(args)))
      } finally {
        ctx.callerId = undefined
      }
    },
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  return ctx
}

/** A clock a test moves by hand: `now()` and `advance(ms)`. */
function fakeClock(start = NOW) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
    set(ms) {
      t = ms
    },
  }
}

module.exports = { fakeServer, fakeCtx, fakeClock, memStore, fixture, json, text, tmpDir, BASE, TOKEN, TOKEN2, ME, NOW, FLAVOURS }
