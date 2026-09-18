import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { AgentEntry, MachineSeating } from '@harnessdesk/protocol'

import { parseAgentDefinition } from '../src/agent-def.js'
import { agentIdOf, agentSource, copyAgentFolder, projectAgentDir } from '../src/agent-files.js'
import { SEATING_FILE } from '../src/agent-seating-file.js'
import { builtinAgentRoot, type HostOptions } from '../src/host.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * An Agent's files: a new one written, one copied to where it shadows the
 * original, one moved to the Trash, one shown in Finder, one opened in the
 * desk's editor. Nothing overwrites an Agent that is there, nothing is written
 * through a link out of a project, and nothing that ships is written at all.
 */

test('a name becomes a folder name, and a name with nothing to spell one is refused', () => {
  assert.equal(agentIdOf('Careful reviewer'), 'careful-reviewer')
  assert.equal(agentIdOf('  Réviseur d’API  '), 'reviseur-d-api')
  assert.equal(agentIdOf('***'), null)
  assert.equal(agentIdOf('x'.repeat(80))?.length, 48)
})

test('a new AGENT.md reads back as what was saved, a model the spec cannot carry included', () => {
  const source = agentSource({
    name: 'Careful "reviewer"',
    description: 'Reads twice.',
    permission: 'read',
    prefer: [
      { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
      { runtime: 'cursor', model: 'vendor/model-1' },
    ],
  })
  const { agent, problems } = parseAgentDefinition(source, 'careful-reviewer')
  assert.deepEqual(problems, [])
  assert.equal(agent?.name, 'Careful "reviewer"')
  assert.equal(agent?.description, 'Reads twice.')
  assert.equal(agent?.permission, 'read')
  assert.deepEqual(agent?.prefer, [
    { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
    { runtime: 'cursor', model: 'vendor/model-1' },
  ])
  assert.match(agent?.brief ?? '', /## How to report[\s\S]*## What you never do/)
})

/**
 * Correction 1: the long-form rule shares `seating.json`'s own check
 * (`parseSeat(seatSpec(seat))` reads back the same seat), not a heuristic that
 * only ever looked at `model`. An effort holding the switch character `+`, and
 * a runtime holding the compact grammar's own `=`, are each cases the old
 * `seat.model && /[=/+]/.test(seat.model)` heuristic never inspected at all —
 * the first read back as a parse problem (a "switch" the seat does not have),
 * the second silently as a *different* seat (`weird` at model `runtime`,
 * dropping the `=m` that followed).
 */
test('an effort holding the compact grammar’s own “+” is written the long way, not misread as a switch', () => {
  const source = agentSource({
    name: 'Odd effort',
    description: null,
    permission: 'read',
    prefer: [{ runtime: 'claude-code', effort: 'high+extra' }],
  })
  const { agent, problems } = parseAgentDefinition(source, 'odd-effort')
  assert.deepEqual(problems, [])
  assert.deepEqual(agent?.prefer, [{ runtime: 'claude-code', effort: 'high+extra' }])
})

test('a runtime holding the compact grammar’s own “=” is written the long way, not silently misread as a different seat', () => {
  const source = agentSource({
    name: 'Odd runtime',
    description: null,
    permission: 'read',
    prefer: [{ runtime: 'weird=runtime', model: 'm' }],
  })
  const { agent, problems } = parseAgentDefinition(source, 'odd-runtime')
  assert.deepEqual(problems, [])
  assert.deepEqual(agent?.prefer, [{ runtime: 'weird=runtime', model: 'm' }])
})

test("a project's Agent folder is made inside it, and never through a link that leads out", async () => {
  const root = tempDir('hd-agent-files-')
  const project = join(root, 'project')
  await mkdir(project)
  assert.equal(await projectAgentDir(project), join(await realpath(project), '.harnessdesk', 'agents'))

  const linked = join(root, 'linked')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(linked)
  await mkdir(elsewhere)
  await symlink(elsewhere, join(linked, '.harnessdesk'))
  await assert.rejects(() => projectAgentDir(linked), /is a link/)
  assert.deepEqual(await readdir(elsewhere), [], 'nothing was made outside the project')
})

test('a folder is copied whole, its links left behind, and never over one that is there', async () => {
  const root = tempDir('hd-agent-files-')
  const from = join(root, 'from', 'scout')
  await mkdir(join(from, 'skills'), { recursive: true })
  await writeFile(join(from, 'AGENT.md'), '---\nname: Scout\n---\nLook.\n')
  await writeFile(join(from, 'skills', 'look.md'), 'Look closely.')
  await symlink(root, join(from, 'escape'))
  const to = join(root, 'to', 'scout')
  await copyAgentFolder(from, to)
  assert.deepEqual((await readdir(to)).sort(), ['AGENT.md', 'skills'])
  assert.deepEqual(await readdir(join(to, 'skills')), ['look.md'])
  await assert.rejects(() => copyAgentFolder(from, to), /already an Agent called “scout”/)
})

/**
 * Correction 5: the roster reads this machine's own folders straight through
 * a link at their top — a dotfiles checkout linked into place — so `from`
 * itself may be exactly such a link. Copied literally, `cp`'s own filter
 * (which exists to leave links *inside* the tree behind) would see a link at
 * the very top and drop the whole copy, silently copying nothing. And a copy
 * that followed nothing but links — every entry inside it a link too — is
 * never left half-made: it is removed and refused, so `found()` is never the
 * first place that notices.
 */
test('a copy follows the one link at the top of a linked Agent folder — as the roster itself does — and refuses if nothing but links was there', async () => {
  const root = tempDir('hd-agent-files-')
  const real = join(root, 'real', 'scout')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'AGENT.md'), '---\nname: Scout\n---\nLook.\n')
  const linked = join(root, 'linked-scout')
  await symlink(real, linked)
  const to = join(root, 'to', 'scout')
  await copyAgentFolder(linked, to)
  assert.deepEqual(await readdir(to), ['AGENT.md'])

  const onlyLinks = join(root, 'only-links')
  await mkdir(onlyLinks)
  await symlink(join(real, 'AGENT.md'), join(onlyLinks, 'AGENT.md'))
  const to2 = join(root, 'to2', 'scout')
  await assert.rejects(() => copyAgentFolder(onlyLinks, to2), /AGENT\.md/)
  assert.equal(await lstat(to2).then(() => true, () => false), false, 'nothing was left behind by the refused copy')
})

/** A host whose Trash and Finder are recorded rather than touched, with a project open. */
const desk = async (t: TestContext) => {
  const trashed: string[] = []
  const revealed: string[] = []
  const options: Partial<HostOptions> = {
    trashPath: async (path) => void trashed.push(path),
    revealPath: async (path) => void revealed.push(path),
  }
  const harness = await start(options)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const project = tempDir('hd-agent-files-project-')
  await client.call('workspace/open', { path: project })
  return { harness, client, project, trashed, revealed }
}

const seat = { runtime: 'claude-code', model: 'opus-5', effort: 'high' }

test('through the host: an Agent is saved to you with its seat, or to a project with only the runtime', async (t) => {
  const { harness, client, project } = await desk(t)
  const mine = (await client.call('agent/create', {
    name: 'Careful reviewer',
    description: 'Reads twice.',
    permission: 'read',
    seat,
    to: 'user',
  })) as AgentEntry
  assert.equal(mine.origin, 'user')
  assert.equal(mine.path, join(harness.stateDir, 'agents', 'careful-reviewer', 'AGENT.md'))
  assert.deepEqual(mine.definition?.prefer, [seat])

  const theirs = (await client.call('agent/create', {
    name: 'Release checker',
    permission: 'publish',
    seat,
    to: 'project',
    project,
  })) as AgentEntry
  assert.equal(theirs.origin, 'project')
  assert.deepEqual(theirs.definition?.prefer, [{ runtime: 'claude-code' }], 'a committed Agent names the runtime, never the model')
  const machine = (await client.call('agent/seating/read', {})) as MachineSeating
  assert.deepEqual(machine.entries, [{ id: 'release-checker', seats: [seat] }], '…and this Mac keeps the exact seat')

  await assert.rejects(
    client.call('agent/create', { name: 'Careful reviewer', permission: 'read', seat, to: 'user' }),
    /already an Agent called “careful-reviewer”/,
  )
})

/**
 * Correction 4: a copy that would arrive already shadowed is invisible from
 * the moment it is written — the same mistake `agent/copy` refuses when its
 * destination would not outrank its source. Saving to *you* while the project
 * you are in already has an Agent of the same name is exactly that mistake,
 * because the project's copy would always win here.
 */
test('through the host: Save as an Agent never writes a copy the project would immediately shadow', async (t) => {
  const { client, project } = await desk(t)
  await client.call('agent/create', { name: 'Scout', permission: 'read', seat, to: 'project', project })
  await assert.rejects(
    client.call('agent/create', { name: 'Scout', permission: 'read', seat, to: 'user', project }),
    /would be shadowed/,
  )
  const listed = (await client.call('agent/list', { project })) as AgentEntry[]
  const scout = listed.find((one) => one.id === 'scout')
  assert.equal(scout?.origin, 'project')
  assert.deepEqual(scout?.shadows, [], 'the refused save left no copy behind to shadow anything')
})

/**
 * Correction 3: an exact seat kept in `seating.json` is never lost silently.
 * A file this machine cannot read at all refuses the whole save — nothing
 * written, the folder included — rather than writing an Agent whose seat then
 * silently fails to land.
 */
test("through the host: a seating.json this machine cannot read refuses to keep an exact seat, and writes no folder", async (t) => {
  const { harness, client, project } = await desk(t)
  await writeFile(join(harness.stateDir, SEATING_FILE), '{ not json')
  await assert.rejects(
    client.call('agent/create', { name: 'Scratch', permission: 'read', seat, to: 'project', project }),
    /cannot be read/,
  )
  assert.equal(
    await lstat(join(project, '.harnessdesk', 'agents', 'scratch')).then(() => true, () => false),
    false,
    'no folder was made when the seat it would have named could not be kept',
  )
})

test('through the host: Customize copies an Agent to where the copy shadows it, and nowhere it would not', async (t) => {
  const { client, project } = await desk(t)
  const copy = (await client.call('agent/copy', { id: 'code-reviewer', from: 'builtin', to: 'user' })) as AgentEntry
  assert.equal(copy.origin, 'user')
  assert.deepEqual(copy.shadows.map((one) => one.origin), ['builtin'])
  const higher = (await client.call('agent/copy', { id: 'code-reviewer', from: 'user', to: 'project', project })) as AgentEntry
  assert.equal(higher.origin, 'project')
  assert.deepEqual(higher.shadows.map((one) => one.origin), ['user', 'builtin'])
  // A copy made where the original outranks it would be shadowed by what it copies.
  await assert.rejects(
    client.call('agent/copy', { id: 'code-reviewer', from: 'project', to: 'user', project }),
    /would be shadowed/,
  )
})

test('through the host: Remove sends a folder to the Trash, and a built-in one cannot be removed', async (t) => {
  const { client, trashed } = await desk(t)
  const mine = (await client.call('agent/create', { name: 'Scratch', permission: 'read', seat, to: 'user' })) as AgentEntry
  await client.call('agent/remove', { id: 'scratch', origin: 'user' })
  assert.deepEqual(trashed, [dirname(mine.path)])
  await assert.rejects(client.call('agent/remove', { id: 'code-reviewer', origin: 'builtin' }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'badRequest')
    return true
  })
})

test('through the host: Reveal shows the file an Agent comes from, whichever copy is asked for', async (t) => {
  const { client, revealed } = await desk(t)
  await client.call('agent/copy', { id: 'judge', from: 'builtin', to: 'user' })
  await client.call('agent/reveal', { id: 'judge' })
  await client.call('agent/reveal', { id: 'judge', origin: 'builtin' })
  assert.equal(revealed.length, 2)
  assert.match(revealed[0] ?? '', /agents\/judge\/AGENT\.md$/)
  assert.equal(revealed[1], join(builtinAgentRoot(), 'judge', 'AGENT.md'))
})

/**
 * Correction 8: `agent/copy`, `agent/remove` and `agent/reveal` only ever act
 * on a path the roster itself listed — an id is matched against the roster's
 * own listing before it is used for anything, and never joined onto a root
 * unchecked. `'../x'` and `'..'` can never be a real entry's id (a directory
 * listing entry never contains a path separator, and the OS never yields
 * `'..'` as one), so every verb refuses them, and none of the three so much
 * as touches the Trash, Finder or a new folder while doing it.
 */
test('through the host: an id the roster never listed is refused by every verb, and nothing is trashed, revealed or written', async (t) => {
  const { client, project, trashed, revealed } = await desk(t)
  for (const id of ['../x', '..']) {
    await assert.rejects(client.call('agent/copy', { id, from: 'builtin', to: 'user' }))
    await assert.rejects(client.call('agent/remove', { id, origin: 'user' }))
    await assert.rejects(client.call('agent/reveal', { id }))
  }
  assert.deepEqual(trashed, [])
  assert.deepEqual(revealed, [])
  const mine = (await client.call('agent/list', { project })) as AgentEntry[]
  assert.deepEqual(
    mine.filter((one) => one.origin === 'user'),
    [],
  )
})

test("through the host: an Agent's file opens in the desk's editor, and only this machine's is written", async (t) => {
  const { client } = await desk(t)
  const shipped = join(builtinAgentRoot(), 'judge', 'AGENT.md')
  const read = (await client.call('workspace/readFile', { path: shipped })) as { content: string; hash: string }
  assert.match(read.content, /^---\nname: Judge/)
  await assert.rejects(
    client.call('file/save', { path: shipped, content: 'x', expectedHash: read.hash }),
    /outside every open workspace/,
  )
  const mine = (await client.call('agent/create', { name: 'Scout', permission: 'read', seat, to: 'user' })) as AgentEntry
  const before = (await client.call('workspace/readFile', { path: mine.path })) as { content: string; hash: string }
  const saved = (await client.call('file/save', {
    path: mine.path,
    content: `${before.content}\nLook twice.\n`,
    expectedHash: before.hash,
  })) as { saved: boolean }
  assert.equal(saved.saved, true)
})
