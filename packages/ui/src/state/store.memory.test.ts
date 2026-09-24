import { beforeEach, expect, it, vi } from 'vitest'

import type {
  GoalCitation,
  GoalView,
  HostMethodName,
  MemoryFile,
  MemoryResolution,
  SeatAttachmentsRecord,
  WireNotification,
} from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * The three memory/attachment reads (`readMemoryFiles`, `readMemoryCitation`,
 * `readSeatAttachments`) are plain pass-throughs with no store-side state of
 * their own — the same shape as `readProvenance`/`projectChecks` — so a slow
 * reply from a project or Seat no longer on screen is the calling
 * component's own guard to keep, not the store's (every one of `MemoryCitation`
 * and `SeatAttachments`'s reads carries a `live` flag that a `root`/`seat`
 * prop change tears down before the next one starts).
 *
 * The one call here that *does* touch shared store state is `citeMemory`,
 * through the same `#refreshGoal`/`#keepGoal` path every other Goal mutation
 * already uses. This proves it actually benefits from that path's existing
 * revision guard, rather than a citation confirmation writing the read-back
 * view over the snapshot unconditionally: "stale project reply cannot leak
 * into next project" landing here as the Goal-revision version of that rule,
 * since a citation's own reads carry nothing to regress.
 */

const view = (id: string, revision = 1, root = '/repo', activity: GoalView['activity'] = 'working'): GoalView => ({
  goal: {
    id, root, cwd: root, sentence: `Finish ${id}`, state: 'open', revision,
    checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1,
    updatedAt: revision, receipt: null,
  },
  activity,
  waitingOn: [],
  members: [],
  board: { id, name: `Finish ${id}`, root, updatedAt: revision, members: [], messaging: true, intents: [], channel: [] },
  receipt: null,
  problem: null,
})

const changed = (store: AppStore, next: GoalView): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification({ method: 'goal/changed', params: { view: next } })
}

let store: AppStore

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
})

const CITATION: GoalCitation = { goal: 'source', receipt: 'r1', project: '/repo', path: '.harnessdesk/memory/x.md', at: 'a'.repeat(40) }

it('citing into a Goal never lets its own delayed read-back regress a newer view already on screen', async () => {
  let answerRead: ((next: GoalView) => void) | null = null
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'goal/cite') return null
    if (method === 'goal/read') return new Promise((resolve) => { answerRead = resolve as (next: GoalView) => void })
    return null
  }) as never)

  const pending = store.citeMemory('g', CITATION)
  // Let `goal/cite` itself resolve before its own `goal/read` is even asked for.
  await Promise.resolve()
  await Promise.resolve()
  // A live push lands first — another window's own change, arriving while this citation's own read-back is still in flight.
  changed(store, view('g', 5, '/repo', 'ready-to-wrap'))
  // The citation's own read-back answers last, and with an older revision.
  answerRead!(view('g', 2))
  await pending

  expect(store.getSnapshot().goals.get('g')?.goal.revision).toBe(5)
  expect(store.getSnapshot().goals.get('g')?.activity).toBe('ready-to-wrap')
})

it('memory and attachment reads carry exactly the params named on the wire, nothing patched into the snapshot', async () => {
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'memory/list') return [{ path: '.harnessdesk/memory/x.md', at: 'a'.repeat(40), problem: null }] satisfies readonly MemoryFile[]
    if (method === 'memory/read') return { state: 'unavailable', citation: params as GoalCitation, reason: 'The original source was not retained.' } satisfies MemoryResolution
    if (method === 'attachment/seat') return null as SeatAttachmentsRecord | null
    return null
  }) as never)

  const before = store.getSnapshot()
  await store.readMemoryFiles('/repo', 'a'.repeat(40))
  await store.readMemoryCitation('/repo', CITATION)
  await store.readSeatAttachments('seat-1' as SeatAttachmentsRecord['seat'])

  expect(request).toHaveBeenCalledWith('memory/list', { root: '/repo', at: 'a'.repeat(40) })
  expect(request).toHaveBeenCalledWith('memory/read', { root: '/repo', citation: CITATION })
  expect(request).toHaveBeenCalledWith('attachment/seat', { seat: 'seat-1' })
  // None of the three is a snapshot-mutating read — the store's other state is untouched.
  expect(store.getSnapshot()).toEqual(before)
})
