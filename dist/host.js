'use strict'
// bronos.gitea: the person's work on a Gitea or Forgejo server (review requests, their PRs, issues, failed runs) as
// lanes, an Inbox feed (inbox-feed v2) and an item overlay. Wired like cc-cockpit-github's host.js (keep in step);
// the differences: sign-in is the server address and an access token from the settings, and what the server can do
// (the Actions runs API, re-run) is probed instead of assumed.
//
// One poll: settings → client → /user (binds the token to this server) → probe → the lane searches → PR and issue
// enrichment → items → (every 5 minutes) failed runs → read marks → feed and panel.
//
// Everything stored is keyed by the ACCOUNT, `<server base>/<login>`: the same login on two servers (a work Gitea
// and Codeberg) is two people as far as lists and read marks go, and switching a project to another server never
// shows the old server's list. The token itself is never stored, posted, emitted or logged; only its hash, in the
// binding (lib/client.js).

const { normalize, tokenOf } = require('./lib/settings')
const { createClient, createBinding, SignedOut } = require('./lib/client')
const { createProbe } = require('./lib/probe')
const { searchAll, createEnricher } = require('./lib/search')
const { buildItems } = require('./lib/model')
const { createRuns, runItem, linkPrRuns } = require('./lib/runs')
const { createSeen } = require('./lib/seen')
const { createNotifications } = require('./lib/notifications')
const { createFeed, actionsOf } = require('./lib/feed')
const { createPoller } = require('./lib/poll')
const details = require('./lib/details')
const { createOverlays } = require('./lib/overlay')

const PANEL = 'main'
const RUNS_EVERY = 5 * 60_000
const accountOf = (base, login) => `${base}/${login}`.toLowerCase()
const LIST_KEY = (account) => `list:${account}`
// The last login per server: a restart restores that account's list before the first poll answers.
const LAST_KEY = (base) => `last:${String(base).toLowerCase()}`
const STORE_CAP = 900 * 1024 // appStorage takes 1 MiB less 8 KiB per value

const NO_SERVER = 'Set the server address (your Gitea or Forgejo) in Settings, then Refresh.'
const NO_TOKEN = 'Set an access token in Settings, then Refresh.'

/**
 * The web address of an item on the configured server, or null: the only kind of URL "Open on …" opens. The item
 * URLs are built from the base (lib/model.js, lib/runs.js); this check keeps it that way.
 */
function webUrl(item, server) {
  const u = item && item._ && item._.url
  if (typeof u !== 'string' || !server) return null
  try {
    const p = new URL(u)
    return p.origin === server.origin && p.pathname.startsWith(`${server.prefix}/`) && !p.username && !p.password ? p.href : null
  } catch {
    return null
  }
}

/** The stored list, trimmed (oldest first) until it fits the store. */
function storable(persisted) {
  const items = [...persisted.items].sort((a, b) => b.time - a.time)
  let out = { items, asOf: persisted.asOf }
  while (out.items.length && JSON.stringify(out).length > STORE_CAP) out = { items: out.items.slice(0, Math.floor(out.items.length * 0.8)), asOf: out.asOf }
  return out
}

/**
 * Start the plugin. `deps` (tests): `{ fetch, now, timers }`. Returns the internals a test drives.
 */
function start(ctx, deps = {}) {
  const fetchFn = deps.fetch || ((...a) => fetch(...a))
  const now = deps.now || Date.now
  const log = ctx.log
  let raw = ctx.settings && ctx.settings.project
  let settings = normalize(raw)
  for (const w of settings.warnings) log.warn(`gitea: ${w}`)

  const binding = createBinding({ store: ctx.appStorage, log })
  const probe = createProbe({ now, log })
  const runs = createRuns({ log })
  const seen = createSeen({ store: ctx.appStorage, now, log })
  let enricher = createEnricher({ now, log })
  let client = null
  let offline = null // SignedOut for a missing server or token: why there is no client
  let login = null
  let boundTo = '' // the other server of a token bound elsewhere, while that is the state
  let runItems = []
  let failures = []
  let runList = []
  let runsAt = 0
  let skippedAt = 0 // probe.probedAt when the repos without Actions were last forgotten
  let lastError = ''
  let lastSummary = ''

  /** A fresh client for the current server and token (or the reason there is none); forgets the old server's state. */
  function connect() {
    const token = tokenOf(raw)
    client = null
    offline = null
    if (!settings.server) offline = new SignedOut('noServer', settings.serverProblem || NO_SERVER)
    else if (!token) offline = new SignedOut('noToken', NO_TOKEN)
    else client = createClient({ fetch: fetchFn, server: settings.server, token, binding, now, log })
    probe.reset()
    runs.forget()
    enricher = createEnricher({ now, log })
    login = null
    boundTo = ''
    runItems = []
    failures = []
    runList = []
    runsAt = 0
  }
  connect()

  const notifications = createNotifications({ getClient: () => client, now, log })

  // Run attempts this host re-ran: one re-run per attempt, whoever asks (details.rerun).
  const attempts = new Set()
  // `open` is the overlay, set below once the feed exists.
  const hooks = {
    open: async (item) => openWeb(item),
    rerun: async (item) => {
      if (!client) return { ok: false, message: (offline && offline.message) || 'Not signed in.' }
      const r = await details.rerun(client, item, attempts, probe.current)
      if (r.ok) {
        runsAt = 0
        poller.now()
      }
      return r
    },
  }

  async function openWeb(item) {
    const url = webUrl(item, client && client.server)
    if (!url) return { ok: false, message: 'That item has no address on the configured server.' }
    await ctx.openExternal(url)
    return { ok: true }
  }

  async function mark(item, action) {
    if (action === 'markRead') {
      await seen.markRead(item)
      feed.update({ ...item, read: true })
      void notifications.markRead(item)
    } else if (action === 'markUnread') {
      await seen.markUnread(item)
      feed.update({ ...item, read: false })
    } else if (action === 'done') {
      await seen.done(item)
      feed.remove(item.id)
      void notifications.markDone(item)
    }
    postState()
    return { ok: true }
  }

  const feed = createFeed({
    emit: (event, data) => ctx.services.emit('inbox-feed', event, data),
    getSettings: () => settings,
    getHost: () => probe.current,
    handlers: { mark, open: (i) => hooks.open(i), rerun: (i) => hooks.rerun(i), openWeb },
    now,
    log,
  })

  // ---- panel ----

  /** What the panel gets per row: plain facts, no url (the host opens things). */
  function rowOf(item) {
    return {
      id: item.id,
      kind: item._.kind,
      lanes: item._.lanes,
      title: item.title,
      preview: item.preview || '',
      from: item.from ? item.from.name : '',
      time: item.time,
      read: item.read,
      status: item.place ? item.place.status : '',
      repo: item._.repo,
      labels: item.labels,
      actions: actionsOf(item, probe.current).filter((a) => a.id !== 'open'),
    }
  }

  function stateMessage() {
    const info = probe.current
    return {
      type: 'state',
      login,
      server: settings.server ? settings.server.base : '',
      hostName: info ? info.hostName : '',
      // Why signed out (noServer, noToken, refused, bound), so the panel can point at Settings or offer the rebind.
      reason: feed.state === 'signedOut' ? (offline && offline.reason) || (boundTo ? 'bound' : 'refused') : '',
      boundTo: feed.state === 'signedOut' ? boundTo : '',
      state: feed.state,
      message: feed.state === 'ok' ? '' : feed.message,
      asOf: feed.persisted().asOf || 0,
      lanes: settings.lanes,
      rowsPerLane: settings.rowsPerLane,
      rows: feed.items.map(rowOf),
    }
  }

  function postState() {
    try {
      ctx.panels.post(PANEL, stateMessage())
    } catch (e) {
      log.warn(`gitea: panel post: ${e && e.message ? e.message : e}`)
    }
    setHeader()
  }

  function setHeader() {
    if (!ctx.panels || typeof ctx.panels.header !== 'function') return
    const parts = []
    if (login) parts.push(login)
    if (settings.server) parts.push(settings.server.origin.replace(/^https:\/\//, '') + settings.server.prefix)
    if (feed.state === 'signedOut') parts.push('signed out')
    else if (feed.state === 'error' && feed.message) parts.push(feed.message)
    try {
      ctx.panels.header(PANEL, { meta: parts.join(' · ').slice(0, 120), actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh', busy: poller.running }] })
    } catch (e) {
      log.warn(`gitea: panel header: ${e && e.message ? e.message : e}`)
    }
  }

  /** The person's click on "Use this token for <server>": only while the token is refused for being bound elsewhere. */
  async function rebind() {
    const token = tokenOf(raw)
    if (!boundTo || !client || !token) return
    await binding.rebind(token, client.server.base)
    log.info(`gitea: the access token is now used for ${client.server.base} (was ${boundTo})`)
    boundTo = ''
    // The client checked the binding once and remembers the refusal: start a fresh one.
    client = createClient({ fetch: fetchFn, server: settings.server, token, binding, now, log })
    poller.now()
  }

  async function onPanelMessage(m) {
    if (!m || typeof m !== 'object') return
    if (m.type === 'hello') return postState()
    if (m.type === 'refresh') return poller.now()
    if (m.type === 'rebind') return rebind()
    if (m.type === 'act' && typeof m.id === 'string' && typeof m.action === 'string') {
      const r = await feed.provider.act(m.id, m.action)
      if (!r.ok) ctx.panels.post(PANEL, { type: 'notice', text: r.message })
    }
  }

  // ---- polling ----

  async function storeList() {
    if (!login || !client) return
    try {
      await ctx.appStorage.set(LIST_KEY(accountOf(client.server.base, login)), storable(feed.persisted()))
      await ctx.appStorage.set(LAST_KEY(client.server.base), login)
    } catch (e) {
      log.warn(`gitea: could not store the list: ${e && e.message ? e.message : e}`)
    }
  }

  /** The last list of this server's last account, as stale; an empty stale list when there is none. */
  async function restore() {
    feed.restore({ items: [], asOf: 0 })
    if (!settings.server) return
    try {
      const last = await ctx.appStorage.get(LAST_KEY(settings.server.base))
      if (typeof last !== 'string' || !last) return
      const stored = await ctx.appStorage.get(LIST_KEY(accountOf(settings.server.base, last)))
      login = last
      await seen.use(accountOf(settings.server.base, last))
      // The stored list's read flags are as of its poll; the marks (shared by every window) are the truth.
      if (stored && Array.isArray(stored.items)) {
        const items = stored.items.filter((i) => i && typeof i.id === 'string' && typeof i.rev === 'string' && i._)
        feed.restore({ items: await seen.apply(items), asOf: stored.asOf })
      }
    } catch (e) {
      log.warn(`gitea: could not restore the list: ${e && e.message ? e.message : e}`)
    }
  }

  async function failedRunsNow(c, items) {
    if (!settings.lanes.failedRuns) {
      runItems = []
      failures = []
      runList = []
      runsAt = 0
      return
    }
    if (runsAt && now() - runsAt < RUNS_EVERY) return
    // Repos without Actions are asked again after each new probe of the server (every 6 hours or after a switch).
    if (probe.probedAt !== skippedAt) {
      runs.forget()
      skippedAt = probe.probedAt
    }
    const mine = items.filter((i) => i._.kind === 'pr' && i.labels.includes('my-pr'))
    const r = await runs.failedRuns(c, mine, now(), settings)
    const info = probe.current
    if (info && info.features.runsApi === null && r.answered.length) await probe.learnRuns(c, r.answered[0])
    runItems = r.runs.map((run) => runItem(run, c.server.base))
    failures = r.failures
    runList = r.runs
    runsAt = now()
  }

  async function pollOnce() {
    if (!client) return failed(offline)
    const c = client
    try {
      const me = (await c.user()).login
      boundTo = ''
      if (me !== login || seen.login !== accountOf(c.server.base, me)) {
        login = me
        await seen.use(accountOf(c.server.base, me))
      }
      await probe.get(c)
      const teamIds = settings.lanes.reviewRequested ? await enricher.teams(c) : new Set()
      const { results } = await searchAll(c, settings.lanes, { myIssues: settings.myIssues })
      const enriched = await enricher.enrich(c, results)
      const items = buildItems(results, enriched, settings, { me, base: c.server.base, teamIds })
      await failedRunsNow(c, items)
      if (settings.lanes.myPrs) linkPrRuns(items, failures, runList)
      // A settings change while this poll ran rebuilt the client: its results belong to the old server.
      if (c !== client) return { ok: false }
      const visible = await seen.apply(items.concat(runItems))
      feed.setItems(visible, now())
      // One line when the picture changes (not every poll), so `ccc plugin logs` tells a working poll from silence.
      const unread = visible.filter((i) => !i.read).length
      const info = probe.current
      const summary = `${me} on ${info ? `${info.hostName} ${info.versionText || '?'}` : 'the server'}: ${items.length} PRs/issues, ${runItems.length} failed runs, ${unread} unread`
      if (summary !== lastSummary || lastError) log.info(`gitea: poll ok as ${summary}`)
      lastSummary = summary
      lastError = ''
      await storeList()
      postState()
      return { ok: true }
    } catch (e) {
      if (c !== client) return { ok: false }
      return failed(e)
    }
  }

  function failed(e) {
    if (e && e.signedOut) {
      boundTo = e.reason === 'bound' ? e.boundTo || '' : ''
      if (e.message !== lastError) log.warn(`gitea: signed out: ${e.message}`)
      lastError = e.message
      feed.setState('signedOut', e.message)
      postState()
      return { ok: false, signedOut: true }
    }
    const msg = e && e.message ? e.message : 'The server could not be reached'
    if (msg !== lastError) log.warn(`gitea: ${msg}`)
    lastError = msg
    feed.setState('error', msg)
    postState()
    return e && e.rateLimited ? { ok: false, until: e.until } : { ok: false }
  }

  const poller = createPoller({ run: pollOnce, minutes: () => settings.pollMinutes, now, timers: deps.timers, log })

  async function onSettings(next) {
    const prevBase = settings.server ? settings.server.base : ''
    const prevToken = tokenOf(raw)
    raw = next && next.project
    settings = normalize(raw)
    for (const w of settings.warnings) log.warn(`gitea: ${w}`)
    const base = settings.server ? settings.server.base : ''
    if (base !== prevBase || tokenOf(raw) !== prevToken) {
      connect()
      // Another server: its own list (or none yet), never the old server's rows under the new address.
      if (base !== prevBase) {
        lastSummary = ''
        await restore()
      }
    }
    if (!settings.lanes.failedRuns) runsAt = 0
    postState()
    poller.now()
  }

  const renderer = details.createRenderer({ log })
  const overlays = createOverlays({
    ctx,
    getItem: (id) => feed.current(id),
    fetchDetails: (item) => {
      if (!client) return Promise.reject(new Error((offline && offline.message) || 'Not signed in.'))
      return details.detailsOf(client, item, { renderer, info: probe.current, log })
    },
    onOpened: async (item) => {
      if (settings.markReadOnOpen && !item.read) await mark(item, 'markRead')
    },
    act: (id, action) => feed.provider.act(id, action),
    getHost: () => probe.current,
    getServer: () => (client ? client.server : null),
    log,
  })
  hooks.open = (item) => overlays.open(item)

  const disposers = []
  const ready = (async () => {
    await restore()
    ctx.services.provide('inbox-feed', feed.provider)
    disposers.push(ctx.panels.onMessage(PANEL, onPanelMessage))
    if (typeof ctx.panels.onAction === 'function') disposers.push(ctx.panels.onAction(PANEL, (id) => id === 'refresh' && poller.now()))
    disposers.push(ctx.onSettingsChange(onSettings))
    disposers.push(overlays.register())
    postState()
    poller.now()
  })()

  return {
    ready,
    feed,
    seen,
    probe,
    runs,
    hooks,
    poller,
    notifications,
    get client() {
      return client
    },
    get settings() {
      return settings
    },
    get login() {
      return login
    },
    pollOnce,
    postState,
    stop() {
      poller.stop()
      for (const d of disposers) if (typeof d === 'function') d()
    },
  }
}

let running = null

exports.activate = async (ctx) => {
  running = start(ctx)
  await running.ready
}

exports.deactivate = () => {
  if (running) running.stop()
  running = null
}

exports._start = start
exports._webUrl = webUrl
exports._storable = storable
