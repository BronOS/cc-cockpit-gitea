'use strict'
// The server's REST API (`<base>/api/v1`), with the person's access token. Adapted from cc-cockpit-github's
// client.js, with one difference that matters: the server is whatever the person typed, so the token is pinned
// twice.
//  - To one origin: every authenticated request goes to `<base>/api/...` and nowhere else. A path is checked
//    before it is joined, pagination links are checked against the origin and the base's prefix, and redirects
//    are never followed with the token (`redirect: 'manual'`; a 3xx is an error, except the log tail, which follows
//    an https redirect by hand WITHOUT the token).
//  - To one server: the URL and the token are separate settings, each with a global default, so a project that
//    overrides only the URL would inherit the global token and send it to another server (plan review, finding 1).
//    `createBinding` records `sha256(token) → base` on the token's first successful sign-in and refuses it for any
//    other base until the person rebinds it with a click.
// Rate limits (429 or Retry-After) block every later call until the time the server gave.

const crypto = require('node:crypto')

const USER_AGENT = 'cc-cockpit-gitea'
const JSON_CAP = 5 * 1024 * 1024
const TAIL_STREAM_CAP = 20 * 1024 * 1024
// Paths built from the server's own names (owner, repo, numbers, ids). Narrow on purpose: no `..` segment, no `//`,
// no scheme, no backslash, no query (that goes in `query`), and no `%`: the URL parser reads `%2e%2e` as `..`.
const PATH_SHAPE = /^\/[A-Za-z0-9._~\-/:@+]*$/

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

class RateLimited extends Error {
  constructor(until) {
    const d = new Date(until)
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    super(`The server asked to wait, back at ${hm}`)
    this.name = 'RateLimited'
    this.until = until
    this.rateLimited = true
  }
}

class NetworkError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NetworkError'
    this.network = true
  }
}

/** Not signed in: `reason` is `noServer`, `noToken`, `refused` or `bound` (`boundTo` the other server). */
class SignedOut extends Error {
  constructor(reason, message, boundTo) {
    super(message)
    this.name = 'SignedOut'
    this.signedOut = true
    this.reason = reason
    if (boundTo) this.boundTo = boundTo
  }
}

const REFUSED_MESSAGE = 'The server refused the access token: check it in Settings, then Refresh.'

function checkPath(path) {
  if (typeof path !== 'string' || !PATH_SHAPE.test(path) || path.includes('//') || /(^|\/)\.\.?(\/|$)/.test(path)) {
    throw new Error(`refused API path ${JSON.stringify(String(path)).slice(0, 80)}`)
  }
  return path
}

const hashOf = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Which server each token belongs to, in `store` (ctx.appStorage, shared by every window) under `tokens`:
 * `{ [sha256(token)]: base }`. Only hashes are stored. `check` says whether a token may go to `base`; `bind` records
 * it after a successful sign-in (never over another server's binding); `rebind` is the person's explicit move.
 */
function createBinding({ store, log }) {
  const KEY = 'tokens'
  async function read() {
    try {
      const v = await store.get(KEY)
      return v && typeof v === 'object' ? v : {}
    } catch (e) {
      log.warn(`gitea: could not read token bindings: ${e && e.message ? e.message : e}`)
      return {}
    }
  }
  async function write(map) {
    // At most 50 tokens remembered (oldest dropped): a person replaces tokens now and then, never by the hundred.
    const keys = Object.keys(map)
    while (keys.length > 50) delete map[keys.shift()]
    await store.set(KEY, map)
  }
  return {
    /** `{ ok: true }` or `{ ok: false, boundTo }`. */
    async check(token, base) {
      const map = await read()
      const b = map[hashOf(token)]
      return !b || b === base ? { ok: true } : { ok: false, boundTo: b }
    },
    async bind(token, base) {
      const map = await read()
      const h = hashOf(token)
      if (map[h] && map[h] !== base) return false
      if (map[h] === base) return true
      map[h] = base
      await write(map)
      return true
    },
    async rebind(token, base) {
      const map = await read()
      delete map[hashOf(token)]
      map[hashOf(token)] = base
      await write(map)
    },
  }
}

/** The body as bytes, at most `max`; `{ buf, truncated }`. Stops reading (and cancels the body) past the cap. */
async function readCapped(res, max) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false }
  const chunks = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength - (size - max)))
      await reader.cancel().catch(() => {})
      return { buf: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(Buffer.from(value))
  }
  return { buf: Buffer.concat(chunks), truncated: false }
}

/** The last `keep` bytes of a body (read to its end, at most `cap`); `{ buf, truncated }`. */
async function readTail(res, keep, cap) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false }
  let tail = Buffer.alloc(0)
  let size = 0
  let cut = false
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    tail = Buffer.concat([tail, Buffer.from(value)])
    if (tail.length > keep) {
      tail = tail.subarray(tail.length - keep)
      cut = true
    }
    if (size > cap) {
      await reader.cancel().catch(() => {})
      cut = true
      break
    }
  }
  return { buf: Buffer.from(tail), truncated: cut }
}

/**
 * `{ rest, pages, user, forgejoVersion, tail, blockedUntil }` for `server` (`{ origin, prefix, base }` from
 * settings.parseServer) and `token`. `binding` is createBinding's; `user()` checks it before the first request and
 * binds on success, and every other call refuses a token bound elsewhere too.
 * Errors: `SignedOut`, `RateLimited` (with `until`), `HttpError` (status), `NetworkError`.
 */
function createClient({ fetch, server, token, binding, now = Date.now, log, timeoutMs = 20_000 }) {
  let blocked = 0
  let cleared = false // the binding was checked for this client (it is rebuilt on a settings change)
  const apiRoot = `${server.base}/api/v1`

  async function guard() {
    if (cleared) return
    const c = await binding.check(token, server.base)
    if (!c.ok) {
      throw new SignedOut('bound', `This access token belongs to ${c.boundTo}: set this project's token in Settings, or use it for ${server.base}.`, c.boundTo)
    }
    cleared = true
  }

  function block(res) {
    const retry = Number(res.headers.get('retry-after'))
    let until = now() + 60_000
    if (Number.isFinite(retry) && retry > 0) until = now() + Math.min(retry, 3600) * 1000
    blocked = Math.max(blocked, until)
    log.warn(`gitea: rate limited until ${new Date(blocked).toISOString()}`)
    return new RateLimited(blocked)
  }

  /**
   * Why a request never got an answer, in words the person can act on. A typo in the address (`gt.example.ocm`) used
   * to read "Could not reach the server" with nothing to go on; Node's fetch puts the reason in `cause.code`.
   */
  function unreachable(e, url) {
    if (e && e.name === 'TimeoutError') return 'The server did not answer in time'
    let host = 'the server'
    try {
      host = new URL(url).host
    } catch {
      // keep the generic name
    }
    const code = (e && e.cause && e.cause.code) || ''
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not find ${host}: check the server address in Settings`
    if (code === 'ECONNREFUSED') return `${host} refused the connection: check the server address and port`
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) return `${host}'s certificate was not accepted (${code})`
    return `Could not reach ${host}${code ? ` (${code})` : ''}`
  }

  /** One authenticated request to the server's API, never following a redirect with the token. */
  async function send(url, init = {}) {
    if (blocked > now()) throw new RateLimited(blocked)
    await guard()
    const headers = { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetch(url, {
        method: init.method || 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new NetworkError(unreachable(e, url))
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {})
      throw new SignedOut('refused', REFUSED_MESSAGE)
    }
    if (res.status === 429 || (res.status === 403 && res.headers.has('retry-after'))) {
      await res.body?.cancel().catch(() => {})
      throw block(res)
    }
    return res
  }

  async function errorOf(res) {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      return new HttpError(res.status, `The server redirected the request (${res.status}); the token is not sent on`)
    }
    let message = `The server answered ${res.status}`
    try {
      const { buf } = await readCapped(res, 64 * 1024)
      const body = JSON.parse(buf.toString('utf8'))
      if (body && typeof body.message === 'string') message += `: ${body.message.slice(0, 200)}`
    } catch {
      // not JSON: the status says enough
    }
    return new HttpError(res.status, message)
  }

  function urlOf(path, query) {
    const u = new URL(apiRoot + checkPath(path))
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue
        // An array is a repeated parameter (`subject-type=pull&subject-type=issue`).
        if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x))
        else u.searchParams.set(k, String(v))
      }
    }
    return u
  }

  async function parse(res, { raw, maxBytes = JSON_CAP }) {
    if (res.status === 204 || res.status === 205) return { status: res.status, data: null, headers: res.headers }
    const { buf, truncated } = await readCapped(res, maxBytes)
    if (raw) return { status: res.status, data: buf.toString('utf8'), truncated, headers: res.headers }
    if (truncated) throw new HttpError(res.status, 'The server sent more than the plugin reads')
    let data = null
    if (buf.length) {
      try {
        data = JSON.parse(buf.toString('utf8'))
      } catch {
        throw new HttpError(res.status, 'The server sent something that is not JSON')
      }
    }
    return { status: res.status, data, headers: res.headers }
  }

  /** `rest(method, path, { query, body, raw, maxBytes })` → `{ status, data, headers, truncated? }`. */
  async function rest(method, path, o = {}) {
    const res = await send(urlOf(path, o.query), { method, body: o.body })
    if (!res.ok) throw await errorOf(res)
    return parse(res, o)
  }

  /** The `next` URL of a Link header, only when it stays under this server's API root. */
  function nextLink(link) {
    if (!link) return null
    for (const part of link.split(',')) {
      const m = part.match(/<([^>]+)>\s*;\s*rel="next"/)
      if (!m) continue
      try {
        const u = new URL(m[1])
        if (u.origin === server.origin && u.pathname.startsWith(`${server.prefix}/api/v1/`)) return u
      } catch {
        return null
      }
      return null
    }
    return null
  }

  /** GET every page of a list (`page` / `limit`, following `Link: next` on this server), at most `pages`. */
  async function pages(path, o = {}) {
    let url = urlOf(path, { limit: o.limit || 50, ...o.query })
    const out = []
    for (let i = 0; i < (o.pages || 5) && url; i++) {
      const res = await send(url)
      if (!res.ok) throw await errorOf(res)
      const { data } = await parse(res, {})
      const items = o.key ? data && data[o.key] : data
      if (Array.isArray(items)) out.push(...items)
      url = nextLink(res.headers.get('link'))
    }
    return out
  }

  /** GET /user; binds the token to this server on success (refused when it belongs to another one). */
  async function user() {
    const { data } = await rest('GET', '/user')
    if (!data || typeof data.login !== 'string') throw new HttpError(200, 'The server sent no user')
    const bound = await binding.bind(token, server.base)
    if (!bound) {
      cleared = false
      await guard() // throws SignedOut('bound') with the other server's name
    }
    return data
  }

  /** Forgejo's own version (`/api/forgejo/v1/version`), or null on a Gitea (404) or any failure. */
  async function forgejoVersion() {
    try {
      const res = await send(new URL(`${server.base}/api/forgejo/v1/version`))
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return null
      }
      const { data } = await parse(res, { maxBytes: 64 * 1024 })
      return data && typeof data.version === 'string' ? data.version : null
    } catch (e) {
      if (e && (e.signedOut || e.rateLimited)) throw e
      return null
    }
  }

  /**
   * The last `keep` bytes of a text resource (job logs). Read as a stream (a server may ignore Range) and given up
   * past 20 MB. A redirect (a server that keeps logs in object storage) is followed once, https only, WITHOUT the
   * token.
   */
  async function tail(path, { keep = 64 * 1024 } = {}) {
    const res = await send(urlOf(path))
    let body = res
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      let u
      try {
        u = new URL(res.headers.get('location'), urlOf(path))
      } catch {
        throw new HttpError(res.status, 'The server sent a broken redirect')
      }
      if (u.protocol !== 'https:') throw new HttpError(res.status, 'The server redirected the log to a non-https address')
      try {
        body = await fetch(u, { headers: { 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        throw new NetworkError(e && e.name === 'TimeoutError' ? 'The log did not arrive in time' : 'Could not fetch the log')
      }
    }
    if (!body.ok) {
      await body.body?.cancel().catch(() => {})
      throw new HttpError(body.status, `The log answered ${body.status}`)
    }
    const { buf, truncated } = await readTail(body, keep, TAIL_STREAM_CAP)
    return { text: buf.toString('utf8'), truncated }
  }

  return {
    rest,
    pages,
    user,
    forgejoVersion,
    tail,
    server,
    get blockedUntil() {
      return blocked > now() ? blocked : 0
    },
  }
}

module.exports = { createClient, createBinding, HttpError, RateLimited, NetworkError, SignedOut, checkPath, hashOf, REFUSED_MESSAGE }
