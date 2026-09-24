import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel, setForgeEngine, type ForgeEngine } from '@harnessdesk/cordis-host'
import { gitPlugin } from '@harnessdesk/plugins'
import type { TriggerArmPreview, TriggerHistoryPage } from '@harnessdesk/protocol'

import { makeRepo } from './fixtures/evidence-desk.js'
import { commitTriggers, intakeDesk, type IntakeDesk } from './fixtures/intake-host.js'

/*
 * The desk posts to the forge as the same account a trigger is armed with,
 * so its own comment would pass `from: me` and fire the trigger again — a
 * loop (review #898 P1). Every desk post opens with the desk's marker, and
 * every comment id the desk posts is recorded, across a restart: through the
 * real `issue_comment` tool and the real host, a desk comment on a watched
 * issue never fires, in any `from:` mode.
 */

const E2E = { timeout: 120_000 } as const

/** A `gh` that answers `issue view` and records what `issue comment` posted, as GitHub would. */
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const home = process.env.GH_FAKE_HOME
const after = (flag) => { const at = args.indexOf(flag); return at === -1 ? null : args[at + 1] }
const verb = args.slice(0, 2).join(' ')
if (verb === 'issue view') { process.stdout.write(JSON.stringify({ number: Number(args[2]), title: 'Widgets wobble', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/' + args[2], author: { login: 'jane-doe' } })); process.exit(0) }
if (verb === 'issue comment') {
  const file = path.join(home, 'posted.json')
  const posted = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
  const id = 9000 + posted.length
  posted.push({ number: Number(args[2]), id, body: after('--body') })
  fs.writeFileSync(file, JSON.stringify(posted))
  process.stdout.write('https://github.com/acme/widgets/issues/' + args[2] + '#issuecomment-' + id + '\n')
  process.exit(0)
}
process.stderr.write('fake gh: unknown ' + verb + '\n'); process.exit(1)
`

const talk = (from: string): string => `- id: talk
  on: issue
  events: [commented]
  from: ${from}
  opens: { flow: review-pr }
  concurrency: 8
`

/** The real Git plugin in a real kernel, posting through a fake `gh`, and publishing through the host's own forge plane. */
const tools = (t: { after(fn: () => void | Promise<void>): void }, d: IntakeDesk) => {
  const root = mkdtempSync(join(tmpdir(), 'hd-desk-posts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'gh'), FAKE_GH)
  chmodSync(join(root, 'gh'), 0o755)
  const before = { path: process.env['PATH'], home: process.env['GH_FAKE_HOME'] }
  process.env['PATH'] = `${root}:${before.path ?? ''}`
  process.env['GH_FAKE_HOME'] = root
  t.after(() => {
    process.env['PATH'] = before.path
    if (before.home === undefined) delete process.env['GH_FAKE_HOME']
    else process.env['GH_FAKE_HOME'] = before.home
  })
  const engine: ForgeEngine = {
    seat: async () => null,
    identity: async () => ({ via: 'gh', login: 'jane-doe', available: true, reason: null }),
    // The host's own plane: it names no open conversation here, so only its first step — telling intake — lands.
    publish: async (reference) => { await d.host.forgePlane.publish(reference, { runtime: 'fake', sessionId: 'no-such-conversation' }).catch(() => {}) },
    publicationAllowed: async () => ({ ok: true }),
  }
  const kernel = new ExtensionKernel()
  return {
    async load(): Promise<void> {
      setForgeEngine(engine)
      t.after(() => setForgeEngine(null))
      t.after(() => kernel.dispose())
      await kernel.load(gitPlugin)
      await new Promise((resolve) => setTimeout(resolve, 60))
      kernel.setWorkspace({ root: d.repo.dir, branch: 'main' })
    },
    async comment(number: number, body: string): Promise<{ id: number; body: string }> {
      const tool = kernel.list('tool').find((entry) => entry.name === 'issue_comment')!
      const result = await kernel.invokeTool(tool.id, { number, body }, { runtime: 'fake', sessionId: 's1' } as never)
      assert.ok(result.ok, 'the tool posted')
      const posted = JSON.parse(readFileSync(join(root, 'posted.json'), 'utf8')) as { number: number; id: number; body: string }[]
      return posted.at(-1)!
    },
  }
}

const armed = async (t: { after(fn: () => Promise<void>): void }, from: string, stateDir?: string, repo?: IntakeDesk['repo']): Promise<IntakeDesk> => {
  const project = repo ?? await makeRepo('hd-intake-desk-posts-')
  if (!repo) await commitTriggers(project, talk(from))
  const d = await intakeDesk({ repo: project, ...(stateDir ? { stateDir } : {}) })
  t.after(() => d.stop())
  if (!stateDir) {
    const preview = await d.host.call('trigger/preview', { root: project.dir, id: 'talk' }) as TriggerArmPreview
    await d.host.call('trigger/arm', { root: project.dir, id: 'talk', token: preview.token! })
  }
  return d
}

/** What the forge now holds: the posted comment, as the signed-in account wrote it, on its own issue. */
const onForge = (d: IntakeDesk, number: number, comment: { id: number; body: string }): void => {
  const at = d.clocks.wall + 1000
  d.forge.issues.push({ number, state: 'open', created: at, updated: at, events: [], comments: [{ id: comment.id, body: comment.body, created: at, updated: at }] })
}

const outcomes = async (d: IntakeDesk): Promise<Map<string, [string, string | null]>> => {
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const page = await d.host.call('trigger/history', { root: d.repo.dir, id: 'talk' }) as TriggerHistoryPage
  return new Map(page.items.map((one) => [one.subject, [one.outcome, one.reason]]))
}

test('a comment the desk’s issue_comment tool posted never fires a trigger, in any from: mode', E2E, async (t) => {
  for (const from of ['me', 'collaborators', 'anyone']) {
    const d = await armed(t, from)
    d.forge.permissions.set('jane-doe', { id: 7, permission: 'admin' })
    const tool = tools(t, d)
    await tool.load()
    const posted = await tool.comment(1, 'I looked at this; the wobble is in the axle.')
    assert.match(posted.body, /^<!-- harnessdesk:post -->\nI looked at this/, `${from}: the post opens with the desk’s marker`)
    onForge(d, 1, posted)
    // And the person's own comment, on another issue, still fires.
    onForge(d, 2, { id: 777, body: 'Please look at the axle.' })
    const seen = await outcomes(d)
    assert.deepEqual(seen.get('1'), ['skipped', 'This comment was posted by this desk, so it does not fire a trigger.'], `${from}: the desk’s own comment`)
    assert.equal(seen.get('2')?.[0], 'fired', `${from}: a person’s comment`)
    await d.stop()
  }
})

test('the desk remembers the ids it posted across a restart, so a comment that lost its marker still does not fire', E2E, async (t) => {
  const first = await armed(t, 'me')
  const tool = tools(t, first)
  await tool.load()
  const posted = await tool.comment(3, 'Fixed in the axle.')
  await first.stop()
  const d = await armed(t, 'me', first.stateDir, first.repo)
  // The forge holds it without its first line — edited, or a client that dropped it.
  onForge(d, 3, { id: posted.id, body: posted.body.split('\n').slice(1).join('\n') })
  const seen = await outcomes(d)
  assert.deepEqual(seen.get('3'), ['skipped', 'This comment was posted by this desk, so it does not fire a trigger.'])
})
