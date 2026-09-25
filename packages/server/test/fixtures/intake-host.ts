import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RuntimeInfo, WireNotification } from '@harnessdesk/protocol'

import { Host, StateStore } from '../../src/index.js'
import type { IntakeTimers } from '../../src/intake/plane.js'
import { makeRepo, type Repo } from './evidence-desk.js'
import { FakeRuntime } from './fake-runtime.js'
import { HoldFake } from './hold-runtime.js'
import { silent } from './harness.js'
import { Clocks, FakeForge } from './intake-forge.js'
import { tempDir } from '../scratch.js'

/**
 * A real `Host` over a real git repository whose committed
 * `.harnessdesk/triggers.yml` names one pull-request trigger, with the fake
 * forge answering its reads, a fake runtime seating its Agent, clocks the
 * test moves, and timers that run only when the test fires them. Nothing
 * here touches a network, a vendor or an account: the forge is synthetic,
 * signed in as a placeholder, over `acme/widgets`.
 */

export const TRIGGERS = `- id: review
  on: pull-request
  opens: { flow: review-pr }
  again: { role: reviewer }
`

export const REVIEW_FLOW = `version: 2
name: Review a pull request
roles:
  reviewer: { kind: agent, uses: reviewer, grant: read }
seed: { role: reviewer, title: Review it }
rules: []
`

/** Timers a test fires by hand: what is registered, and nothing runs on its own. */
export class ManualTimers implements IntakeTimers {
  readonly live = new Map<number, { readonly fn: () => void; readonly ms: number }>()
  #next = 1
  readonly every = (fn: () => void, ms: number): unknown => {
    const id = this.#next++
    this.live.set(id, { fn, ms })
    return id
  }
  readonly clear = (handle: unknown): void => { this.live.delete(handle as number) }
}

export interface IntakeDesk {
  readonly host: Host
  readonly runtime: FakeRuntime
  readonly repo: Repo
  readonly stateDir: string
  readonly forge: FakeForge
  readonly clocks: Clocks
  readonly timers: ManualTimers
  /** Every notification the host pushed, in order. */
  readonly pushed: WireNotification[]
  stop(): Promise<void>
}

export const commitTriggers = async (repo: Repo, triggers = TRIGGERS): Promise<void> => {
  await mkdir(join(repo.dir, '.harnessdesk', 'flows'), { recursive: true })
  await writeFile(join(repo.dir, '.harnessdesk', 'triggers.yml'), triggers)
  await writeFile(join(repo.dir, '.harnessdesk', 'flows', 'review-pr.yml'), REVIEW_FLOW)
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'triggers')
}

export const writeAgent = async (stateDir: string, prefer = 'fake'): Promise<void> => {
  await mkdir(join(stateDir, 'agents', 'reviewer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'reviewer', 'AGENT.md'), [
    '---', 'name: reviewer', 'ceiling: read', 'answers: [approve, request-changes]', `prefer: [${prefer}]`, '---', 'Review the change.', '',
  ].join('\n'), 'utf8')
}

/** A started host on `stateDir` (fresh by default) over `repo` (a new one with the triggers committed by default). */
export const intakeDesk = async (options: {
  readonly stateDir?: string
  readonly repo?: Repo
  readonly forge?: FakeForge
  readonly clocks?: Clocks
  readonly triggers?: string | null
  /**
   * Whether the agent's runtime holds the ceiling a Seat needs (`holds`, the
   * default) or can only ask it (`asks`). Unattended seating refuses an asked
   * ceiling unless a person chose otherwise, so `holds` is what lets the
   * shipped default seat anyone at all.
   */
  readonly runtime?: 'holds' | 'asks'
  /** The Agent's seat preference, `fake` by default; `fake=fake-1` seats it on that model. */
  readonly prefer?: string
  /** Runs on the fake agent after it is registered and before the host starts. */
  readonly before?: (runtime: FakeRuntime) => void
} = {}): Promise<IntakeDesk> => {
  const repo = options.repo ?? await makeRepo('hd-intake-host-')
  if (!options.repo && options.triggers !== null) await commitTriggers(repo, options.triggers ?? TRIGGERS)
  const stateDir = options.stateDir ?? tempDir('hd-intake-host-state-')
  await writeAgent(stateDir, options.prefer)
  const forge = options.forge ?? new FakeForge()
  const clocks = options.clocks ?? new Clocks(Date.now())
  const timers = new ManualTimers()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-intake-host-builtins-'),
    builtinFlows: tempDir('hd-intake-host-flows-'),
    catalogRefreshMs: 0,
    intake: {
      gh: forge.runner,
      now: () => clocks.wall,
      monotonic: () => clocks.mono,
      timers,
      // Every read covers everything and finds nothing yet: a fresh Seat's spend is a known zero.
      usage: async () => ({ samples: [], complete: true }),
    },
  })
  const runtime = options.runtime === 'asks' ? new FakeRuntime({ capabilities: { metered: true } }) : holding()
  host.register(runtime)
  options.before?.(runtime)
  const pushed: WireNotification[] = []
  host.addBroadcaster((notification) => { pushed.push(notification) })
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  let stopped = false
  return {
    host, runtime, repo, stateDir, forge, clocks, timers, pushed,
    stop: async () => {
      if (stopped) return
      stopped = true
      await host.dispose()
    },
  }
}

/** The fake agent, under the id the Agent prefers, able to hold the read and edit ceilings a Seat asks for. */
const holding = (): FakeRuntime => {
  const runtime = new HoldFake('fake')
  const info = runtime.info
  ;(runtime as { info: RuntimeInfo }).info = { ...info, capabilities: { ...info.capabilities, metered: true } }
  return runtime
}

/** Waits for a state of the desk, read again every few milliseconds; says what it waited for when it gives up. */
export const until = async <T>(read: () => Promise<T | null | undefined> | T | null | undefined, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
