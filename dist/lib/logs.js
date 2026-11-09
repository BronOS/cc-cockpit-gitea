'use strict'
// The end of a failed job's log: what a person (or Claude) needs to see why it failed. Adapted from
// cc-cockpit-github's logs.js (`failedStepTail` kept, keep in step); the fetching is new: Gitea and Forgejo serve a
// job's log at `actions/jobs/{job_id}/logs`, and client.tail reads it as a stream keeping the last 64 KiB (a server
// may ignore Range), following a redirect to object storage without the token.
//
// The runner (act_runner, forgejo-runner) writes GitHub's workflow commands: a step's output can carry `##[group]` /
// `##[error]` or the raw `::group::` / `::error` forms, so both count. A log with neither keeps its last lines.

const TAIL_BYTES = 64 * 1024
const MAX_LINES = 200

// A timestamp prefix per line (ISO, as the runners write it).
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
// CSI and OSC escape sequences, then any other control character but tab.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const IS_ERROR = /^(##\[error\]|::error\b)/
const IS_GROUP = /^(##\[group\]|::group::)/

function clean(line) {
  return line.replace(STAMP, '').replace(ANSI, '').replace(CONTROL, '')
}

/**
 * `{ text, lines }` of the failed step's tail. `partial`: the text starts mid-log (a tail read), so its first line
 * may be cut and is dropped.
 */
function failedStepTail(raw, { partial = false } = {}) {
  let lines = String(raw || '').split(/\r?\n/)
  if (partial && lines.length > 1) lines = lines.slice(1)
  lines = lines.map(clean)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  let lastError = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (IS_ERROR.test(lines[i])) {
      lastError = i
      break
    }
  }
  let section = lines
  if (lastError >= 0) {
    let start = 0
    for (let i = lastError; i >= 0; i--) {
      if (IS_GROUP.test(lines[i])) {
        start = i
        break
      }
    }
    section = lines.slice(start, lastError + 1)
  }
  const tail = section.slice(-MAX_LINES)
  return { text: tail.join('\n'), lines: tail.length }
}

/** The failed step's tail of one job's log, by JOB id (never a task id). `{ text, lines }`; rejects as the client does. */
async function jobLogTail(client, repo, jobId) {
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('not a job id')
  const [owner, name] = repo.split('/')
  const { text, truncated } = await client.tail(`/repos/${owner}/${name}/actions/jobs/${jobId}/logs`, { keep: TAIL_BYTES })
  return failedStepTail(text, { partial: truncated })
}

module.exports = { failedStepTail, jobLogTail, clean, TAIL_BYTES, MAX_LINES }
