'use strict'
// Failed CI runs, from `/repos/{o}/{r}/actions/tasks`: the one Actions list every Gitea and Forgejo version has
// (1.23 included; the runs list came later). A task is one attempt of one job, with no actor, so:
//   - "yours" means its `head_sha` is the head commit of one of your open PRs in that repo (the poll already has
//     those). The branch name is used only for a task that carries no sha: a `pull_request` event's branch is
//     Gitea's pretty ref, and a fork's PR can share your branch name (plan review, finding 6).
//   - a failure is superseded by a later success of the same job: key workflow file + job name + branch. Another
//     job of the same workflow passing says nothing about this one.
//   - the item is the run (`run_number`), not the task: `run:o/r/<run_number>` stays the same across re-run attempts,
//     as the convention's run id does; its `rev` is the newest failed task id, so a re-run that fails again is new.
//   - 7 days at most, as on GitHub.
// Actions is switched on per repo: a 404/403 on one repo skips that repo alone (remembered until `forget`), never
// the lane (plan review, finding 5).

const { isExcluded } = require('./settings')
const { line, CAP } = require('./model')

const DAY = 864e5
const WINDOW = 7 * DAY
const MAX_REPOS = 10
const ACTIVE = new Set(['waiting', 'running', 'blocked', 'queued', 'pending'])
const FAILED = new Set(['failure'])

function ms(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** The repos to ask: those of the person's open PRs, excluded ones out, at most 10, no duplicates. */
function repoSet(prRepos, settings) {
  const out = []
  const seen = new Set()
  for (const full of prRepos) {
    if (typeof full !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(full) || isExcluded(full, settings)) continue
    const k = full.toLowerCase()
    if (seen.has(k) || out.length >= MAX_REPOS) continue
    seen.add(k)
    out.push(full)
  }
  return out
}

const stops = (e) => e && (e.signedOut || e.rateLimited || e.network)

/**
 * `{ failedRuns(client, prs, now), forget() }`. `prs`: the person's open PR items (`_.repo`, `_.sha`, `_.head`).
 * `failedRuns` → `{ runs, failures, answered }`: `runs` one entry per failed run (grouped tasks), `failures` every
 * failed task of the person's PR heads (to link a PR to its run), `answered` the repos whose tasks list answered
 * (Actions on: probe.learnRuns can use one).
 */
function createRuns({ log }) {
  const skipped = new Set() // repos whose actions/tasks answered 404/403 (Actions off there)

  async function tasksOf(client, full) {
    const [owner, repo] = full.split('/')
    return client.pages(`/repos/${owner}/${repo}/actions/tasks`, { key: 'workflow_runs', pages: 2, limit: 50 })
  }

  async function failedRuns(client, prs, now, settings) {
    const byRepo = new Map()
    for (const it of prs) {
      if (!it || !it._ || it._.kind !== 'pr') continue
      const k = it._.repo
      if (!byRepo.has(k)) byRepo.set(k, { shas: new Set(), heads: new Set() })
      if (it._.sha) byRepo.get(k).shas.add(it._.sha)
      if (it._.head) byRepo.get(k).heads.add(it._.head)
    }
    const runs = []
    const failures = []
    const answered = []
    for (const full of repoSet([...byRepo.keys()], settings)) {
      if (skipped.has(full)) continue
      let tasks
      try {
        tasks = await tasksOf(client, full)
      } catch (e) {
        if (stops(e)) throw e
        if (e && (e.status === 404 || e.status === 403)) {
          skipped.add(full)
          log.info(`gitea: ${full} has no Actions (or they are off): its runs are skipped`)
        } else log.warn(`gitea: failed runs of ${full}: ${e && e.message ? e.message : e}`)
        continue
      }
      answered.push(full)
      const pr = byRepo.get(full)
      const mine = tasks.filter((t) => {
        if (!t || !Number.isInteger(t.id) || !Number.isInteger(t.run_number)) return false
        if (now - (ms(t.created_at) || ms(t.updated_at)) > WINDOW) return false
        if (t.head_sha) return pr.shas.has(t.head_sha)
        return !!t.head_branch && pr.heads.has(t.head_branch)
      })
      // The newest task per job key; a failure counts while no later success of the same key exists.
      const key = (t) => `${t.workflow_id}\u0000${t.name}\u0000${t.head_branch}`
      const failedKept = []
      const latest = new Map()
      for (const t of mine) {
        const cur = latest.get(key(t))
        if (!cur || ms(t.created_at) > ms(cur.created_at) || (ms(t.created_at) === ms(cur.created_at) && t.id > cur.id)) latest.set(key(t), t)
      }
      for (const t of mine) {
        if (!FAILED.has(t.status)) continue
        failures.push({ ...t, _repo: full })
        if (latest.get(key(t)) === t) failedKept.push(t)
      }
      // Group what is left by run.
      const byRun = new Map()
      for (const t of failedKept) {
        if (!byRun.has(t.run_number)) byRun.set(t.run_number, [])
        byRun.get(t.run_number).push(t)
      }
      for (const [runNumber, failed] of byRun) {
        const all = tasks.filter((t) => t && t.run_number === runNumber)
        runs.push({ repo: full, runNumber, failed, active: all.some((t) => ACTIVE.has(t.status)) })
      }
    }
    return { runs, failures, answered }
  }

  return {
    failedRuns,
    /** Ask the skipped repos again (after a probe refresh or a settings change). */
    forget() {
      skipped.clear()
    },
    get skipped() {
      return [...skipped]
    },
  }
}

/**
 * The web page of a run on the configured server: the task's own `url` when its path is a run page of this repo
 * (rebased onto the base: the server writes it from its ROOT_URL), else `<base>/<repo>/actions/runs/<n>`.
 */
function runUrl(base, run) {
  const t = [...run.failed].sort((a, b) => b.id - a.id)[0]
  try {
    const u = new URL(t.url)
    const m = u.pathname.match(/\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(\/jobs\/\d+)?$/)
    if (m && m[1].toLowerCase() === run.repo.toLowerCase()) return `${base}/${m[1]}/actions/runs/${m[2]}${m[3] || ''}`
  } catch {
    // no usable url: build it
  }
  return `${base}/${run.repo}/actions/runs/${run.runNumber}`
}

const workflowName = (id) => (typeof id === 'string' && id ? id.replace(/\.ya?ml$/i, '') : 'workflow')

/** A failed run (from failedRuns) to an item. */
function runItem(run, base) {
  const first = [...run.failed].sort((a, b) => b.id - a.id)[0]
  const workflow = workflowName(first.workflow_id)
  const branch = first.head_branch || 'unknown branch'
  const labels = ['run', 'ci:failed']
  const repo = `repo:${run.repo.toLowerCase()}`
  if (repo.length <= CAP.label) labels.push(repo)
  const owner = `owner:${run.repo.split('/')[0].toLowerCase()}`
  if (owner.length <= CAP.label) labels.push(owner)
  const jobs = [...new Set(run.failed.map((t) => t.name).filter(Boolean))]
  const what = first.display_title ? ` · ${first.display_title}` : ''
  return {
    id: `run:${run.repo}/${run.runNumber}`,
    rev: `run:${first.id}`,
    title: line(`${run.repo} CI failed: ${workflow} on ${branch}`, CAP.title),
    preview: line(`Run #${run.runNumber} failed${jobs.length ? ` (${jobs.join(', ')})` : ''}${first.event ? ` · ${first.event}` : ''}${what}`, CAP.preview),
    time: Math.max(...run.failed.map((t) => ms(t.updated_at) || ms(t.created_at))) || 1,
    read: false,
    place: { kind: 'project', name: line(run.repo, CAP.place), status: 'failing' },
    labels,
    actions: [],
    _: {
      kind: 'run',
      url: runUrl(base, run),
      lanes: ['failedRuns'],
      repo: run.repo,
      runNumber: run.runNumber,
      taskId: first.id,
      jobs,
      workflow,
      workflowId: first.workflow_id,
      branch,
      sha: first.head_sha || '',
      status: run.active ? 'in_progress' : 'completed',
    },
  }
}

/** Give each failing own PR the run number of its head commit's newest failed task, so Re-run works from the PR. */
function linkPrRuns(items, failures, runs) {
  for (const it of items) {
    if (it._.kind !== 'pr' || !it.labels.includes('ci:failed') || !it.labels.includes('my-pr') || !it._.sha) continue
    const t = failures
      .filter((f) => f.head_sha === it._.sha && f._repo.toLowerCase() === it._.repo.toLowerCase())
      .sort((a, b) => b.id - a.id)[0]
    if (!t) continue
    it._.runNumber = t.run_number
    const run = (runs || []).find((r) => r.repo.toLowerCase() === it._.repo.toLowerCase() && r.runNumber === t.run_number)
    it._.runStatus = run && run.active ? 'in_progress' : 'completed'
  }
}

module.exports = { createRuns, repoSet, runItem, runUrl, linkPrRuns, MAX_REPOS, WINDOW }
