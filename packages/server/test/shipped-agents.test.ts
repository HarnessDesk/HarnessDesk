import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'

import { runtimeId, type FlowPermission, type SeatPlan, type Session } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { builtinAgentRoot } from '../src/host.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The Agents that ship with the app, each held to what a person relies on: it
 * parses with nothing wrong — not even a warning — it names runtimes and never
 * a model, its ceiling is the one this phase gives it, its brief says how it
 * reports and what it must never do, and it seats on the runtimes a desk
 * registers under those ids.
 */

/** What a shipped Agent is pinned to: the ceiling this phase gives it, and the words the flows that use it branch on. */
interface Shipped {
  readonly permission: FlowPermission
  readonly answers: readonly string[]
}

const SHIPPED: Readonly<Record<string, Shipped>> = {
  'api-reviewer': { permission: 'read', answers: ['approve', 'request-changes'] },
  'code-reviewer': { permission: 'read', answers: ['approve', 'request-changes'] },
  implementer: { permission: 'publish', answers: [] },
  judge: { permission: 'read', answers: ['picked', 'neither'] },
  'performance-reviewer': { permission: 'read', answers: ['approve', 'request-changes'] },
  'requirements-analyst': { permission: 'read', answers: ['agreed', 'disagree', 'met', 'not-met'] },
  researcher: { permission: 'read', answers: ['gathered'] },
  'security-reviewer': { permission: 'read', answers: ['approve', 'request-changes'] },
  'test-reviewer': { permission: 'read', answers: ['approve', 'request-changes'] },
}

/** No shipped Agent's description or brief may name a vendor, a product or a model — only `prefer` names runtimes. */
const NAMES_A_VENDOR = /\b(claude|codex|cursor|gemini|gpt|opus|sonnet)\b/i

test('the nine ship, and nothing else does', async () => {
  const folders = (await readdir(builtinAgentRoot(), { withFileTypes: true }))
    .filter((one) => one.isDirectory())
    .map((one) => one.name)
    .sort()
  assert.deepEqual(folders, Object.keys(SHIPPED).sort())
})

test('each parses with nothing wrong, names runtimes and not models, and says how it reports and what it never does', async () => {
  const agents = new Agents({ user: tempDir('hd-shipped-user-'), builtin: builtinAgentRoot() })
  for (const [id, { permission: ceiling, answers }] of Object.entries(SHIPPED)) {
    const entry = await agents.read(id)
    assert.ok(entry, `${id} is listed`)
    assert.deepEqual(entry.problems, [], `${id} has nothing wrong with it`)
    assert.equal(entry.origin, 'builtin')
    const definition = entry.definition
    assert.ok(definition, `${id} parsed`)
    assert.equal(definition.permission, ceiling, `${id}'s ceiling`)
    assert.deepEqual(
      definition.prefer,
      [{ runtime: 'claude-code' }, { runtime: 'codex' }, { runtime: 'cursor' }],
      `${id} names runtimes, in the one order every shipped Agent uses`,
    )
    assert.ok(definition.description && definition.description.length <= 120, `${id} says what it is for in one line`)
    assert.doesNotMatch(
      `${definition.description ?? ''}\n${definition.brief}`,
      NAMES_A_VENDOR,
      `${id} names no vendor, product or model — only \`prefer\` names a runtime`,
    )
    assert.deepEqual(definition.answers, answers, `${id} answers what the flows that use it depend on`)
    for (const word of answers) {
      // With its closing backtick: without it, `Verdict: approved` would pass for "approve", and
      // `Verdict: picked <branch> at <commit>` for "picked". Every answer word sits in a closed code span.
      assert.ok(
        definition.brief.includes('`Verdict: ' + word + '`'),
        `${id}'s brief ends a report on its own answer word, verbatim and nothing after it: \`Verdict: ${word}\``,
      )
    }
    assert.ok(definition.brief.includes('## How to report'), `${id}'s brief says how it reports`)
    // A report ends on its `Verdict:` line for a conversation, which has no board; this sentence carries that word
    // onto a flow's card. The judge's was lost once, in a rewrite of its last lines, while every other check here
    // stayed green.
    assert.ok(
      definition.brief.includes('On a board card, finish the card with'),
      `${id}'s brief says what to finish a board card with`,
    )
    assert.ok(definition.brief.includes('## What you never do'), `${id}'s brief says what it must never do`)
    assert.ok(/Verdict:/.test(definition.brief), `${id}'s brief ends a report on a verdict line`)
  }
})

/** A desk with the three runtimes the shipped Agents name, each a fake registered under its real id. */
const desk = async (t: TestContext, ids: readonly string[] = ['claude-code', 'codex', 'cursor']) => {
  const harness = await start()
  t.after(() => stop(harness))
  const fakes = ids.map((id) => new FakeRuntime({ id: runtimeId(id), name: id }))
  for (const fake of fakes) {
    harness.host.register(fake)
    await fake.start()
  }
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const work = tempDir('hd-shipped-work-')
  await client.call('workspace/open', { path: work })
  return { fakes, client, work }
}

test('each would sit on the first runtime it names, and seats there, holding read', async (t) => {
  const { fakes, client, work } = await desk(t)
  const plans = (await client.call('agent/seat/dry', { ids: Object.keys(SHIPPED) })) as SeatPlan[]
  // By id, not by count: a verb that drops one plan and repeats another still returns nine.
  assert.deepEqual(
    plans.map((plan) => plan.id).sort(),
    Object.keys(SHIPPED).sort(),
    'a plan for every one of the nine shipped Agents, none dropped and none duplicated',
  )
  for (const plan of plans) {
    assert.equal(plan.blocked, null, `${plan.id} can be weighed`)
    assert.equal(plan.winner, 0, `${plan.id} would sit on the first runtime it names`)
  }
  for (const id of Object.keys(SHIPPED)) {
    const session = (await client.call('agent/seat', { id, cwd: work })) as Session
    assert.equal(session.settings?.agent, id)
    assert.equal(String(session.runtime), 'claude-code')
    // Seated with no grant, so each holds read here whatever its ceiling: a ceiling is never a grant.
    assert.equal(session.settings?.permission, 'read')
  }
  assert.equal(fakes[0]?.sessions.size, Object.keys(SHIPPED).length)
})

test('with the first runtime not on this desk, each of the nine moves down its own list and says why', async (t) => {
  const { client, work } = await desk(t, ['codex', 'cursor'])
  for (const id of Object.keys(SHIPPED)) {
    const session = (await client.call('agent/seat', { id, cwd: work })) as Session
    assert.equal(String(session.runtime), 'codex', `${id} sits on the next runtime it names`)
    assert.deepEqual(
      session.settings?.passedOver?.map((one) => [one.runtimeName, one.reason?.kind, one.fix?.kind]),
      [['Claude', 'notInstalled', 'add']],
      `${id} says why it passed over the first runtime it names`,
    )
  }
})
