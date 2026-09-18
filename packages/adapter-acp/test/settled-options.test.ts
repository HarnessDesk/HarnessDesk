import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'

import { AcpRuntime } from '../src/index.js'

/**
 * What a pick settled on is what the agent said, never what was asked.
 *
 * An agent is free to settle a pick somewhere else and still answer the call
 * without an error. Cursor's bridge does it by design: a pick moves what is
 * *wanted*, and the session runs the nearest variant the family has. So the
 * value a control holds once the call is answered is the agent's word — in its
 * answer, or announced while the call was open — and the value asked for
 * stands only where the agent said nothing about it at all. Anything else is a
 * session reporting a model, an effort or a thinking switch it is not running,
 * and every reader above it — a seat's read-back, a flow's label, the picker —
 * repeating the claim as a fact.
 *
 * The agent here is `variant-acp-agent.mjs`: two variants, (high, no thinking)
 * and (medium, thinking), and nothing in between.
 */

const VARIANT = fileURLToPath(new URL('./fixtures/variant-acp-agent.mjs', import.meta.url))

const variant = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({ id: 'variant', name: 'Variant', command: process.execPath, args: [VARIANT], env })

/** Effort and thinking, as the session reports them. */
const running = (session: AgentSession) => {
  const options = session.options()
  return {
    effort: options.find((option) => option.id === 'effort')?.currentValue,
    thinking: options.find((option) => option.id === 'thinking')?.currentValue,
  }
}

/** Every `session/options` a window was sent for this conversation. */
const told = (events: readonly AgentEvent[], session: AgentSession) =>
  events.filter(
    (event): event is Extract<AgentEvent, { type: 'session/options' }> =>
      event.type === 'session/options' && event.sessionId === session.id,
  )

/*
 * One script, played against each way an agent says where a pick landed.
 * Thinking on is asked of the high variant, which has none: it stays off.
 * Medium effort comes with thinking, which nobody asked for, and turning it
 * off is asked and declined — medium without thinking does not exist.
 */
for (const [answer, how] of [
  ['announce', 'announced before the answer, which says nothing'],
  ['reply', 'said in the answer, and nowhere else'],
] as const) {
  test(`a pick the agent settles elsewhere holds what the agent ${how}`, async () => {
    const runtime = variant({ VARIANT_ANSWER: answer })
    const events: AgentEvent[] = []
    runtime.subscribe((event) => events.push(event))
    await runtime.start()
    try {
      const session = await runtime.createSession({ cwd: '/tmp/acp-variant' })
      assert.deepEqual(running(session), { effort: 'high', thinking: false })

      await session.setOption('thinking', true)
      assert.deepEqual(running(session), { effort: 'high', thinking: false }, 'high has no thinking variant')
      // And the window is told what runs, not what was asked.
      const after = told(events, session).at(-1)?.options.find((option) => option.id === 'thinking')
      assert.equal(after?.currentValue, false)

      await session.setOption('effort', 'medium')
      assert.deepEqual(running(session), { effort: 'medium', thinking: true }, 'medium comes with thinking')

      await session.setOption('thinking', false)
      assert.deepEqual(running(session), { effort: 'medium', thinking: true }, 'and it does not come without')
    } finally {
      await runtime.dispose()
    }
  })
}

test('an answer that names some controls sets those, keeps the rest, and says nothing for the one asked about', async () => {
  // claude-acp answers a change to a control it keeps itself with those
  // controls alone. ACP calls the answer the full set; read that way, this
  // answer would take the model and effort controls off the conversation.
  const runtime = variant({ VARIANT_ANSWER: 'own' })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/acp-variant' })

    // The answer names thinking, which is the control asked about: its word stands.
    await session.setOption('thinking', true)
    assert.deepEqual(running(session), { effort: 'high', thinking: false })

    // It names thinking again, and not effort: effort stays at what was asked,
    // because the agent said nothing about it, and thinking moves to what it said.
    await session.setOption('effort', 'medium')
    assert.deepEqual(running(session), { effort: 'medium', thinking: true })
    assert.deepEqual(
      session.options().map((option) => option.id),
      ['model', 'effort', 'thinking'],
      'the controls the answer did not name are still there',
    )
  } finally {
    await runtime.dispose()
  }
})

test('a model the agent settles on another is the model the session reports', async () => {
  // Announced the bridge's way — the model, then every control — and answered with null.
  const runtime = variant()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/acp-variant' })
    await session.setOption('model', 'fam-legacy')
    assert.equal(session.settings().model, 'fam')
    assert.equal(session.options().find((option) => option.id === 'model')?.currentValue, 'fam')
  } finally {
    await runtime.dispose()
  }
})
