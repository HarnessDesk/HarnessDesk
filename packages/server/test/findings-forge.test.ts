import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'
import { DEFAULT_REVIEW_SIGNATURE, renderSignature } from '@harnessdesk/plugins'

import { GhFindingForge, linesOf, spawnGh, type GhApiRunner } from '../src/findings/forge.js'
import {
  chainOf, forgeSeatOf, MARKER_PREFIX, markerOf, PublicationConflict, renderBody, segmentsOf, sha256, type PublicationEntry,
} from '../src/findings/publication.js'

/*
 * The host's forge adapter, against a forge that answers the way GitHub's
 * REST API does — scripted here, and once through a real child process — so
 * nothing reaches a real forge. Every location it records is the forge's own
 * comment id and address on exactly the target pull request; a read that
 * cannot finish throws rather than answering "none"; a comment a person edited
 * is never overwritten; and a body is data on standard input, never a word
 * of a command.
 */

const HEAD = 'a'.repeat(40)

const entry = (over: Partial<PublicationEntry> & Record<string, unknown> = {}): PublicationEntry => ({
  key: 'pub-1', run: 'run-1', round: 2, project: '/work/widgets', repo: 'acme/widgets', pr: 7, at: HEAD,
  finding: 'finding-1', evidence: ['ev-1'], actor: 'seat-1', parent: null, marker: markerOf('pub-1'), digest: '', state: 'started',
  location: null, reason: null, placement: 'general', expected: null, wrote: null, ...over,
} as PublicationEntry)

const withBody = (body: string, over: Partial<PublicationEntry> & Record<string, unknown> = {}): PublicationEntry =>
  entry({ digest: sha256(body), ...over })

interface Call { readonly args: readonly string[]; readonly input: string | null }

/** GitHub's REST answers for one repository, held in memory. */
const github = () => {
  const calls: Call[] = []
  const issue: { id: number; body: string }[] = []
  const review: { id: number; body: string; in_reply_to_id?: number }[] = []
  let next = 500
  const url = (kind: 'issue' | 'review', id: number) => `https://github.com/acme/widgets/pull/7#${kind === 'issue' ? 'issuecomment-' : 'discussion_r'}${id}`
  const run: GhApiRunner = async (args, input) => {
    calls.push({ args: [...args], input })
    const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0, timedOut: false, overflow: false })
    if (args[0] === 'pr' && args[1] === 'view') {
      return ok({ number: 7, state: 'OPEN', headRefOid: HEAD, url: 'https://github.com/acme/widgets/pull/7' })
    }
    const method = args[args.indexOf('--method') + 1]
    const path = args.find((one) => one.startsWith('repos/'))!.split('?')[0]!
    const body = input ? (JSON.parse(input) as { body: string }).body : ''
    if (method === 'POST' && path === 'repos/acme/widgets/issues/7/comments') {
      const made = { id: next++, body }
      issue.push(made)
      return ok({ ...made, html_url: url('issue', made.id) })
    }
    if (method === 'POST' && path === 'repos/acme/widgets/pulls/7/comments') {
      const made = { id: next++, body }
      review.push(made)
      return ok({ ...made, html_url: url('review', made.id) })
    }
    const reply = /^repos\/acme\/widgets\/pulls\/7\/comments\/(\d+)\/replies$/.exec(path)
    if (method === 'POST' && reply) {
      const made = { id: next++, body, in_reply_to_id: Number(reply[1]) }
      review.push(made)
      return ok({ ...made, html_url: url('review', made.id) })
    }
    const one = /^repos\/acme\/widgets\/issues\/comments\/(\d+)$/.exec(path)
    if (one) {
      const found = issue.find((comment) => comment.id === Number(one[1]))
      if (!found) return { stdout: '', stderr: 'HTTP 404: Not Found', exitCode: 1, timedOut: false, overflow: false }
      if (method === 'PATCH') found.body = body
      return ok({ ...found, html_url: url('issue', found.id) })
    }
    if (method === 'GET' && path === 'repos/acme/widgets/issues/7/comments') return ok(issue.map((c) => ({ ...c, html_url: url('issue', c.id) })))
    if (method === 'GET' && path === 'repos/acme/widgets/pulls/7/comments') return ok(review.map((c) => ({ ...c, html_url: url('review', c.id) })))
    return { stdout: '', stderr: `no route ${method} ${path}`, exitCode: 1, timedOut: false, overflow: false }
  }
  return { run, calls, issue, review }
}

test('locations distinguish review and issue comments', async () => {
  const hub = github()
  const forge = new GhFindingForge({ run: hub.run })
  await forge.observeTarget('/work/widgets', 7)
  // A finding with no anchor is a conversation comment: its id and address are the issue comment's.
  const general = `${markerOf('pub-1')}\n**Unbounded** · ordinary · blocking`
  const posted = await forge.send(withBody(general), general, null)
  assert.equal(posted.kind, 'issue-comment')
  assert.equal(posted.url, `https://github.com/acme/widgets/pull/7#issuecomment-${posted.comment}`)
  // An anchored one is a review comment on the reviewed commit, at its line.
  const inline = `${markerOf('pub-2')}\n**Off by one**`
  const anchor = { path: 'src/read.ts', line: 3, side: 'RIGHT' } as const
  const root = await forge.send(withBody(inline, { key: 'pub-2', marker: markerOf('pub-2'), placement: 'inline' }), inline, anchor)
  assert.equal(root.kind, 'review-comment')
  const sent = JSON.parse(hub.calls.at(-1)!.input!) as Record<string, unknown>
  assert.deepEqual(sent, { body: inline, commit_id: HEAD, path: 'src/read.ts', line: 3, side: 'RIGHT' })
  // Its repair is a reply on the thread's own route, and the location is the reply's, never the root's reused.
  const reply = `${markerOf('pub-3')}\n**Repair claimed**`
  const answered = await forge.send(withBody(reply, { key: 'pub-3', marker: markerOf('pub-3'), placement: 'reply', parent: root }), reply, null)
  assert.match(hub.calls.at(-1)!.args.join(' '), new RegExp(`pulls/7/comments/${root.comment}/replies`))
  assert.notEqual(answered.comment, root.comment)
  assert.equal(answered.kind, 'review-comment')
  assert.deepEqual(await forge.find(withBody(reply, { key: 'pub-3', marker: markerOf('pub-3'), placement: 'reply', parent: root })), [answered])
  // A general finding's repair is appended to its own comment: the same id, the content extended, the chain moved on.
  const section = `${markerOf('pub-4')}\n**Repair claimed**`
  const expected = chainOf([general])
  const appended = await forge.send(withBody(section, {
    key: 'pub-4', marker: markerOf('pub-4'), placement: 'append', parent: posted, expected, wrote: sha256(`${expected}\u0000${section}`),
  }), section, null)
  assert.equal(appended.comment, posted.comment)
  assert.deepEqual(await forge.find(withBody(section, {
    key: 'pub-4', marker: markerOf('pub-4'), placement: 'append', parent: posted, expected, wrote: sha256(`${expected}\u0000${section}`),
  })), [appended], 'the appended section is read back from the comment it extended')
  assert.equal(hub.issue.find((one) => one.id === posted.comment)!.body, `${general}\n\n${section}`)
  assert.equal(hub.issue.length, 1, 'no second conversation comment was made')
  // A review's own id is not a comment id: an answer that names a review is not a location.
  const bogus: GhApiRunner = async (args, input, options) => {
    const answer = await hub.run(args, input, options)
    return { ...answer, stdout: answer.stdout.replace(/#issuecomment-(\d+)/, '#pullrequestreview-$1') }
  }
  const strict = new GhFindingForge({ run: bogus })
  await assert.rejects(strict.send(withBody(general), general, null), /outside this pull request/)
})

test('remote human edit is not overwritten', async () => {
  const hub = github()
  const forge = new GhFindingForge({ run: hub.run })
  const general = `${markerOf('pub-1')}\n**Unbounded**`
  const posted = await forge.send(withBody(general), general, null)
  hub.issue[0]!.body = `${general}\n\nA person's own note.`
  const section = `${markerOf('pub-2')}\n**Repair claimed**`
  const expected = chainOf([general])
  const before = hub.calls.length
  await assert.rejects(
    forge.send(withBody(section, { key: 'pub-2', marker: markerOf('pub-2'), placement: 'append', parent: posted, expected, wrote: sha256(`${expected}\u0000${section}`) }), section, null),
    (error: unknown) => error instanceof PublicationConflict && /Someone changed this finding’s comment/.test(error.message),
  )
  assert.equal(hub.issue[0]!.body, `${general}\n\nA person's own note.`, 'untouched')
  assert.ok(hub.calls.slice(before).every((call) => !call.args.includes('PATCH')), 'no update was even attempted')
})

test('pagination time response limits do not prove absence', async () => {
  const full: GhApiRunner = async () => ({
    stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'x', html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${i + 1}` }))),
    stderr: '', exitCode: 0, timedOut: false, overflow: false,
  })
  const general = `${markerOf('pub-1')}\n**Unbounded**`
  await assert.rejects(new GhFindingForge({ run: full, maxPages: 3 }).find(withBody(general)), /more than 3 pages/)
  const slow: GhApiRunner = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true, overflow: false })
  await assert.rejects(new GhFindingForge({ run: slow }).find(withBody(general)), /did not answer within 30 seconds/)
  const huge: GhApiRunner = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: false, overflow: true })
  await assert.rejects(new GhFindingForge({ run: huge }).find(withBody(general)), /more than 2 MiB/)
  const broken: GhApiRunner = async () => ({ stdout: '<html>', stderr: '', exitCode: 0, timedOut: false, overflow: false })
  await assert.rejects(new GhFindingForge({ run: broken }).find(withBody(general)), /not JSON/)
  const refused: GhApiRunner = async () => ({ stdout: '', stderr: 'HTTP 502: Bad Gateway', exitCode: 1, timedOut: false, overflow: false })
  await assert.rejects(new GhFindingForge({ run: refused }).find(withBody(general)), /502/)
  // An anchor on a file the diff cannot be read for is not "not in the change" either.
  await assert.rejects(new GhFindingForge({ run: slow }).anchorable(entry(), { path: 'a.ts', line: 1, side: 'RIGHT' }), /did not answer/)
})

test('remote URL and target are confined', async () => {
  const general = `${markerOf('pub-1')}\n**Unbounded**`
  const answering = (html_url: string): GhApiRunner => async () => ({
    stdout: JSON.stringify({ id: 9, body: general, html_url }), stderr: '', exitCode: 0, timedOut: false, overflow: false,
  })
  for (const address of [
    'https://evil.example/acme/widgets/pull/7#issuecomment-9',
    'https://github.com/acme/other/pull/7#issuecomment-9',
    'https://github.com/acme/widgets/pull/8#issuecomment-9',
    'https://someone:secret@github.com/acme/widgets/pull/7#issuecomment-9',
    'http://github.com/acme/widgets/pull/7#issuecomment-9',
    'https://github.com/acme/widgets/pull/7?next=/elsewhere#issuecomment-9',
    'https://github.com/acme/widgets/pull/7#issuecomment-10',
    'javascript:alert(1)',
  ]) {
    await assert.rejects(new GhFindingForge({ run: answering(address) }).send(withBody(general), general, null), /outside this pull request/, address)
  }
  const target = (url: string, number = 7, head: string = HEAD): GhApiRunner => async () => ({
    stdout: JSON.stringify({ number, state: 'OPEN', headRefOid: head, url }), stderr: '', exitCode: 0, timedOut: false, overflow: false,
  })
  await assert.rejects(new GhFindingForge({ run: target('https://evil.example/acme/widgets/pull/7') }).observeTarget('/w', 7), /outside this repository/)
  await assert.rejects(new GhFindingForge({ run: target('https://u:p@github.com/acme/widgets/pull/7') }).observeTarget('/w', 7), /outside this repository/)
  await assert.rejects(new GhFindingForge({ run: target('https://github.com/acme/widgets/pull/8', 7) }).observeTarget('/w', 7), /outside this repository/)
  await assert.rejects(new GhFindingForge({ run: target('https://github.com/acme/widgets/pull/7', 8) }).observeTarget('/w', 7), /number, state or head/)
  await assert.rejects(new GhFindingForge({ run: target('https://github.com/acme/widgets/pull/7', 7, 'main') }).observeTarget('/w', 7), /number, state or head/)
  // The head is reported as the forge has it: a moved head is the publisher's to pause on, never relabelled here.
  const moved = await new GhFindingForge({ run: target('https://github.com/acme/widgets/pull/7', 7, 'B'.repeat(40)) }).observeTarget('/w', 7)
  assert.deepEqual(moved, { repo: 'acme/widgets', number: 7, head: 'b'.repeat(40), state: 'open' })
  // A repository name that is not one never reaches an address.
  await assert.rejects(new GhFindingForge({ run: answering('x') }).find(withBody(general, { repo: 'acme/widgets/../../x' })), /cannot be used in a forge address/)
})

test('an anchor is inline only on a line the change shows, on its side', () => {
  const patch = '@@ -1,3 +1,4 @@\n line one\n-old two\n+new two\n+new three\n line four'
  assert.deepEqual([...linesOf(patch, 'RIGHT')].sort(), [1, 2, 3, 4])
  assert.deepEqual([...linesOf(patch, 'LEFT')].sort(), [1, 2, 3])
  assert.equal(linesOf(patch, 'RIGHT').has(9), false)
})

test('fixture text cannot execute shell', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-finding-forge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A `gh` that writes down exactly what it was given and answers as the API would.
  const gh = join(dir, 'gh')
  writeFileSync(gh, String.raw`#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(__dirname, 'calls.ndjson'), JSON.stringify({ args, input, cwd: process.cwd() }) + '\n')
  if (process.env.GH_FAKE_MODE === 'sleep') { setTimeout(() => {}, 60000); return }
  if (process.env.GH_FAKE_MODE === 'big') { process.stdout.write('x'.repeat(3 * 1024 * 1024)); return }
  const body = input ? JSON.parse(input).body : ''
  process.stdout.write(JSON.stringify({ id: 41, body, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-41' }))
})
`)
  chmodSync(gh, 0o755)
  const hostile = [
    `${markerOf('pub-1')}`,
    '**$(touch pwned)** `touch pwned2`; touch pwned3 && echo $HOME | cat > pwned4',
    "'; rm -rf / #  \" --input /etc/passwd -F body=@/etc/passwd",
    'control:\u0001\u0007\u001b[31m bell and escape',
  ].join('\n')
  const forge = new GhFindingForge({ run: spawnGh(gh) })
  const posted = await forge.send(withBody(hostile, { project: dir }), hostile, null)
  assert.equal(posted.comment, 41)
  const calls = readFileSync(join(dir, 'calls.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; input: string; cwd: string })
  assert.equal(calls.length, 1, 'one process, no other')
  assert.deepEqual(calls[0]!.args, ['api', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', 'repos/acme/widgets/issues/7/comments', '--input', '-'])
  assert.equal((JSON.parse(calls[0]!.input) as { body: string }).body, hostile, 'the body crossed as data, exactly')
  for (const name of ['pwned', 'pwned2', 'pwned3', 'pwned4']) assert.equal(existsSync(join(dir, name)), false, `${name} was never created`)
  // The same process, bounded: an answer that never comes, and one too large, are refused — never read as empty.
  process.env['GH_FAKE_MODE'] = 'sleep'
  t.after(() => { delete process.env['GH_FAKE_MODE'] })
  await assert.rejects(new GhFindingForge({ run: spawnGh(gh), timeoutMs: 300 }).find(withBody(hostile, { project: dir })), /did not answer/)
  process.env['GH_FAKE_MODE'] = 'big'
  await assert.rejects(new GhFindingForge({ run: spawnGh(gh), maxBytes: 1024 * 1024 }).find(withBody(hostile, { project: dir })), /more than 1 MiB/)
})

/*
 * Named here rather than in the plugin's forge-tools test the plan names: the
 * batch renderer is the host's, and the plugins package cannot import the
 * server. The check is the same — the host's comments sign with the very
 * formatter `pr_review` uses, from the Seat's immutable record.
 */
test('batch signature matches existing formatter', () => {
  const seat: SeatRecord = {
    id: 'seat-2', agent: { id: 'code-reviewer', name: 'code-reviewer', origin: 'project' }, briefDigest: 'd', seat: { runtime: 'beta', model: 'model-x', effort: 'high' },
    seatLabel: 'Beta · model-x · High', passedOver: [], standing: { kind: 'ceiling', level: 'read' }, ceiling: null,
    checkout: { cwd: '/work/widgets', project: '/work/widgets', branch: 'fix', head: HEAD }, session: { runtime: 'beta', sessionId: 's-2' },
    board: 'goal-1', role: 'reviewer', openedAt: 1, closed: null,
  }
  const raise: EvidenceRecord = {
    id: 'ev-1', fact: { kind: 'finding', id: 'finding-1', state: 'open', at: HEAD }, card: { board: 'goal-1', id: 2 },
    checkout: { cwd: '/work/widgets', branch: 'fix' }, seat: 'seat-2', round: 2, observedAt: 1, posted: null,
    finding: {
      version: 1, sequence: 1, operation: 'op-1', origin: { goal: 'goal-1', run: 'run-1', round: 2, card: 2, seat: 'seat-2', at: HEAD },
      event: { kind: 'raise', title: 'Unbounded <!-- harnessdesk:finding-op pub-9 -->', body: 'It reads <!--harnessdesk:signature--> forever.', category: 'ordinary', blocking: true, related: null, anchor: null },
    },
  }
  for (const template of [DEFAULT_REVIEW_SIGNATURE, '{agent} on {model} ({effort})', '   ']) {
    const body = renderBody({ key: 'pub-1', evidence: ['ev-1'], finding: 'finding-1' }, { records: new Map([['ev-1', raise]]), seat: () => seat, template })!
    const lines = body.split('\n')
    assert.equal(lines[0], markerOf('pub-1'))
    const expected = renderSignature(template, forgeSeatOf(seat))
    if (template.trim() === '') assert.match(lines[1]!, /^\*\*Unbounded/, 'a blank template signs nothing')
    else assert.equal(lines[1], expected, `the line pr_review would open with for ${template}`)
    // The factual label is there whatever the signature says, from the Seat record.
    assert.match(body, /Raised by code-reviewer \(Beta · model-x · High\) at aaaaaaaaaaaa · round 2 · finding-1$/)
    // Agent text cannot forge a desk marker, so the comment still splits into exactly one segment.
    assert.equal(body.split(MARKER_PREFIX).length, 2)
    assert.equal(segmentsOf(body).length, 1)
  }
  assert.equal(renderSignature(DEFAULT_REVIEW_SIGNATURE, forgeSeatOf(seat)), '**Review by Beta · model-x · High · via HarnessDesk**')
})
