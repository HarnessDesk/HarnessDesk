import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TriggerArmPreview, TriggerHistoryPage } from '@harnessdesk/protocol'

import { makeRepo } from './fixtures/evidence-desk.js'
import { commitTriggers, intakeDesk, type IntakeDesk } from './fixtures/intake-host.js'
import { sha } from './fixtures/intake-forge.js'

/*
 * Whose comment fires a trigger is the project's to say (`from`), and the
 * desk's own posts never fire one whatever it says (owner decisions,
 * 2026-09-24). Authors are compared by the forge's stable account id; one
 * that cannot be read, or whose permission cannot be read, never fires.
 */

const E2E = { timeout: 120_000 } as const

const MARKER = `<!-- harnessdesk:finding-op pub-${'b'.repeat(48)} -->`
const SIGNED_IN = { id: 7, login: 'jane-doe' }
const STRANGER = { id: 99, login: 'someone-else' }
const WRITER = { id: 42, login: 'a-maintainer' }

const talk = (from: string | null): string => `- id: talk
  on: issue
  events: [commented]
${from ? `  from: ${from}\n` : ''}  opens: { flow: review-pr }
  concurrency: 8
`

/** A desk whose one trigger reads comments, armed, with issue #1 already known to it. */
const desk = async (t: { after(fn: () => Promise<void>): void }, from: string | null): Promise<IntakeDesk> => {
  const repo = await makeRepo('hd-intake-comments-')
  await commitTriggers(repo, talk(from))
  const d = await intakeDesk({ repo })
  t.after(() => d.stop())
  const preview = await d.host.call('trigger/preview', { root: repo.dir, id: 'talk' }) as TriggerArmPreview
  assert.equal(preview.definition?.from, from ?? 'me', 'the arming review shows whose comments count')
  await d.host.call('trigger/arm', { root: repo.dir, id: 'talk', token: preview.token! })
  return d
}

/** Each comment on its own issue, so each would open its own Goal; what the history says of each, by issue. */
const comment = async (d: IntakeDesk, comments: readonly { readonly body: string; readonly user?: { id: number; login: string } | null }[]): Promise<Map<string, [string, string | null]>> => {
  const at = d.clocks.wall + 1000
  comments.forEach((one, index) => {
    const number = d.forge.issues.length + 1
    d.forge.issues.push({
      number, state: 'open', created: at, updated: at, events: [],
      comments: [{ id: 5000 + number * 10 + index, body: one.body, created: at, updated: at, ...(one.user !== undefined ? { user: one.user } : {}) }],
    })
  })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const page = await d.host.call('trigger/history', { root: d.repo.dir, id: 'talk' }) as TriggerHistoryPage
  return new Map(page.items.map((one) => [one.subject, [one.outcome, one.reason]]))
}

test('by default only the arming account’s own comments fire, and never the desk’s own posts', E2E, async (t) => {
  const d = await desk(t, null)
  const seen = await comment(d, [
    { body: 'Please fix this.', user: SIGNED_IN },
    { body: 'Please fix this too.', user: STRANGER },
    { body: 'Who wrote me?', user: null },
    { body: `${MARKER}\n**Review round 1**`, user: SIGNED_IN },
    { body: `> ${MARKER}\nquoted, so a person wrote this`, user: SIGNED_IN },
  ])
  assert.equal(seen.get('1')?.[0], 'fired', 'the arming account fires it')
  assert.deepEqual(seen.get('2'), ['skipped', 'Only comments by the forge account this trigger was armed with fire it, and someone else wrote this one.'])
  assert.deepEqual(seen.get('3'), ['skipped', 'Who wrote this comment could not be read, so it did not fire.'])
  assert.deepEqual(seen.get('4'), ['skipped', 'This comment was posted by this desk, so it does not fire a trigger.'])
  assert.equal(seen.get('5')?.[0], 'fired', 'a quoted marker is not a desk post, exactly as reconciliation reads one')
})

test('collaborators: the arming account and anyone who can write fire it; a reader, an unreadable permission and the desk do not', E2E, async (t) => {
  const d = await desk(t, 'collaborators')
  d.forge.permissions.set(WRITER.login, { id: WRITER.id, permission: 'write' })
  d.forge.permissions.set(STRANGER.login, { id: STRANGER.id, permission: 'read' })
  const seen = await comment(d, [
    { body: 'Mine.', user: SIGNED_IN },
    { body: 'A maintainer asks.', user: WRITER },
    { body: 'A reader asks.', user: STRANGER },
    { body: 'Unknown permission.', user: { id: 555, login: 'nobody-known' } },
    { body: `${MARKER}\nposted by the desk`, user: WRITER },
  ])
  assert.equal(seen.get('1')?.[0], 'fired')
  assert.equal(seen.get('2')?.[0], 'fired')
  assert.deepEqual(seen.get('3'), ['skipped', 'Only comments by people who can write to the repository fire this trigger, and this one’s author cannot.'])
  // The forge says there is no such collaborator: a no, not an unknown.
  assert.deepEqual(seen.get('4'), ['skipped', 'Only comments by people who can write to the repository fire this trigger, and this one’s author cannot.'])
  assert.deepEqual(seen.get('5'), ['skipped', 'This comment was posted by this desk, so it does not fire a trigger.'])
  assert.equal(d.forge.calls.filter((path) => path.includes('/collaborators/')).length, 4, 'one read per comment with a readable author, none for the desk’s post')
})

test('anyone: a stranger fires it, the desk’s own post still does not', E2E, async (t) => {
  const d = await desk(t, 'anyone')
  const seen = await comment(d, [
    { body: 'A stranger asks.', user: STRANGER },
    { body: 'Nobody readable.', user: null },
    { body: `${MARKER}\nposted by the desk`, user: SIGNED_IN },
  ])
  assert.equal(seen.get('1')?.[0], 'fired')
  assert.equal(seen.get('2')?.[0], 'fired', 'anyone means anyone')
  assert.deepEqual(seen.get('3'), ['skipped', 'This comment was posted by this desk, so it does not fire a trigger.'])
  assert.equal(d.forge.calls.filter((path) => path.includes('/collaborators/')).length, 0, 'no permission is read')
})

test('a review the desk publishes on a watched pull request fires nothing', E2E, async (t) => {
  const d = await intakeDesk()
  t.after(() => d.stop())
  const preview = await d.host.call('trigger/preview', { root: d.repo.dir, id: 'review' }) as TriggerArmPreview
  await d.host.call('trigger/arm', { root: d.repo.dir, id: 'review', token: preview.token! })
  const at = d.clocks.wall + 1000
  d.forge.pulls.push({ number: 1, head: sha('a'), state: 'open', created: at, updated: at })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  // The desk's review lands: the pull request is updated, its head is not.
  d.forge.pulls[0] = { ...d.forge.pulls[0]!, updated: d.clocks.wall + 1000, body: `${MARKER}\n**Review round 1**` }
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const page = await d.host.call('trigger/history', { root: d.repo.dir, id: 'review' }) as TriggerHistoryPage
  assert.deepEqual(page.items.map((one) => one.outcome), ['fired'], 'only the opening fired: a review is never a pull-request event')
})

test('collaborators: a permission read that fails now keeps the comment and fires it once the forge answers', E2E, async (t) => {
  const d = await desk(t, 'collaborators')
  d.forge.permissions.set(WRITER.login, { id: WRITER.id, permission: 'write' })
  d.forge.fail = (path) => path.includes('/collaborators/') ? { exitCode: 1, stderr: 'gh: HTTP 503 Service Unavailable' } : null
  const seen = await comment(d, [{ body: 'A maintainer asks.', user: WRITER }])
  assert.equal(seen.size, 0, 'no answer, so nothing consumed')
  d.forge.fail = null
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const page = await d.host.call('trigger/history', { root: d.repo.dir, id: 'talk' }) as TriggerHistoryPage
  assert.deepEqual(page.items.map((one) => one.outcome), ['fired'], 'replayed once the forge answers')
})
