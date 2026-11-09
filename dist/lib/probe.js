'use strict'
// What this server is and what it can do, asked at run time instead of configured: the person's work Gitea may be
// 1.23 today and newer tomorrow, and the same plugin serves Forgejo.
//
// - Flavour and version: `/api/forgejo/v1/version` answers on Forgejo only (Gitea 404s); `/version` on both.
//   Forgejo's `/version` reads like `17.0.0-99-322c239+gitea-1.22.0`, which must never be taken for Gitea 1.22,
//   and current Gitea reads `29.0.0+dev-160-g…`, so versions are compared as numbers, and a version that does not
//   parse turns every optional feature off (the lanes still work: they use only APIs every version has).
// - Features:
//     runsApi  `actions/runs` (+ `runs/{run}/jobs`): newer Gitea, Forgejo. Not decidable from the version alone
//              (the exact Gitea release is not documented), so it is learned: `learnRuns` is called with the first
//              repo whose `actions/tasks` answered (Actions is on there), and a 404 on its `actions/runs` means
//              the server has no runs API. A repo with Actions switched off never decides it.
//     jobLogs  needs runsApi: a job id can only be found through `runs/{run}/jobs` (a task id is not a job id).
//     rerun    Gitea ≥ 1.26 (`rerun-failed-jobs`) or Forgejo ≥ 17 (`rerun`), and runsApi (the run id lookup).
// - Cached for 6 hours (a server upgrade is noticed within that), dropped on a settings change (`reset`).
// - A probe never fails a poll: an error leaves the optional features off, logged once.

const TTL = 6 * 3600_000

/** `[major, minor, patch]` from the leading `X.Y.Z` of a version string, or null. */
function parseVersion(s) {
  if (typeof s !== 'string') return null
  const m = s.trim().match(/^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** a ≥ b for version arrays. */
function atLeast(a, b) {
  if (!a) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

/** The info for a flavour + version text, with `runsApi` still unknown (null) unless given. */
function infoOf(flavour, versionText, runsApi = null) {
  const v = parseVersion(versionText)
  const hostName = flavour === 'forgejo' ? 'Forgejo' : 'Gitea'
  const rerunByVersion = !!v && (flavour === 'forgejo' ? atLeast(v, [17, 0, 0]) : atLeast(v, [1, 26, 0]))
  const runs = v ? runsApi : false
  return {
    flavour,
    hostName,
    version: v,
    versionText: typeof versionText === 'string' ? versionText.slice(0, 80) : '',
    features: {
      runsApi: runs,
      jobLogs: runs === true,
      rerun: runs === true && rerunByVersion,
    },
  }
}

/**
 * `{ get(client), learnRuns(client, repo), reset(), current }`. `get` answers the cached info for this server or
 * probes it; `learnRuns` settles `runsApi` once with a repo that has Actions on.
 */
function createProbe({ now = Date.now, log }) {
  let cached = null // { base, at, info }
  let warned = false

  async function detect(client) {
    let versionText = ''
    try {
      const { data } = await client.rest('GET', '/version')
      versionText = data && typeof data.version === 'string' ? data.version : ''
    } catch (e) {
      if (e && (e.signedOut || e.rateLimited)) throw e
      if (!warned) log.warn(`gitea: could not read the server version: ${e && e.message ? e.message : e}`)
      warned = true
    }
    const fj = await client.forgejoVersion()
    if (fj) return infoOf('forgejo', fj)
    // A Forgejo whose own endpoint failed still says so in /version.
    const m = versionText.match(/^(\d+\.\d+\.\d+)[^+]*\+gitea-/)
    if (m) return infoOf('forgejo', m[1])
    return infoOf('gitea', versionText)
  }

  return {
    async get(client) {
      const base = client.server.base
      if (cached && cached.base === base && now() - cached.at < TTL) return cached.info
      const info = await detect(client)
      cached = { base, at: now(), info }
      return info
    },
    /** Settle runsApi with `repo` ('owner/repo'), whose actions/tasks answered. Returns the (new) info. */
    async learnRuns(client, repo) {
      if (!cached || cached.base !== client.server.base || cached.info.features.runsApi !== null) return cached && cached.info
      const [owner, name] = repo.split('/')
      let has
      try {
        await client.rest('GET', `/repos/${owner}/${name}/actions/runs`, { query: { limit: 1 } })
        has = true
      } catch (e) {
        if (e && (e.signedOut || e.rateLimited || e.network)) throw e
        if (e && e.status !== 404 && e.status !== 405) {
          log.warn(`gitea: could not tell whether the server has the runs API: ${e.message}`)
          return cached.info
        }
        has = false
      }
      const i = cached.info
      cached.info = infoOf(i.flavour, i.versionText, has)
      log.info(`gitea: ${i.hostName} ${i.versionText || '(version unknown)'}: runs API ${has ? 'available' : 'not available'}`)
      return cached.info
    },
    reset() {
      cached = null
      warned = false
    },
    get current() {
      return cached ? cached.info : null
    },
    /** When the server was last probed (0: never): a new probe asks the repos without Actions again. */
    get probedAt() {
      return cached ? cached.at : 0
    },
  }
}

module.exports = { createProbe, parseVersion, atLeast, infoOf, TTL }
