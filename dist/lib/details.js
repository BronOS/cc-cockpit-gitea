'use strict'
// What the overlay shows of one item, fetched when it opens (never polled): the PR's description, its timeline of
// comments and reviews, its checks (failed ones with their log tails) and its changed files; an issue's body and
// comments; a run's jobs (failed ones with their log tails). Adapted from cc-cockpit-github's details.js (same output
// shape, so panels/itemview.js and discussText stay in step); the fetching is Gitea's REST:
//
//   - Markdown arrives as source: the server renders it (`POST /markdown`, gfm, the repo as context), at most
//     MAX_RENDERS a view, each cached by a hash of its text; past that a body is shown as escaped plain text. The HTML
//     is the server's and untrusted: the page sanitises it (panels/sanitize.js), which drops relative links, so links
//     starting with `/` are made absolute on the configured base here.
//   - Checks are the head commit's commit statuses (Gitea Actions writes one per job, `<workflow> / <job> (<event>)`).
//   - Log tails need a JOB id, and only the runs API leads to one (probe `features.jobLogs`): the run id is looked up
//     by run number (Forgejo `actions/runs?run_number=N`, current Gitea `actions/runs?head_sha=` matched by
//     `run_number`), then `runs/{run}/jobs` by job name (Forgejo also gives the job's `task_id`, an exact match). A
//     task id is never used as a job id: the two are separate sequences, so it could show another job's log. Without
//     the runs API (Gitea 1.23, 1.24) a failed job links to its web page instead.
//   - Files: `pulls/{n}/files` has no patches; they come from `pulls/{n}.diff`, read up to DIFF_CAP and split per file.
//
// Also Re-run failed jobs (the plugin's one write besides notifications) and the text Discuss with Claude sends.

const crypto = require('node:crypto')
const { jobLogTail } = require('./logs')

const DIFF_CAP = 1024 * 1024
const MAX_TIMELINE = 50
const MAX_FAILED_LOGS = 3
const MAX_RENDERS = 20
const RENDER_CACHE = 200
const COMMENTS_CAP = 2 * 1024 * 1024
const HTML_CAP = 1024 * 1024

const DISCUSS = { event: 600, tail: 2000, total: 12000 }

function parts(item) {
  const [owner, name] = item._.repo.split('/')
  return { owner, name, base: `/repos/${owner}/${name}` }
}

const who = (u) => (u && typeof u.login === 'string' ? u.login : 'someone')
const ms = (s) => {
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** Plain text as HTML paragraphs, for a body past the render budget or one the server would not render. */
function textHtml(s) {
  const t = String(s || '').trim()
  if (!t) return ''
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** `href="/…"` and `src="/…"` made absolute on the server (`origin` + the path, under `prefix` when it is not yet). */
function absolutize(html, server) {
  return String(html || '').replace(/\b(href|src)=(["'])(\/(?!\/)[^"']*)\2/gi, (all, attr, q, path) => {
    const p = server.prefix && !path.startsWith(`${server.prefix}/`) ? `${server.prefix}${path}` : path
    return `${attr}=${q}${server.origin}${p}${q}`
  })
}

/** A status `target_url` made absolute on the server (Gitea Actions writes a path), or '' when it is not http(s). */
function absoluteUrl(u, server) {
  if (typeof u !== 'string' || !u) return ''
  if (u.startsWith('/') && !u.startsWith('//')) return `${server.origin}${server.prefix && !u.startsWith(`${server.prefix}/`) ? server.prefix : ''}${u}`
  try {
    const p = new URL(u)
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : ''
  } catch {
    return ''
  }
}

/**
 * `{ render(client, repo, text), budget() }`: Markdown to the server's HTML, cached by text hash across views (one
 * renderer per host), at most MAX_RENDERS server calls per view (`budget()` starts a view).
 */
function createRenderer({ log } = {}) {
  const cache = new Map()
  let left = MAX_RENDERS
  return {
    budget() {
      left = MAX_RENDERS
    },
    async render(client, repo, text) {
      const t = String(text || '')
      if (!t.trim()) return ''
      const key = crypto.createHash('sha256').update(`${repo}\u0000${t}`).digest('hex')
      if (cache.has(key)) return cache.get(key)
      if (left <= 0) return textHtml(t)
      left--
      let html
      try {
        const { data, truncated } = await client.rest('POST', '/markdown', { body: { Text: t, Mode: 'gfm', Context: `${client.server.prefix}/${repo}` }, raw: true, maxBytes: HTML_CAP })
        html = truncated ? textHtml(t) : absolutize(data, client.server)
      } catch (e) {
        if (e && (e.signedOut || e.rateLimited || e.network)) throw e
        if (log) log.warn(`gitea: could not render a body of ${repo}: ${e && e.message ? e.message : e}`)
        return textHtml(t)
      }
      cache.set(key, html)
      while (cache.size > RENDER_CACHE) cache.delete(cache.keys().next().value)
      return html
    },
  }
}

// Gitea review states in GitHub's words, which the page and discussText use.
const REVIEW_STATE = { APPROVED: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }

async function timelineOf(client, renderer, repo, comments, reviews) {
  const t = []
  for (const c of comments) if (c && c.user) t.push({ kind: 'comment', who: who(c.user), at: ms(c.created_at), text: c.body })
  for (const r of reviews) {
    if (!r || !r.user || r.state === 'PENDING' || r.state === 'REQUEST_REVIEW') continue
    t.push({ kind: 'review', who: who(r.user), at: ms(r.submitted_at), state: r.dismissed ? 'DISMISSED' : REVIEW_STATE[r.state] || 'COMMENTED', text: r.body })
  }
  const kept = t.sort((a, b) => a.at - b.at).slice(-MAX_TIMELINE)
  // Newest first for the render budget: the latest events matter most when a long thread runs past it.
  for (const e of [...kept].reverse()) e.html = await renderer.render(client, repo, e.text)
  for (const e of kept) delete e.text
  return kept
}

// ---- Actions: run id, job ids, tails ----

const TASK_CONCLUSION = { success: 'success', failure: 'failure', cancelled: 'cancelled', skipped: 'skipped' }

/**
 * The run of `runNumber` through the runs API: `{ id, status, conclusion, attempt }` or null. Forgejo filters by
 * `run_number` (its `index_in_repo`); current Gitea lists by `head_sha` and the run number is matched here. Only
 * with `info.features.runsApi`.
 */
async function resolveRun(client, repo, { runNumber, sha }, info) {
  if (!info || !info.features.runsApi || !Number.isInteger(runNumber)) return null
  const [owner, name] = repo.split('/')
  const path = `/repos/${owner}/${name}/actions/runs`
  if (info.flavour === 'forgejo') {
    const list = await client.pages(path, { key: 'workflow_runs', query: { run_number: runNumber }, pages: 1, limit: 5 })
    const r = list.find((x) => x && x.index_in_repo === runNumber && Number.isInteger(x.id))
    return r ? { id: r.id, status: String(r.status || ''), conclusion: String(r.status || ''), attempt: 1 } : null
  }
  const query = sha ? { head_sha: sha } : {}
  const list = await client.pages(path, { key: 'workflow_runs', query, pages: sha ? 1 : 2, limit: 50 })
  const r = list.find((x) => x && x.run_number === runNumber && Number.isInteger(x.id))
  return r ? { id: r.id, status: String(r.status || ''), conclusion: String(r.conclusion || ''), attempt: Number.isInteger(r.run_attempt) ? r.run_attempt : 1 } : null
}

/** The jobs of a run id: `[{ id, name, failed, taskId? }]` (Forgejo answers an array, Gitea `{ jobs }`). */
async function jobsOf(client, repo, runId) {
  const [owner, name] = repo.split('/')
  const { data } = await client.rest('GET', `/repos/${owner}/${name}/actions/runs/${runId}/jobs`, { query: { limit: 100 } })
  const list = Array.isArray(data) ? data : data && Array.isArray(data.jobs) ? data.jobs : []
  return list
    .filter((j) => j && Number.isInteger(j.id) && typeof j.name === 'string')
    .map((j) => ({ id: j.id, name: j.name, failed: j.status === 'failure' || j.conclusion === 'failure', taskId: Number.isInteger(j.task_id) ? j.task_id : undefined }))
}

/**
 * The job of a failed task: by `task_id` where the server gives it, else the one failed job of that name. Two failed
 * jobs of one name (a matrix) without a task id are ambiguous: no tail rather than maybe the wrong one.
 */
function jobFor(task, jobs) {
  const exact = jobs.find((j) => j.taskId !== undefined && j.taskId === task.id)
  if (exact) return exact
  const named = jobs.filter((j) => j.name === task.name && j.taskId === undefined)
  const failed = named.filter((j) => j.failed)
  if (failed.length === 1) return failed[0]
  if (!failed.length && named.length === 1) return named[0]
  return null
}

/**
 * Log tails for `rows` (each `{ failed, task }`), at most MAX_FAILED_LOGS. Run ids and job lists are fetched once per
 * run number. A tail that cannot be fetched says so instead of failing the view.
 */
async function withTails(client, repo, rows, info, log) {
  if (!info || !info.features.jobLogs) return rows
  const runs = new Map() // run number -> Promise<jobs | null>
  let n = 0
  for (const row of rows) {
    if (!row.failed || !row.task || n >= MAX_FAILED_LOGS) continue
    n++
    try {
      const t = row.task
      if (!runs.has(t.run_number)) {
        runs.set(
          t.run_number,
          resolveRun(client, repo, { runNumber: t.run_number, sha: t.head_sha }, info).then((run) => (run ? jobsOf(client, repo, run.id) : null))
        )
      }
      const jobs = await runs.get(t.run_number)
      const job = jobs && jobFor(t, jobs)
      if (!job) {
        row.tailError = 'The job of this task was not found on the server.'
        continue
      }
      row.tail = (await jobLogTail(client, repo, job.id)).text
    } catch (e) {
      if (e && (e.signedOut || e.rateLimited)) throw e
      row.tail = ''
      row.tailError = e && e.message ? String(e.message).slice(0, 200) : 'The log could not be fetched.'
      if (log) log.warn(`gitea: log of ${repo} run #${row.task.run_number} ${row.task.name}: ${row.tailError}`)
    }
  }
  return rows
}

/** The tasks of a repo (newest first, 2 pages of 50), for a run's jobs or a head commit's failures. */
async function tasksOf(client, repo) {
  const [owner, name] = repo.split('/')
  const list = await client.pages(`/repos/${owner}/${name}/actions/tasks`, { key: 'workflow_runs', pages: 2, limit: 50 })
  return list.filter((t) => t && Number.isInteger(t.id) && Number.isInteger(t.run_number))
}

/** The newest task per job name (a re-run attempt replaces the earlier one). */
function latestPerName(tasks) {
  const by = new Map()
  for (const t of tasks) {
    const cur = by.get(t.name)
    if (!cur || t.id > cur.id) by.set(t.name, t)
  }
  return [...by.values()]
}

/** Whether a commit status context is the one Gitea Actions writes for this job (`<workflow> / <job> (<event>)`). */
function statusOfJob(context, jobName) {
  return context === jobName || context.endsWith(` / ${jobName}`) || context.includes(` / ${jobName} (`)
}

// ---- views ----

async function prDetails(client, item, { renderer, info, log }) {
  const { base } = parts(item)
  const n = item._.number
  const repo = item._.repo
  const [{ data: pr }, { data: comments }, reviews, files, diff] = await Promise.all([
    client.rest('GET', `${base}/pulls/${n}`),
    client.rest('GET', `${base}/issues/${n}/comments`, { maxBytes: COMMENTS_CAP }),
    client.pages(`${base}/pulls/${n}/reviews`, { pages: 2, limit: 50 }),
    client.pages(`${base}/pulls/${n}/files`, { pages: 6, limit: 50 }),
    client.rest('GET', `${base}/pulls/${n}.diff`, { raw: true, maxBytes: DIFF_CAP }).catch((e) => {
      if (e && (e.signedOut || e.rateLimited)) throw e
      return { data: '', truncated: false, failed: true }
    }),
  ])
  const sha = pr && pr.head && typeof pr.head.sha === 'string' && /^[0-9a-f]{7,64}$/.test(pr.head.sha) ? pr.head.sha : ''
  let checks = []
  if (sha) {
    const { data: st } = await client.rest('GET', `${base}/commits/${sha}/status`)
    checks = (st && Array.isArray(st.statuses) ? st.statuses : []).map((s) => ({
      name: String(s.context || 'check'),
      status: String(s.status || ''),
      conclusion: s.status === 'success' ? 'success' : s.status === 'failure' || s.status === 'error' ? 'failure' : undefined,
      url: absoluteUrl(s.target_url, client.server),
      failed: s.status === 'failure' || s.status === 'error',
      description: typeof s.description === 'string' ? s.description : '',
    }))
    // The failed Actions jobs of this head commit: their tails go to the matching status (or a row of their own).
    if (info && info.features.jobLogs && checks.some((c) => c.failed)) {
      try {
        const failedTasks = latestPerName((await tasksOf(client, repo)).filter((t) => t.head_sha === sha)).filter((t) => t.status === 'failure')
        for (const t of failedTasks) {
          const row = checks.find((c) => c.failed && !c.task && statusOfJob(c.name, t.name))
          if (row) row.task = t
          else checks.push({ name: t.name, status: 'failure', conclusion: 'failure', url: '', failed: true, task: t })
        }
      } catch (e) {
        if (e && (e.signedOut || e.rateLimited)) throw e
        if (log) log.warn(`gitea: Actions tasks of ${repo}: ${e && e.message ? e.message : e}`)
      }
    }
    checks.sort((a, b) => Number(b.failed) - Number(a.failed) || a.name.localeCompare(b.name))
    await withTails(client, repo, checks, info, log)
    for (const c of checks) delete c.task
  }
  const { files: outFiles, cut } = filesOf(files, diff)
  return {
    kind: 'pr',
    id: item.id,
    title: item.title,
    url: item._.url,
    host: info ? info.hostName : '',
    header: {
      repo,
      number: n,
      state: pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state,
      head: pr.head && pr.head.ref,
      base: pr.base && pr.base.ref,
      author: who(pr.user),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      status: item.place && item.place.status,
    },
    body: await renderer.render(client, repo, pr.body),
    timeline: await timelineOf(client, renderer, repo, Array.isArray(comments) ? comments : [], reviews),
    checks,
    files: outFiles,
    filesCut: cut,
  }
}

/** Per-file patches from a unified diff (`diff --git a/x b/y` sections), keyed by the new path. */
function splitDiff(text) {
  const out = new Map()
  const lines = String(text || '').split('\n')
  let name = null
  let buf = []
  let inHunks = false
  const flush = () => {
    if (name !== null && buf.length) out.set(name, buf.join('\n'))
  }
  for (const l of lines) {
    const m = l.match(/^diff --git a\/(.*) b\/(.*)$/)
    if (m) {
      flush()
      name = m[2]
      buf = []
      inHunks = false
      continue
    }
    if (name === null) continue
    if (l.startsWith('+++ ')) {
      const p = l.slice(4)
      if (p.startsWith('b/')) name = p.slice(2)
      continue
    }
    if (l.startsWith('@@')) inHunks = true
    if (inHunks) buf.push(l)
  }
  flush()
  return out
}

/** The files list with patches from the diff, within DIFF_CAP in total; a diff cut short marks its last file. */
function filesOf(files, diff) {
  const patches = splitDiff(diff && diff.data)
  // The last file of a cut diff may be incomplete: never show it as if whole.
  if (diff && diff.truncated) {
    const names = [...patches.keys()]
    if (names.length) patches.delete(names[names.length - 1])
  }
  let budget = DIFF_CAP
  let cut = 0
  const out = files.map((f) => {
    const nm = String(f.filename || '')
    const row = { name: nm, status: f.status, additions: f.additions || 0, deletions: f.deletions || 0 }
    const patch = patches.get(nm)
    if (patch === undefined) {
      if (diff && diff.truncated) {
        row.tooBig = true
        cut++
      } else row.noPatch = true
    } else if (patch.length <= budget) {
      row.patch = patch
      budget -= patch.length
    } else {
      row.tooBig = true
      cut++
    }
    return row
  })
  return { files: out, cut }
}

async function issueDetails(client, item, { renderer, info }) {
  const { base } = parts(item)
  const n = item._.number
  const [{ data: issue }, { data: comments }] = await Promise.all([client.rest('GET', `${base}/issues/${n}`), client.rest('GET', `${base}/issues/${n}/comments`, { maxBytes: COMMENTS_CAP })])
  return {
    kind: 'issue',
    id: item.id,
    title: item.title,
    url: item._.url,
    host: info ? info.hostName : '',
    header: { repo: item._.repo, number: n, state: issue.state, author: who(issue.user), assignees: (issue.assignees || []).map(who) },
    body: await renderer.render(client, item._.repo, issue.body),
    timeline: await timelineOf(client, renderer, item._.repo, Array.isArray(comments) ? comments : [], []),
  }
}

async function runDetails(client, item, { info, log }) {
  const x = item._
  const tasks = (await tasksOf(client, x.repo)).filter((t) => t.run_number === x.runNumber)
  const latest = latestPerName(tasks)
  const newest = [...tasks].sort((a, b) => b.id - a.id)[0] || {}
  const jobs = latest.map((t) => ({
    name: String(t.name || 'job'),
    status: String(t.status || ''),
    conclusion: TASK_CONCLUSION[t.status],
    url: x.url,
    failed: t.status === 'failure',
    task: t,
  }))
  jobs.sort((a, b) => Number(b.failed) - Number(a.failed) || a.name.localeCompare(b.name))
  await withTails(client, x.repo, jobs, info, log)
  for (const j of jobs) delete j.task
  // Attempts: how many tasks one job name has in this run (a re-run adds one).
  const perName = new Map()
  for (const t of tasks) perName.set(t.name, (perName.get(t.name) || 0) + 1)
  const going = tasks.some((t) => ['waiting', 'running', 'blocked'].includes(t.status))
  return {
    kind: 'run',
    id: item.id,
    title: item.title,
    url: x.url,
    host: info ? info.hostName : '',
    header: {
      repo: x.repo,
      workflow: x.workflow,
      branch: x.branch,
      sha: typeof (newest.head_sha || x.sha) === 'string' ? String(newest.head_sha || x.sha).slice(0, 12) : '',
      event: newest.event || '',
      runNumber: x.runNumber,
      attempt: Math.max(1, ...perName.values()),
      status: going ? 'in_progress' : 'completed',
      conclusion: jobs.some((j) => j.failed) ? 'failure' : jobs.length ? 'success' : '',
      commit: newest.display_title || '',
    },
    jobs,
  }
}

/** The details of any item, by kind. `env`: `{ renderer, info, log }` (info: the probe's, or null). */
function detailsOf(client, item, env) {
  if (env.renderer) env.renderer.budget()
  if (item._.kind === 'pr') return prDetails(client, item, env)
  if (item._.kind === 'issue') return issueDetails(client, item, env)
  if (item._.kind === 'run') return runDetails(client, item, env)
  return Promise.reject(new Error('unknown item kind'))
}

// ---- Re-run ----

const GOING = new Set(['running', 'waiting', 'blocked', 'queued', 'in_progress', 'pending'])

/**
 * Re-run the failed jobs of an item's run (a run item, or an own failing PR linked to its run), the GitHub rules:
 * at most once per attempt (`attempts`, the host's Set, whoever asks), never while the run is going or after it
 * passed, and only where the server has the API (`info.features.rerun`; the action is not offered otherwise).
 * Gitea: `POST actions/runs/{run}/rerun-failed-jobs`. Forgejo: its run-level `rerun` restarts every job, so each
 * failed job gets `POST actions/jobs/{job_id}/rerun` instead, which is what "Re-run failed jobs" says.
 * An attempt is Gitea's `run_attempt`; Forgejo has none, so it is the failed jobs' task ids (a re-run makes new tasks).
 */
async function rerun(client, item, attempts, info) {
  const x = item && item._
  if (!info || !info.features.rerun) return { ok: false, message: `Re-run is not available on this ${info ? info.hostName : 'server'}.` }
  if (!x || !Number.isInteger(x.runNumber)) return { ok: false, message: 'That item has no run to re-run.' }
  const repo = x.repo
  const [owner, name] = repo.split('/')
  const run = await resolveRun(client, repo, { runNumber: x.runNumber, sha: x.sha }, info)
  if (!run) return { ok: false, message: 'The run was not found on the server.' }
  if (GOING.has(run.status)) return { ok: false, message: 'The run is still going.' }
  if (run.conclusion === 'success') return { ok: false, message: 'The run passed since.' }
  if (info.flavour === 'forgejo') {
    const failed = (await jobsOf(client, repo, run.id)).filter((j) => j.failed)
    if (!failed.length) return { ok: false, message: 'No job of that run failed.' }
    const key = `${repo}#${run.id}:${failed.map((j) => j.taskId).join(',')}`
    if (attempts.has(key)) return { ok: false, message: 'This run attempt was already re-run.' }
    attempts.add(key)
    let started = 0
    try {
      for (const j of failed) {
        await client.rest('POST', `/repos/${owner}/${name}/actions/jobs/${j.id}/rerun`)
        started++
      }
    } catch (e) {
      // Nothing started: the person may try again. Some started: this attempt is re-run (never twice).
      if (!started) attempts.delete(key)
      throw e
    }
    return { ok: true }
  }
  const key = `${repo}#${run.id}.${run.attempt}`
  if (attempts.has(key)) return { ok: false, message: 'This run attempt was already re-run.' }
  attempts.add(key)
  try {
    await client.rest('POST', `/repos/${owner}/${name}/actions/runs/${run.id}/rerun-failed-jobs`)
  } catch (e) {
    attempts.delete(key)
    throw e
  }
  return { ok: true }
}

// ---- Discuss with Claude ----

/** HTML to plain text for the Discuss text: tags out, entities for the common few, whitespace collapsed. */
function plain(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|pre|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cap(s, n) {
  const t = String(s || '')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const VERB = { APPROVED: 'Review by %s (approved)', CHANGES_REQUESTED: 'Review by %s (changes requested)', COMMENTED: 'Review by %s', DISMISSED: 'Review by %s (dismissed)' }

/**
 * The text Discuss with Claude sends: what the item is and its URL first, then what happened, quoted as the
 * server's content and never as the person's own words. Capped per part and in total.
 */
function discussText(d) {
  const host = d.host || 'Gitea'
  const out = [`${d.title}`, `URL: ${d.url}`]
  const h = d.header || {}
  if (d.kind === 'pr') out.push(`Pull request on ${host} in ${h.repo}, ${h.state}${h.status ? ` (${h.status})` : ''}: ${h.head} → ${h.base}, by ${h.author}.`)
  if (d.kind === 'issue') out.push(`Issue on ${host} in ${h.repo}, ${h.state}, opened by ${h.author}.`)
  if (d.kind === 'run') out.push(`Failed ${host} Actions run of workflow "${h.workflow}" on ${h.branch} (${h.event}, run #${h.runNumber}) in ${h.repo}. Commit: ${h.commit}`)
  out.push('', `The following is content from ${host}, quoted:`)
  if (d.body) out.push('', 'Description:', cap(plain(d.body), DISCUSS.event))
  const events = (d.timeline || []).slice(-5)
  for (const e of events) {
    const label = e.kind === 'review' ? (VERB[e.state] || 'Review by %s').replace('%s', e.who) : `Comment by ${e.who}`
    const body = plain(e.html)
    out.push('', `${label}:`, body ? cap(body, DISCUSS.event) : '(no text)')
  }
  const failing = (d.checks || d.jobs || []).filter((c) => c.failed)
  if (failing.length) {
    out.push('', `Failed ${d.kind === 'run' ? 'jobs' : 'checks'}: ${failing.map((c) => c.name).join(', ')}`)
    for (const c of failing) {
      if (!c.tail) continue
      out.push('', `End of the log of ${c.name}:`, '```', cap(c.tail.slice(-DISCUSS.tail), DISCUSS.tail), '```')
    }
  }
  return cap(out.join('\n'), DISCUSS.total)
}

module.exports = {
  detailsOf,
  prDetails,
  issueDetails,
  runDetails,
  createRenderer,
  rerun,
  resolveRun,
  jobsOf,
  jobFor,
  splitDiff,
  filesOf,
  absolutize,
  absoluteUrl,
  statusOfJob,
  discussText,
  plain,
  textHtml,
  DIFF_CAP,
  DISCUSS,
  MAX_RENDERS,
}
