'use strict'
// The project's settings, normalised: the app validates against the schema, but a value can still be absent (an
// older save) or odd (a list entry with spaces), and the schema takes no regexes, so the shape checks (owner names,
// the server address) live here. Based on cc-cockpit-github's settings.js (lanes, numbers, exclude) plus the server.
//
// The token is never part of the normalised object: `normalize` says only whether one is set, and `tokenOf` hands
// the value to the one place that needs it (the client). A settings object that ends up in a log or a post can then
// never carry it.

const LANES = ['reviewRequested', 'myPrs', 'issues', 'failedRuns']

// Gitea and Forgejo user and org names: letters, digits, `-`, `_`, `.` (up to 40); repo names the same, up to 100.
// Lenient on purpose (an entry that matches nothing excludes nothing), strict enough that the list stays names.
const OWNER = /^[a-z0-9][a-z0-9._-]{0,39}$/
const REPO = /^[a-z0-9._-]{1,100}$/

// http is allowed only where the token cannot cross a network: the person's own machine.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function int(v, min, max, dflt) {
  return Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : dflt
}

/** `owner` or `owner/repo`, lower-cased, or null when it is neither. */
function parseExclude(entry) {
  if (typeof entry !== 'string') return null
  const e = entry.trim().toLowerCase()
  const parts = e.split('/')
  const ok = (x, re) => re.test(x) && x !== '.' && x !== '..'
  if (parts.length === 1 && ok(parts[0], OWNER)) return parts[0]
  if (parts.length === 2 && ok(parts[0], OWNER) && ok(parts[1], REPO)) return e
  return null
}

/**
 * The server address: `{ server: { origin, prefix, base } }`, or `{ problem }` (a sentence for the person) when it is
 * missing or refused. `base` is origin + prefix with no trailing slash (`https://git.example.com/gitea`); the client
 * builds every URL from it. Refused: anything but https (http on loopback only), user:pass in it, a query or a
 * fragment, a prefix with dot segments or an encoded character (it would mean something else to the server).
 */
function parseServer(v) {
  const missing = { problem: 'Set the server address (your Gitea or Forgejo, such as https://git.example.com) in Settings.' }
  if (typeof v !== 'string' || !v.trim()) return missing
  const raw = v.trim()
  const refused = { problem: `The server address "${raw.slice(0, 120)}" is not usable: write it as https://host or https://host/path.` }
  let u
  try {
    u = new URL(raw)
  } catch {
    return refused
  }
  // Never echo an address with credentials in it: the sentence reaches the panel and the log.
  if (u.username || u.password) return { problem: 'The server address must not contain a user name or password: use the access token field.' }
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return refused
  if (u.protocol === 'http:') {
    if (!LOOPBACK.has(u.hostname)) return { problem: `The server address must use https (http only for localhost): ${u.origin}` }
  } else if (u.protocol !== 'https:') return refused
  // Checked on the text as typed: URL() has already resolved `..` and `%2e%2e` in u.pathname, so an address with
  // them would silently turn into another one.
  const typedPath = raw.replace(/^[a-z]+:\/\/[^/]*/i, '')
  if (typedPath.includes('%') || typedPath.includes('\\') || typedPath.split('/').some((s) => s === '.' || s === '..')) return refused
  const prefix = u.pathname.replace(/\/+$/, '')
  if (prefix.includes('//')) return refused
  return { server: { origin: u.origin, prefix, base: u.origin + prefix } }
}

/** The token as typed, or null: a secret field is absent when unset, never ''. */
function tokenOf(raw) {
  const t = raw && typeof raw === 'object' ? raw.token : undefined
  return typeof t === 'string' && t.trim() ? t.trim() : null
}

/**
 * `{ server, serverProblem, hasToken, lanes, rowsPerLane, markReadOnOpen, myIssues, exclude, pollMinutes, warnings }` from
 * `ctx.settings.project`. `warnings` lists what was dropped, for the log (the rest still works).
 */
function normalize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const warnings = []
  const lanes = {}
  const rawLanes = p.lanes && typeof p.lanes === 'object' ? p.lanes : {}
  for (const l of LANES) lanes[l] = typeof rawLanes[l] === 'boolean' ? rawLanes[l] : true
  const exclude = []
  for (const e of Array.isArray(p.exclude) ? p.exclude.slice(0, 100) : []) {
    const x = parseExclude(e)
    if (x === null) warnings.push(`"Leave out" entry ignored: ${JSON.stringify(String(e)).slice(0, 80)}`)
    else if (!exclude.includes(x)) exclude.push(x)
  }
  const s = parseServer(p.serverUrl)
  return {
    server: s.server || null,
    serverProblem: s.problem || '',
    hasToken: tokenOf(p) !== null,
    lanes,
    rowsPerLane: int(p.rowsPerLane, 1, 300, 10),
    markReadOnOpen: typeof p.markReadOnOpen === 'boolean' ? p.markReadOnOpen : true,
    myIssues: p.myIssues === true,
    exclude,
    pollMinutes: int(p.pollMinutes, 2, 15, 2),
    warnings,
  }
}

/** Whether `owner/repo` is left out by the settings (owner or exact repo, any case). */
function isExcluded(fullName, settings) {
  if (typeof fullName !== 'string' || !settings.exclude.length) return false
  const full = fullName.toLowerCase()
  const owner = full.split('/')[0]
  return settings.exclude.includes(owner) || settings.exclude.includes(full)
}

module.exports = { normalize, isExcluded, parseExclude, parseServer, tokenOf, LANES }
