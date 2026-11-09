'use strict'
// failedStepTail tests copied from cc-cockpit-github test/logs.test.js (keep in step); the fetching ones are new.
const test = require('node:test')
const assert = require('node:assert/strict')
const { failedStepTail, jobLogTail, clean, MAX_LINES, TAIL_BYTES } = require('../dist/lib/logs')
const { createClient, createBinding } = require('../dist/lib/client')
const { parseServer } = require('../dist/lib/settings')
const { fakeServer, memStore, text, BASE, TOKEN } = require('./fakes')

const stamp = (s) => `2026-11-08T10:00:00.1234567Z ${s}`
const quiet = { info() {}, warn() {}, error() {} }

test('clean: timestamps, colour codes and control characters out; tabs kept', () => {
  assert.equal(clean(stamp('\x1b[31mFAIL\x1b[0m\ttest/a.js')), 'FAIL\ttest/a.js')
  assert.equal(clean('\x1b]8;;https://x\x07link\x1b]8;;\x07 \x07bell'), 'link bell')
})

test('the failed step: from its ##[group] to the last ##[error]', () => {
  const log = [
    stamp('##[group]Run actions/checkout'),
    stamp('checked out'),
    stamp('##[endgroup]'),
    stamp('##[group]Run npm test'),
    stamp('> jest'),
    stamp('FAIL src/a.test.js'),
    stamp('##[endgroup]'),
    stamp('##[error]Process completed with exit code 1.'),
    stamp('##[group]Post job cleanup'),
    stamp('cleanup'),
    '',
  ].join('\n')
  assert.deepEqual(failedStepTail(log).text.split('\n'), ['##[group]Run npm test', '> jest', 'FAIL src/a.test.js', '##[endgroup]', '##[error]Process completed with exit code 1.'])
})

test('the raw ::group:: / ::error forms count too', () => {
  const log = ['::group::Run lint', 'ok', '::endgroup::', '::group::Run test', 'boom', '::error file=a.js::failed'].join('\n')
  assert.deepEqual(failedStepTail(log).text.split('\n'), ['::group::Run test', 'boom', '::error file=a.js::failed'])
})

test('no error marker: the last 200 lines; a long step is cut to its last 200 lines', () => {
  const lines = Array.from({ length: 500 }, (_, i) => stamp(`line ${i}`))
  const r = failedStepTail(lines.join('\n'))
  assert.equal(r.lines, MAX_LINES)
  assert.equal(r.text.split('\n')[0], 'line 300')
  const step = [stamp('##[group]Run build'), ...lines, stamp('##[error]boom')].join('\n')
  const s = failedStepTail(step)
  assert.equal(s.lines, MAX_LINES)
  assert.ok(s.text.endsWith('##[error]boom'))
})

test('a tail read drops its first, possibly cut, line', () => {
  assert.equal(failedStepTail('tial line\nfull line\nlast', { partial: true }).text, 'full line\nlast')
  assert.equal(failedStepTail('only', { partial: true }).text, 'only')
  assert.equal(failedStepTail('').text, '')
})

function clientFor(routes, other) {
  const srv = fakeServer({ routes, other })
  return { srv, client: createClient({ fetch: srv.fetch, server: parseServer(BASE).server, token: TOKEN, binding: createBinding({ store: memStore(), log: quiet }), log: quiet }) }
}

test('jobLogTail: by job id, the last 64 KiB of a server that ignores Range', async () => {
  const big = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n')
  const { srv, client } = clientFor([['GET', '/repos/acme/widgets/actions/jobs/31/logs', () => text(big)]])
  const r = await jobLogTail(client, 'acme/widgets', 31)
  assert.equal(r.lines, MAX_LINES)
  assert.ok(r.text.endsWith('line 19999'))
  assert.ok(big.length > TAIL_BYTES)
  assert.equal(new URL(srv.calls[0].url).pathname, '/api/v1/repos/acme/widgets/actions/jobs/31/logs')
  await assert.rejects(jobLogTail(client, 'acme/widgets', '31'), /not a job id/)
  await assert.rejects(jobLogTail(client, 'acme/widgets', 0), /not a job id/)
})

test('jobLogTail: a redirect to object storage is followed without the token, https only', async () => {
  let blobAuth = 'unset'
  const { client } = clientFor(
    [['GET', '/repos/acme/widgets/actions/jobs/31/logs', () => new Response(null, { status: 302, headers: { location: 'https://blobs.example.com/log?sig=1' } })]],
    (u, init, headers) => {
      blobAuth = headers.get('authorization')
      return text('##[group]Run x\n##[error]bad')
    }
  )
  assert.equal((await jobLogTail(client, 'acme/widgets', 31)).text, '##[group]Run x\n##[error]bad')
  assert.equal(blobAuth, null)
  const plain = clientFor([['GET', '/repos/acme/widgets/actions/jobs/31/logs', () => new Response(null, { status: 302, headers: { location: 'http://blobs.example.com/log' } })]])
  await assert.rejects(jobLogTail(plain.client, 'acme/widgets', 31), /non-https/)
})
