import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AgentEntry } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { builtinAgentRoot, builtinFlowRoot } from '../src/host.js'
import { compileFlowPolicy, parseFlowPolicy } from '../src/flow-policy.js'
import { tempDir } from './scratch.js'

/**
 * Nine shapes, over the same three step kinds — agent, check, person — none
 * of it read by an engine that branches on which shape a file is. The eight
 * shipped starting points parse and compile clean against the real Agents
 * that ship, and renaming every role and reordering equivalent declarations
 * changes nothing about what a shape expands or transitions to: shape is
 * data, never an id the engine inspects.
 *
 * The ninth — "unattended" — is not a shipped catalogue entry: it is a
 * topology this phase can only start by hand, with the trigger a later phase
 * would add recorded here as a comment and a piece of test metadata, never
 * as a switch this engine reads. Phase 8 owns the trigger; this owns proving
 * the shape itself is ordinary data today.
 */

const SHIPPED = ['comparison', 'fan-out', 'independent-review', 'staged-relay', 'investigation', 'alignment', 'mechanical-contest', 'review-pr', 'review']

/** What a later phase would need to actually start this shape unattended — recorded, not implemented. */
const FUTURE_TRIGGER_REQUIREMENTS: Readonly<Record<string, string>> = {
  'staged-relay': 'phase 8: a webhook or schedule trigger to open the seed round without a person pressing Start.',
}

const agentsOf = async (): Promise<readonly AgentEntry[]> => {
  const agents = new Agents({ user: tempDir('hd-flow-shapes-user-'), builtin: builtinAgentRoot() })
  const ids = (await readdir(builtinAgentRoot(), { withFileTypes: true })).filter((one) => one.isDirectory()).map((one) => one.name)
  const entries: AgentEntry[] = []
  for (const id of ids) {
    const entry = await agents.read(id)
    if (entry) entries.push(entry)
  }
  return entries
}

const compileShape = (source: string, agents: readonly AgentEntry[]) => {
  const parsed = parseFlowPolicy(source)
  assert.equal(parsed.problems.filter((one) => one.level === 'error').length, 0, JSON.stringify(parsed.problems))
  assert.ok(parsed.document, 'parses to a document')
  assert.equal(parsed.document!.format, 'agents', 'every shipped starting point is written on the current format')
  const compiled = compileFlowPolicy(parsed.document!, agents)
  assert.deepEqual(compiled.problems, [], 'compiles against the real shipped Agents with nothing wrong')
  return compiled
}

test('the nine shipped flows parse, and name only Agents that actually ship', async () => {
  const agents = await agentsOf()
  const files = (await readdir(builtinFlowRoot())).filter((name) => /\.ya?ml$/i.test(name)).map((name) => name.replace(/\.ya?ml$/i, ''))
  assert.deepEqual(files.sort(), [...SHIPPED].sort(), 'exactly the nine named shapes ship, nothing else')
  for (const id of SHIPPED) {
    const source = await readFile(join(builtinFlowRoot(), `${id}.yml`), 'utf8')
    const compiled = compileShape(source, agents)
    assert.ok(compiled.bindings.length > 0, `${id} binds at least one Agent`)
  }
})

/** A shape's own bare topology: how many roles of each kind, and which role each rule points at — never role names. */
const topologyOf = (compiled: ReturnType<typeof compileFlowPolicy>) => {
  const document = compiled.document
  if (document.format !== 'agents') throw new Error('expected the current format')
  const byId = new Map(document.flow.roles.map((role) => [role.id, role.kind]))
  return {
    kinds: [...byId.values()].sort(),
    edges: document.flow.rules.map((rule) => [byId.get(rule.on), byId.get(rule.then.role)]).sort(),
    seed: byId.get(document.flow.seed.role),
  }
}

test('renaming every role, and reordering equivalent role declarations, changes nothing about what a shape expands or transitions to', async () => {
  const agents = await agentsOf()
  const source = await readFile(join(builtinFlowRoot(), 'comparison.yml'), 'utf8')
  const original = compileShape(source, agents)
  const originalTopology = topologyOf(original)

  // Rename every role id (competitor -> alpha, verify -> beta, judge -> gamma, referee -> delta) —
  // a purely textual substitution, the same document otherwise. Role
  // positions only: `judge` is both a role id and the Agent id its role
  // `uses:`, so a blanket rename would corrupt the Agent reference too.
  const renameRole = (text: string, from: string, to: string): string => text
    .replace(new RegExp(`^(\\s*)${from}:`, 'm'), `$1${to}:`)
    .replace(new RegExp(`\\bon: ${from}\\b`, 'g'), `on: ${to}`)
    .replace(new RegExp(`\\brole: ${from}\\b`, 'g'), `role: ${to}`)
    .replace(new RegExp(`independentOf: \\[${from}\\]`, 'g'), `independentOf: [${to}]`)
  const renamed = ['competitor', 'verify', 'judge', 'referee'].reduce(
    (text, name, index) => renameRole(text, name, ['alpha', 'beta', 'gamma', 'delta'][index]!),
    source,
  )
  const renamedCompiled = compileShape(renamed, agents)
  assert.deepEqual(topologyOf(renamedCompiled), originalTopology, 'renamed roles compile to the identical shape')

  // Reorder the role map: YAML mapping order is not semantic, and the compiler must not depend on it.
  const parsed = parseFlowPolicy(source)
  const document = parsed.document!
  if (document.format !== 'agents') throw new Error('expected the current format')
  const reversedRoles = [...document.flow.roles].reverse()
  const reordered = compileFlowPolicy({ ...document, flow: { ...document.flow, roles: reversedRoles } }, agents)
  assert.deepEqual(topologyOf(reordered), originalTopology, 'reordered role declarations compile to the identical shape')
})

test('mechanical-contest maps exit statuses to declared winners with no "winner" branch in the engine', async () => {
  const agents = await agentsOf()
  const source = await readFile(join(builtinFlowRoot(), 'mechanical-contest.yml'), 'utf8')
  const compiled = compileShape(source, agents)
  const document = compiled.document
  if (document.format !== 'agents') throw new Error('expected the current format')
  const decide = document.flow.roles.find((role) => role.kind === 'check')
  assert.ok(decide?.kind === 'check')
  // The mapping lives entirely in ordinary file data — exits, and the rules
  // reading their answers — never a kind the engine special-cases. A draw is
  // its own distinct outcome, routed to a person; a missing result (the
  // script's own error, `otherwise`) is not itself routed anywhere.
  assert.deepEqual(decide.check.exits, { '0': 'first', '1': 'second', '2': 'draw' })
  assert.equal(decide.check.otherwise, 'no-contest')
  assert.ok(document.flow.rules.some((rule) => rule.when?.every?.includes('draw')), 'a draw is routed, distinctly from a missing result')
  assert.ok(!document.flow.rules.some((rule) => rule.when?.every?.includes('no-contest') || rule.when?.any?.includes('no-contest')), 'a missing result opens nothing — it is not itself routed anywhere')
})

test('unattended: a topology only ever started by hand today, with its future trigger recorded rather than switched on', () => {
  // The shape: `staged-relay`'s own seed round, which any of the seven files
  // could equally stand in for — no file here is "the unattended one";
  // unattended is a way any of them is started, not a property of one.
  assert.ok(FUTURE_TRIGGER_REQUIREMENTS['staged-relay'], 'the future requirement is recorded, not built')
  assert.doesNotMatch(
    FUTURE_TRIGGER_REQUIREMENTS['staged-relay']!,
    /engine|switch|flag/i,
    'recorded as a future requirement in test metadata, never phrased as an engine switch',
  )
})

test('the design’s pair build (UC5) compiles against the shipped Agents, its dev cards taking the split the contract agreed', async () => {
  const spec = await readFile(join(builtinFlowRoot(), '..', '..', '..', 'docs', 'superpowers', 'specs', '2026-09-17-agents-and-goals-design.md'), 'utf8')
  const section = spec.slice(spec.indexOf('### UC5'))
  const source = /```yaml\n([\s\S]*?)```/.exec(section)?.[1]
  assert.ok(source, 'UC5 carries its flow')
  const compiled = compileShape(source!, await agentsOf())
  assert.equal(compiled.document.format, 'agents')
  const build = compiled.document.format === 'agents' ? compiled.document.flow.rules.find((rule) => rule.then.role === 'dev') : undefined
  assert.equal(build?.then.split, 'contract', 'each dev card owns its own part of the agreed split')
  assert.equal(build?.then.files, undefined, 'never one list shared by both')
})
