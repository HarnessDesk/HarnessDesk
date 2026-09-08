import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  findOption,
  type AgentEvent,
  type AgentRuntime,
  type AgentSession,
  type ConfigOption,
  type SelectOption,
  type SessionOptions,
} from '@harnessdesk/protocol'

/**
 * The conformance suite.
 *
 * Every adapter runs it unmodified, against its own scripted backend. It
 * checks the contract the host and the renderer depend on — not what any
 * backend happens to do — so it is the thing that keeps "capability
 * negotiated" from quietly becoming "Codex shaped": a rule that only the
 * Codex adapter satisfies cannot be written here without the host's fake
 * runtime failing it too.
 *
 * The suite picks which option to change by itself — the first select with
 * more than one choice — so an adapter cannot pass by pointing it at the one
 * option that works. Where a backend has a toggle it cannot flip at runtime
 * the harness names one it can.
 */

export interface ConformanceHarness {
  /** A fresh runtime, not yet started. The suite starts and disposes it. */
  readonly create: () => Promise<AgentRuntime> | AgentRuntime
  /** How to open a session on it. */
  readonly sessionOptions: SessionOptions
  /**
   * A runtime-wide boolean option the suite may flip, for runtimes that
   * declare some it cannot change while running. Defaults to the first one.
   */
  readonly runtimeToggle?: string
}

const FLOWS = new Set(['browser', 'deviceCode', 'external'])

/** Collects events so a test can wait for one without racing the adapter. */
const record = (runtime: AgentRuntime) => {
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return {
    events,
    async until<T extends AgentEvent>(
      predicate: (event: AgentEvent) => event is T,
      timeoutMs = 5_000,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(predicate)
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(`timed out; saw ${events.map((e) => e.type).join(', ') || '(nothing)'}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

/** Every invariant the renderer relies on to draw a control without knowing the backend. */
export const assertWellFormedOptions = (options: readonly ConfigOption[], where: string): void => {
  const ids = new Set<string>()
  for (const option of options) {
    assert.ok(option.id.length > 0, `${where}: an option has an empty id`)
    assert.ok(!ids.has(option.id), `${where}: option id ${option.id} is declared twice`)
    ids.add(option.id)
    assert.ok(option.label.trim().length > 0, `${where}: option ${option.id} has no label`)
    if (option.type === 'boolean') {
      assert.equal(typeof option.currentValue, 'boolean', `${where}: ${option.id} is boolean but its value is not`)
      continue
    }
    assert.equal(option.type, 'select', `${where}: ${option.id} has an unknown type`)
    assert.ok(option.choices.length > 0, `${where}: select ${option.id} offers no choices`)
    const values = new Set<string>()
    for (const choice of option.choices) {
      assert.ok(choice.value.length > 0, `${where}: ${option.id} has a choice with an empty value`)
      assert.ok(!values.has(choice.value), `${where}: ${option.id} lists ${choice.value} twice`)
      values.add(choice.value)
      assert.ok(choice.label.trim().length > 0, `${where}: ${option.id} choice ${choice.value} has no label`)
    }
    assert.ok(
      values.has(option.currentValue),
      `${where}: ${option.id} is set to ${JSON.stringify(option.currentValue)}, which it does not offer — a select must always be able to render its current value`,
    )
  }
}

const changeableSelect = (options: readonly ConfigOption[]): SelectOption | undefined =>
  options.find(
    (option): option is SelectOption =>
      option.type === 'select' && !option.disabled && option.choices.length > 1,
  )

const otherChoice = (option: SelectOption): string => {
  const choice = option.choices.find((entry) => entry.value !== option.currentValue)
  if (!choice) throw new Error(`${option.id} has no alternative choice`)
  return choice.value
}

export const describeAdapterConformance = (name: string, harness: ConformanceHarness): void => {
  describe(`${name} conforms to AgentRuntime`, () => {
    const withRuntime = async (
      body: (runtime: AgentRuntime, tape: ReturnType<typeof record>) => Promise<void>,
    ): Promise<void> => {
      const runtime = await harness.create()
      try {
        await runtime.start()
        const tape = record(runtime)
        await body(runtime, tape)
      } finally {
        await runtime.dispose()
      }
    }

    const withSession = async (
      body: (session: AgentSession, runtime: AgentRuntime, tape: ReturnType<typeof record>) => Promise<void>,
      options: SessionOptions = harness.sessionOptions,
    ): Promise<void> =>
      withRuntime(async (runtime, tape) => {
        const session = await runtime.createSession(options)
        try {
          await body(session, runtime, tape)
        } finally {
          await session.close()
        }
      })

    test('describes itself without leaning on the shell', async () => {
      await withRuntime(async (runtime) => {
        assert.ok(runtime.info.id.length > 0)
        assert.ok(runtime.info.presentation.name.trim().length > 0, 'presentation.name is what the shell calls it')
        for (const [key, value] of Object.entries(runtime.info.capabilities)) {
          assert.equal(typeof value, 'boolean', `capability ${key} must be a boolean verb`)
        }
        assert.deepEqual(runtime.health(), { state: 'ready' })
      })
    })

    test('reports accounts and sign-in methods as lists', async () => {
      await withRuntime(async (runtime) => {
        const status = await runtime.getAccount()
        assert.ok(Array.isArray(status.accounts))
        assert.ok(Array.isArray(status.signInMethods))
        for (const account of status.accounts) {
          assert.ok(account.kind.length > 0 && account.label.length > 0)
        }
        for (const method of status.signInMethods) {
          assert.ok(FLOWS.has(method.flow), `unknown sign-in flow ${method.flow}`)
          assert.ok(method.id.length > 0 && method.label.length > 0)
        }
        if (!runtime.info.capabilities.account) {
          assert.equal(status.signInMethods.length, 0, 'no account means nothing to sign in to')
        }
      })
    })

    test('lists models with unique ids', async () => {
      await withRuntime(async (runtime) => {
        const models = await runtime.listModels()
        const ids = models.map((model) => model.id)
        assert.equal(new Set(ids).size, ids.length)
        for (const model of models) assert.ok(model.displayName.length > 0)
      })
    })

    test('a new session declares well-formed options, and announces them', async () => {
      await withSession(async (session, _runtime, tape) => {
        const options = session.options()
        assertWellFormedOptions(options, 'session.options()')
        const started = await tape.until(
          (event): event is Extract<AgentEvent, { type: 'session/started' }> =>
            event.type === 'session/started' && event.session.id === session.id,
        )
        assert.deepEqual(
          started.session.options,
          options,
          'the session/started event must carry the same options the session reports',
        )
        assert.equal(session.settings().cwd, harness.sessionOptions.cwd)
      })
    })

    /**
     * The invariant that makes leaving a conversation and coming back safe.
     *
     * The renderer opens a conversation by resuming it, every time — including
     * the one it was already showing a second ago, with a turn still running
     * in it. So resuming a session that is already live must hand back the
     * session that is live, not start a second one beside it: a fresh handle
     * would leave the running turn streaming into an orphan, and the work on
     * screen would stop moving.
     */
    test('resuming a live session hands back the session that is live', async () => {
      await withSession(async (session, runtime, tape) => {
        const before = tape.events.filter(
          (event) => event.type === 'session/started' && event.session.id === session.id,
        ).length
        const again = await runtime.resumeSession(session.id)
        assert.equal(again.id, session.id)
        assert.equal(again, session, 'the same handle, so the turn in flight keeps its listener')
        assert.equal(
          tape.events.filter(
            (event) => event.type === 'session/started' && event.session.id === session.id,
          ).length,
          before,
          'resuming what is already open announces nothing new',
        )
      })
    })

    test('changing a select option takes effect and is announced to everyone', async () => {
      await withSession(async (session, _runtime, tape) => {
        const option = changeableSelect(session.options())
        if (!option) return
        const target = otherChoice(option)
        const before = tape.events.length
        await session.setOption(option.id, target)

        const after = findOption(session.options(), option.id)
        assert.equal(after?.type === 'select' && after.currentValue, target)
        assertWellFormedOptions(session.options(), 'after setOption')

        const announced = tape.events
          .slice(before)
          .find(
            (event): event is Extract<AgentEvent, { type: 'session/options' }> =>
              event.type === 'session/options' && event.sessionId === session.id,
          )
        assert.ok(announced, 'a change must be announced as a session/options event')
        assert.equal(findOption(announced.options, option.id)?.currentValue, target)
      })
    })

    test('a value the option does not offer is refused, and nothing changes', async () => {
      await withSession(async (session) => {
        const option = changeableSelect(session.options())
        if (!option) return
        const before = session.options()
        await assert.rejects(() => session.setOption(option.id, 'definitely-not-a-choice'))
        assert.deepEqual(session.options(), before)
        await assert.rejects(
          () => session.setOption(option.id, true),
          'a boolean is not a select value',
        )
      })
    })

    test('an option the session does not declare is refused', async () => {
      await withSession(async (session) => {
        await assert.rejects(() => session.setOption('no-such-option', 'x'))
      })
    })

    test('a boolean option toggles', async () => {
      await withSession(async (session) => {
        const option = session
          .options()
          .find((entry) => entry.type === 'boolean' && !entry.disabled)
        if (!option || option.type !== 'boolean') return
        await session.setOption(option.id, !option.currentValue)
        assert.equal(findOption(session.options(), option.id)?.currentValue, !option.currentValue)
      })
    })

    test('initial option values are honoured, or refused — never half-applied', async () => {
      await withRuntime(async (runtime) => {
        const probe = await runtime.createSession(harness.sessionOptions)
        const option = changeableSelect(probe.options())
        await probe.close()
        if (!option) return
        const target = otherChoice(option)

        const session = await runtime.createSession({
          ...harness.sessionOptions,
          options: { [option.id]: target },
        })
        try {
          assert.equal(findOption(session.options(), option.id)?.currentValue, target)
        } finally {
          await session.close()
        }

        await assert.rejects(
          () =>
            runtime.createSession({
              ...harness.sessionOptions,
              options: { 'no-such-option': 'x' },
            }),
          'an unknown option id at creation must fail, not be ignored',
        )
      })
    })

    test('runtime-wide options, where declared, round-trip the same way', async () => {
      await withRuntime(async (runtime, tape) => {
        if (!runtime.listOptions) return
        const options = await runtime.listOptions()
        assertWellFormedOptions(options, 'runtime.listOptions()')
        const setOption = runtime.setOption?.bind(runtime)
        assert.ok(setOption, 'a runtime that lists options must accept changes to them')
        await assert.rejects(() => setOption('no-such-option', true))

        const id = harness.runtimeToggle ?? options.find((entry) => entry.type === 'boolean')?.id
        const toggle = id ? findOption(options, id) : undefined
        if (!toggle || toggle.type !== 'boolean') return
        await setOption(toggle.id, !toggle.currentValue)
        const after = findOption(await runtime.listOptions(), toggle.id)
        assert.equal(after?.currentValue, !toggle.currentValue)
        const announced = await tape.until(
          (event): event is Extract<AgentEvent, { type: 'runtime/options' }> =>
            event.type === 'runtime/options',
        )
        assert.equal(findOption(announced.options, toggle.id)?.currentValue, !toggle.currentValue)
      })
    })
  })
}
