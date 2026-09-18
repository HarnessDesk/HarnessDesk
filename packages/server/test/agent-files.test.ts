import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  parseClientMessage,
  ValidationError,
  type AgentEntry,
  type MachineSeating,
} from '@harnessdesk/protocol'

import { parseAgentDefinition } from '../src/agent-def.js'
import { agentIdOf, agentSource, copyAgentFolder, createAgentFolder, projectAgentDir, writeAgentFolder } from '../src/agent-files.js'
import { SEATING_FILE } from '../src/agent-seating-file.js'
import { Agents, PROJECT_AGENT_DIR } from '../src/agents.js'
import { Host, StateStore, type HostOptions } from '../src/index.js'
import { agentMethods, found } from '../src/methods/agents.js'
import type { HostContext } from '../src/methods/context.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { shippedAgentsCopy, silent } from './fixtures/harness.js'
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

test('a new Agent folder has the mode a plain mkdir in the same parent would have', async () => {
  const root = tempDir('hd-agent-files-mode-')
  const ordinary = join(root, 'ordinary')
  await mkdir(ordinary)
  await createAgentFolder(root, 'scout', '---\nname: Scout\n---\nLook.\n')

  assert.equal((await stat(join(root, 'scout'))).mode & 0o777, (await stat(ordinary)).mode & 0o777)
})

test('a legal long Agent folder name can be customized without making an even longer temporary name', async () => {
  const root = tempDir('hd-agent-files-long-')
  const id = 'a'.repeat(240)
  const from = join(root, 'from', id)
  await mkdir(from, { recursive: true })
  await writeFile(join(from, 'AGENT.md'), '---\nname: Long Agent\n---\nLook.\n')
  const to = join(root, 'to', id)

  await copyAgentFolder(from, to)
  assert.match(await readFile(join(to, 'AGENT.md'), 'utf8'), /Long Agent/)
})

test('an EEXIST raised while writing a temporary Agent keeps its real error instead of claiming the final name collided', async () => {
  const root = tempDir('hd-agent-files-inner-collision-')
  const inner = Object.assign(new Error('two source entries collided'), { code: 'EEXIST' })

  await assert.rejects(
    () => writeAgentFolder(root, 'scout', async () => Promise.reject(inner)),
    (error: unknown) => {
      assert.equal(error, inner)
      return true
    },
  )
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
  await createAgentFolder(dirname(to2), 'scout', '---\nname: Scout\n---\nLook.\n')
  assert.equal(await lstat(join(to2, 'AGENT.md')).then(() => true, () => false), true, 'a later Save is not blocked')
})

/** A host whose Trash and Finder are recorded rather than touched, with a project open. */
const desk = async (t: TestContext) => {
  const trashed: string[] = []
  const revealed: string[] = []
  const stateDir = tempDir('hd-agent-files-state-')
  const options: Partial<HostOptions> = {
    builtinAgents: await shippedAgentsCopy(),
    trashPath: async (path) => void trashed.push(path),
    revealPath: async (path) => void revealed.push(path),
  }
  const client = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
    pickDirectory: async () => stateDir,
    ...options,
  })
  client.register(new FakeRuntime())
  await client.start()
  t.after(() => client.dispose())
  const project = tempDir('hd-agent-files-project-')
  await client.call('workspace/open', { path: project })
  return { stateDir, client, project, trashed, revealed }
}

const seat = { runtime: 'claude-code', model: 'opus-5', effort: 'high' }

/** A handler-only context, for failures that must be injectable between the folder write and its rollback. */
const handlerDesk = async (
  project: string,
  set: (id: string, seats: readonly { runtime: string; model?: string; effort?: string; thinking?: boolean }[] | null) => Promise<unknown>,
  entries: MachineSeating['entries'] = [],
) => {
  const state = tempDir('hd-agent-handler-state-')
  const confinedProject = await realpath(project)
  const pushed: unknown[] = []
  const ctx = {
    agents: new Agents({ user: join(state, 'agents'), builtin: await shippedAgentsCopy() }),
    seating: {
      read: async () => ({ path: join(state, SEATING_FILE), entries, problems: [] }),
      set,
    },
    workspaces: { confineGitRoot: async () => confinedProject },
    options: {},
    push: (notice: unknown) => void pushed.push(notice),
  } as unknown as HostContext
  return { ctx, state, pushed }
}

test('the wire and the handler both refuse an Agent name over 80 characters and a description over 500', async () => {
  const request = (name: string, description: string) => ({
    id: 1,
    method: 'agent/create',
    params: { name, description, permission: 'read' as const, seat, to: 'user' as const },
  })
  assert.throws(() => parseClientMessage(request('x'.repeat(81), 'short')), /at most 80/)
  assert.throws(() => parseClientMessage(request('Scout', 'x'.repeat(501))), /at most 500/)

  const create = agentMethods['agent/create']
  await assert.rejects(() => create({} as HostContext, request('x'.repeat(81), 'short').params), /at most 80/)
  await assert.rejects(() => create({} as HostContext, request('Scout', 'x'.repeat(501)).params), /at most 500/)
})

test('the wire validates every Agent file verb before a handler can see it', () => {
  const request = (method: string, params: unknown) => ({ id: 1, method, params })
  const refused = [
    request('agent/remove', { id: 'scout', origin: 'builtin' }),
    request('agent/copy', { id: 'scout', from: 'builtin', to: 'builtin' }),
    request('agent/create', { name: 42, permission: 'read', seat, to: 'user' }),
    request('agent/copy', { id: 42, from: 'builtin', to: 'user' }),
    request('agent/remove', { id: 'scout', origin: 'user', project: 42 }),
    request('agent/reveal', { id: 'scout', origin: 42 }),
  ]
  for (const message of refused) assert.throws(() => parseClientMessage(message), ValidationError)
})

test('the entry returned after a write must have a definition, the requested origin, and the exact written path', () => {
  const path = '/agents/scout/AGENT.md'
  const definition = parseAgentDefinition('---\nname: Scout\n---\nLook.\n', 'scout').agent
  assert.ok(definition)
  const entry: AgentEntry = {
    definition,
    id: 'scout',
    origin: 'user',
    path,
    digest: 'digest',
    shadows: [],
    problems: [],
  }
  const expected = { id: 'scout', origin: 'user' as const, path }

  assert.throws(() => found({ ...entry, definition: null }, expected), /did not read back/)
  assert.throws(() => found({ ...entry, origin: 'project' }, expected), /did not read back/)
  assert.throws(() => found({ ...entry, path: '/agents/other/AGENT.md' }, expected), /did not read back/)
})

test('through the host: Save refuses fields that do not read back exactly and a source the roster would not read, before making a folder', async (t) => {
  const { stateDir, client, project } = await desk(t)
  await assert.rejects(
    client.call('agent/create', { name: ' Checker ', permission: 'read', seat, to: 'project', project }),
    /name does not read back exactly/,
  )
  assert.equal(
    await lstat(join(project, PROJECT_AGENT_DIR)).then(() => true, () => false),
    false,
    'a refused save did not make the project Agent root',
  )

  await assert.rejects(
    client.call('agent/create', {
      name: 'Too much',
      description: 'x'.repeat(140_000),
      permission: 'read',
      seat,
      to: 'user',
    }),
    /at most 500/,
  )
  assert.equal(await lstat(join(stateDir, 'agents', 'too-much')).then(() => true, () => false), false)

  await assert.rejects(
    client.call('agent/create', {
      name: 'Huge seat',
      permission: 'read',
      seat: { runtime: 'x'.repeat(300_000) },
      to: 'user',
    }),
    /too large to read back/,
  )
  assert.equal(await lstat(join(stateDir, 'agents', 'huge-seat')).then(() => true, () => false), false)
})

test('the reserved id constructor is refused before the project root or seating writer is touched', async () => {
  const project = tempDir('hd-agent-reserved-project-')
  let sets = 0
  const { ctx } = await handlerDesk(project, async () => {
    sets += 1
    throw new Error('the seating writer must not be called')
  })
  await assert.rejects(
    () => agentMethods['agent/create'](ctx, { name: 'Constructor', permission: 'read', seat, to: 'project', project }),
    /not read as an Agent id/,
  )
  assert.equal(sets, 0)
  assert.equal(await lstat(join(project, '.harnessdesk')).then(() => true, () => false), false)
})

test('a failed seat write removes the Agent this call made, without a recursive delete', async () => {
  const project = tempDir('hd-agent-rollback-project-')
  const { ctx } = await handlerDesk(project, async () => {
    throw new Error('seat write failed')
  })
  await assert.rejects(
    () => agentMethods['agent/create'](ctx, { name: 'Scratch', permission: 'read', seat, to: 'project', project }),
    /seat write failed/,
  )
  assert.equal(await lstat(join(project, PROJECT_AGENT_DIR, 'scratch')).then(() => true, () => false), false)
})

test('rollback treats an already-removed Agent file as done and preserves the seating error', async () => {
  const project = tempDir('hd-agent-rollback-missing-file-project-')
  const folder = join(project, PROJECT_AGENT_DIR, 'scratch')
  const { ctx } = await handlerDesk(project, async () => {
    await unlink(join(folder, 'AGENT.md'))
    throw new Error('seat write failed')
  })
  await assert.rejects(
    () => agentMethods['agent/create'](ctx, { name: 'Scratch', permission: 'read', seat, to: 'project', project }),
    (error: unknown) => {
      assert.equal((error as Error).message, 'seat write failed')
      return true
    },
  )
  assert.equal(await lstat(folder).then(() => true, () => false), false)
})

test('rollback reports an unlink refusal without replacing the seating error', async () => {
  const project = tempDir('hd-agent-rollback-unlink-refused-project-')
  const folder = join(project, PROJECT_AGENT_DIR, 'scratch')
  const { ctx } = await handlerDesk(project, async () => {
    await chmod(folder, 0o500)
    throw new Error('seat write failed')
  })
  try {
    await assert.rejects(
      () => agentMethods['agent/create'](ctx, { name: 'Scratch', permission: 'read', seat, to: 'project', project }),
      /seat write failed.*left in place.*could not be removed/,
    )
  } finally {
    await chmod(folder, 0o700)
  }
})

test('rollback removes only its AGENT.md when another file appeared in the folder, and says why the folder stayed', async () => {
  const project = tempDir('hd-agent-rollback-owned-project-')
  const folder = join(project, PROJECT_AGENT_DIR, 'scratch')
  const { ctx } = await handlerDesk(project, async () => {
    await writeFile(join(folder, 'precious.txt'), 'keep')
    throw new Error('seat write failed')
  })
  await assert.rejects(
    () => agentMethods['agent/create'](ctx, { name: 'Scratch', permission: 'read', seat, to: 'project', project }),
    /left in place.*changed/,
  )
  assert.equal(await readFile(join(folder, 'precious.txt'), 'utf8'), 'keep')
  assert.equal(await lstat(join(folder, 'AGENT.md')).then(() => true, () => false), false, 'only this call’s file was removed')
})

test('rollback leaves a replacement folder untouched', async () => {
  const project = tempDir('hd-agent-rollback-replaced-project-')
  const folder = join(project, PROJECT_AGENT_DIR, 'scratch')
  const original = join(project, PROJECT_AGENT_DIR, 'scratch-original')
  const { ctx } = await handlerDesk(project, async () => {
    await rename(folder, original)
    await mkdir(folder)
    await writeFile(join(folder, 'AGENT.md'), 'replacement')
    await writeFile(join(folder, 'precious.txt'), 'keep')
    throw new Error('seat write failed')
  })
  await assert.rejects(
    () => agentMethods['agent/create'](ctx, { name: 'Scratch', permission: 'read', seat, to: 'project', project }),
    /left in place.*replaced/,
  )
  assert.equal(await readFile(join(folder, 'AGENT.md'), 'utf8'), 'replacement')
  assert.equal(await readFile(join(folder, 'precious.txt'), 'utf8'), 'keep')
})

test('rollback rechecks the project walk and never follows an Agents root swapped for a link', async () => {
  const project = tempDir('hd-agent-rollback-link-project-')
  const agents = join(project, PROJECT_AGENT_DIR)
  const held = join(project, '.harnessdesk', 'agents-held')
  const outside = tempDir('hd-agent-rollback-outside-')
  const { ctx } = await handlerDesk(project, async () => {
    await rename(agents, held)
    await mkdir(join(outside, 'scratch'))
    await writeFile(join(outside, 'scratch', 'precious.txt'), 'keep')
    await symlink(outside, agents)
    throw new Error('seat write failed')
  })
  await assert.rejects(
    () => agentMethods['agent/create'](ctx, { name: 'Scratch', permission: 'read', seat, to: 'project', project }),
    /left in place.*link/,
  )
  assert.equal(await readFile(join(outside, 'scratch', 'precious.txt'), 'utf8'), 'keep')
  assert.equal(await lstat(join(held, 'scratch', 'AGENT.md')).then(() => true, () => false), true)
})

test('through the host: an Agent is saved to you with its seat, or to a project with only the runtime', async (t) => {
  const { stateDir, client, project } = await desk(t)
  const mine = (await client.call('agent/create', {
    name: 'Careful reviewer',
    description: 'Reads twice.',
    permission: 'read',
    seat,
    to: 'user',
  })) as AgentEntry
  assert.equal(mine.origin, 'user')
  assert.equal(mine.path, join(stateDir, 'agents', 'careful-reviewer', 'AGENT.md'))
  assert.deepEqual(mine.definition?.prefer, [seat])

  const theirs = (await client.call('agent/create', {
    name: 'Release checker',
    permission: 'publish',
    seat,
    to: 'project',
    project,
  })) as AgentEntry
  assert.equal(theirs.origin, 'project')
  assert.equal(theirs.path, join(await realpath(project), PROJECT_AGENT_DIR, 'release-checker', 'AGENT.md'))
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

test('through the host: Save may shadow a built-in Agent, and answers the user file it wrote', async (t) => {
  const { stateDir, client } = await desk(t)
  const saved = (await client.call('agent/create', {
    name: 'Code reviewer',
    permission: 'read',
    seat,
    to: 'user',
  })) as AgentEntry
  assert.equal(saved.origin, 'user')
  assert.equal(saved.path, join(stateDir, 'agents', 'code-reviewer', 'AGENT.md'))
  assert.deepEqual(saved.shadows.map((one) => one.origin), ['builtin'])
})

test('through the host: Save refuses this Mac’s older seats by name, before writing a competing prefer', async (t) => {
  const { stateDir, client } = await desk(t)
  await client.call('agent/seating/set', {
    id: 'checker',
    seats: [{ runtime: 'fake', model: 'fake-1', effort: 'high' }],
  })
  await assert.rejects(
    client.call('agent/create', {
      name: 'Checker',
      permission: 'read',
      seat: { runtime: 'claude-code', model: 'opus-5' },
      to: 'user',
    }),
    /This Mac already has seats for “checker”, and they would win over the one you are saving\. Change or clear them on its page first, or pick another name\./,
  )
  assert.equal(await lstat(join(stateDir, 'agents', 'checker')).then(() => true, () => false), false)
})

test('a stale-seat refusal does not read runtimes, accounts, catalogues or usage after deciding to refuse', async () => {
  const project = tempDir('hd-agent-stale-seat-project-')
  const { ctx } = await handlerDesk(
    project,
    async () => {
      throw new Error('the seating writer must not be called')
    },
    [{ id: 'checker', seats: [{ runtime: 'fake', model: 'fake-1', effort: 'high' }] }],
  )
  await assert.rejects(
    () => agentMethods['agent/create'](ctx, { name: 'Checker', permission: 'read', seat, to: 'user' }),
    /This Mac already has seats for “checker”, and they would win/,
  )
})

/**
 * Correction 3: an exact seat kept in `seating.json` is never lost silently.
 * A file this machine cannot read at all refuses the whole save — nothing
 * written, the folder included — rather than writing an Agent whose seat then
 * silently fails to land.
 */
test("through the host: a seating.json this machine cannot read refuses to keep an exact seat, and writes no folder", async (t) => {
  const { stateDir, client, project } = await desk(t)
  await writeFile(join(stateDir, SEATING_FILE), '{ not json')
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
  await assert.rejects(
    client.call('agent/copy', { id: 'code-reviewer', from: 'user', to: 'user' }),
    /would be shadowed by your copy/,
  )
  const higher = (await client.call('agent/copy', { id: 'code-reviewer', from: 'user', to: 'project', project })) as AgentEntry
  assert.equal(higher.origin, 'project')
  assert.deepEqual(higher.shadows.map((one) => one.origin), ['user', 'builtin'])
  // A copy made where the original outranks it would be shadowed by what it copies.
  await assert.rejects(
    client.call('agent/copy', { id: 'code-reviewer', from: 'project', to: 'user', project }),
    /would be shadowed/,
  )
})

test('through the host: Customize refuses when the actual winner outranks the destination', async (t) => {
  const { stateDir, client, project } = await desk(t)
  await client.call('agent/create', { name: 'Judge', permission: 'read', seat: { runtime: 'fake' }, to: 'project', project })
  await assert.rejects(
    client.call('agent/copy', { id: 'judge', from: 'builtin', to: 'user', project }),
    /would be shadowed by the project “judge” already there/,
  )
  assert.equal(await lstat(join(stateDir, 'agents', 'judge')).then(() => true, () => false), false)
})

test("through the host: Customize to a project refuses model-specific seats and allows runtime-only ones", async (t) => {
  const { client, project } = await desk(t)
  await client.call('agent/create', {
    name: 'Careful reviewer',
    permission: 'read',
    seat: { runtime: 'fake', model: 'fake-1', effort: 'high' },
    to: 'user',
  })
  await assert.rejects(
    client.call('agent/copy', { id: 'careful-reviewer', from: 'user', to: 'project', project }),
    /“Careful reviewer” names models in its seats\. A project's Agent names runtimes only, so it works on every machine\. Keep it yours, or copy it once its seats name runtimes only\./,
  )
  assert.equal(await lstat(join(project, PROJECT_AGENT_DIR, 'careful-reviewer')).then(() => true, () => false), false)

  await client.call('agent/create', { name: 'Portable', permission: 'read', seat: { runtime: 'fake' }, to: 'user' })
  const portable = (await client.call('agent/copy', { id: 'portable', from: 'user', to: 'project', project })) as AgentEntry
  assert.equal(portable.origin, 'project')
  assert.equal(portable.path, join(await realpath(project), PROJECT_AGENT_DIR, 'portable', 'AGENT.md'))
})

test('through the host: a dangling destination link is an existing Agent name, never a place Customize writes through', async (t) => {
  const { stateDir, client } = await desk(t)
  const user = join(stateDir, 'agents')
  const missing = join(stateDir, 'missing-target')
  await mkdir(user, { recursive: true })
  await symlink(missing, join(user, 'judge'))
  await assert.rejects(client.call('agent/copy', { id: 'judge', from: 'builtin', to: 'user' }), /already an Agent called “judge”/)
  assert.equal(await lstat(join(user, 'judge')).then((info) => info.isSymbolicLink()), true)
  assert.equal(await lstat(missing).then(() => true, () => false), false)
})

test('a project Save that writes this Mac’s exact seat announces both changes', async () => {
  const project = tempDir('hd-agent-notice-project-')
  const machine: MachineSeating = { path: join(tempDir('hd-agent-notice-state-'), SEATING_FILE), entries: [], problems: [] }
  const { ctx, pushed } = await handlerDesk(project, async (id, seats) => ({
    seating: { ...machine, entries: [{ id, seats: seats ?? [] }] },
    wrote: true,
  }))
  await agentMethods['agent/create'](ctx, { name: 'Scratch', permission: 'read', seat, to: 'project', project })
  assert.deepEqual(pushed, [
    { method: 'agent/changed', params: { project: null } },
    { method: 'agent/changed', params: { project: await realpath(project) } },
  ])
})

test('through the host: Remove sends a folder to the Trash, and a built-in one cannot be removed', async (t) => {
  const { client, trashed } = await desk(t)
  const mine = (await client.call('agent/create', { name: 'Scratch', permission: 'read', seat, to: 'user' })) as AgentEntry
  await client.call('agent/remove', { id: 'scratch', origin: 'user' })
  assert.deepEqual(trashed, [dirname(mine.path)])
  await assert.rejects(client.call('agent/remove', { id: 'code-reviewer', origin: 'builtin' } as never), /cannot be removed/)
})

test('the Remove handler itself refuses a built-in Agent even when no wire validator stands in front of it', async () => {
  let trashed = false
  const ctx = {
    options: { trashPath: async () => void (trashed = true) },
  } as unknown as HostContext
  await assert.rejects(
    () => agentMethods['agent/remove'](ctx, { id: 'judge', origin: 'builtin' } as never),
    /built-in Agent cannot be removed/,
  )
  assert.equal(trashed, false)
})

test('Remove and Reveal say that their OS action needs the desktop app when it is unavailable', async () => {
  const ctx = { options: {} } as HostContext
  await assert.rejects(
    () => agentMethods['agent/remove'](ctx, { id: 'scout', origin: 'user' }),
    /Moving an Agent to the Trash needs the desktop app/,
  )
  await assert.rejects(
    () => agentMethods['agent/reveal'](ctx, { id: 'scout' }),
    /Showing a file in the file browser needs the desktop app/,
  )
})

test("through the host: a project Agent-directory placeholder is never copied, trashed or revealed as though it were an Agent", async (t) => {
  const { stateDir, client, project, trashed, revealed } = await desk(t)
  const elsewhere = tempDir('hd-agent-placeholder-outside-')
  await mkdir(join(project, '.harnessdesk', 'flows'), { recursive: true })
  await writeFile(join(project, '.harnessdesk', 'flows', 'keep.yml'), 'keep')
  await symlink(elsewhere, join(project, PROJECT_AGENT_DIR))

  await assert.rejects(
    client.call('agent/copy', { id: PROJECT_AGENT_DIR, from: 'project', to: 'user', project }),
    /not a real Agent folder/,
  )
  await assert.rejects(
    client.call('agent/remove', { id: PROJECT_AGENT_DIR, origin: 'project', project }),
    /not a real Agent folder/,
  )
  await assert.rejects(client.call('agent/reveal', { id: PROJECT_AGENT_DIR, origin: 'project', project }), /not a real Agent folder/)
  assert.deepEqual(trashed, [])
  assert.deepEqual(revealed, [])
  assert.equal(await readFile(join(project, '.harnessdesk', 'flows', 'keep.yml'), 'utf8'), 'keep')
  assert.equal(await lstat(join(stateDir, 'agents', PROJECT_AGENT_DIR)).then(() => true, () => false), false)
})

test('through the host: Reveal shows the file an Agent comes from, whichever copy is asked for', async (t) => {
  const { client, revealed } = await desk(t)
  await client.call('agent/copy', { id: 'judge', from: 'builtin', to: 'user' })
  const listed = (await client.call('agent/read', { id: 'judge' })) as AgentEntry
  const builtin = listed.shadows.find((one) => one.origin === 'builtin')?.path
  await client.call('agent/reveal', { id: 'judge' })
  await client.call('agent/reveal', { id: 'judge', origin: 'builtin' })
  assert.equal(revealed.length, 2)
  assert.match(revealed[0] ?? '', /agents\/judge\/AGENT\.md$/)
  assert.equal(revealed[1], builtin)
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
  const { stateDir, client, project, trashed, revealed } = await desk(t)
  for (const id of ['../x', '..']) {
    await assert.rejects(client.call('agent/copy', { id, from: 'builtin', to: 'user' }))
    await assert.rejects(client.call('agent/remove', { id, origin: 'user' }))
    await assert.rejects(client.call('agent/reveal', { id }))
  }
  await assert.rejects(
    client.call('agent/copy', { id: '../agents/judge', from: 'builtin', to: 'user' }),
    /There is no built-in Agent called “\.\.\/agents\/judge” to copy\./,
  )
  assert.deepEqual(trashed, [])
  assert.deepEqual(revealed, [])
  assert.equal(
    await lstat(join(stateDir, 'agents', 'judge', 'AGENT.md')).then(() => true, () => false),
    false,
    'the traversal-shaped id wrote no user Agent on disk',
  )
  const mine = (await client.call('agent/list', { project })) as AgentEntry[]
  assert.deepEqual(
    mine.filter((one) => one.origin === 'user'),
    [],
  )
})

test("through the host: an Agent's file opens in the desk's editor, and only this machine's is written", async (t) => {
  const { client, revealed } = await desk(t)
  const shipped = ((await client.call('agent/read', { id: 'judge' })) as AgentEntry).path
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

  const stat = (await client.call('workspace/stat', { path: mine.path })) as { kind: string }
  assert.equal(stat.kind, 'file')
  const { ticket } = (await client.call('preview/ticket', { path: mine.path })) as { ticket: string }
  const preview = await client.redeemPreviewTicket(ticket)
  assert.match(Buffer.from(preview?.bytes ?? []).toString('utf8'), /Look twice\./)

  await assert.rejects(client.call('workspace/reveal', { path: mine.path }), /outside every open workspace/)
  await assert.rejects(client.call('workspace/files', { root: dirname(mine.path), query: 'AGENT' }), /outside every open workspace/)
  assert.deepEqual(revealed, [], 'the generic reveal stayed on open workspaces')
})

test("through the host: this machine's linked Agent is edited in place, while the built-in root remains read-only", async (t) => {
  const { stateDir, client } = await desk(t)
  const real = tempDir('hd-agent-linked-real-')
  await writeFile(join(real, 'AGENT.md'), '---\nname: Linked\npermission: read\nprefer: [fake]\n---\nLook.\n')
  const user = join(stateDir, 'agents')
  await mkdir(user, { recursive: true })
  const linked = join(user, 'linked')
  await symlink(real, linked)
  const path = join(linked, 'AGENT.md')
  const before = (await client.call('workspace/readFile', { path })) as { content: string; hash: string }
  assert.match(before.content, /name: Linked/)
  await client.call('file/save', { path, content: before.content.replace('Look.', 'Look twice.'), expectedHash: before.hash })
  assert.match(await readFile(join(real, 'AGENT.md'), 'utf8'), /Look twice\./)

  const shipped = ((await client.call('agent/read', { id: 'judge' })) as AgentEntry).path
  const builtin = (await client.call('workspace/readFile', { path: shipped })) as { content: string; hash: string }
  await assert.rejects(
    client.call('file/save', { path: shipped, content: builtin.content, expectedHash: builtin.hash }),
    /outside every open workspace/,
  )
})
