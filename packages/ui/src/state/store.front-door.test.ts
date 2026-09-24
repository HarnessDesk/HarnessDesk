import { beforeEach, expect, it, vi } from 'vitest'

import type { FrontDoorPreview, HostMethodName, StartContext } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * The front door's store state: one open request, and the one live
 * generation `previewFrontDoor` owns.
 *
 * The dry run a person sees before Start is store state, not a component's
 * own — a reply for a shape or set of variables this dialog has already
 * moved past can never land in `snapshot.frontDoor.preview` and enable Start
 * on a token nobody asked for any more.
 */

let store: AppStore

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
})

const CONTEXT: StartContext = { kind: 'project', root: '/repo' }

const previewOf = (token: string): FrontDoorPreview => ({
  flow: {
    token,
    compiled: { document: { format: 'agents', flow: { version: 2, name: 'Review', inputs: [], roles: [], rules: [], seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only', wait: 240 } }, bindings: [], problems: [] },
    seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
  },
  target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' },
  vars: {},
  source: 'version: 2\n',
  sentence: `Review — this project (${token})`,
  goal: null,
})

it('openFrontDoor sets the one open request; closeFrontDoor clears it', () => {
  expect(store.getSnapshot().frontDoor).toBeNull()
  store.openFrontDoor(CONTEXT)
  expect(store.getSnapshot().frontDoor).toEqual({ context: CONTEXT, goal: null, preview: null })
  store.closeFrontDoor()
  expect(store.getSnapshot().frontDoor).toBeNull()
})

it('openFrontDoor carries the empty Goal it reuses', () => {
  const goal = { id: 'goal-1', revision: 3 }
  store.openFrontDoor(CONTEXT, goal)
  expect(store.getSnapshot().frontDoor).toEqual({ context: CONTEXT, goal, preview: null })
})

it('previewFrontDoor calls authoring/start/preview with exactly the given input, and keeps the reply', async () => {
  const preview = previewOf('t1')
  const spy = vi.spyOn(store.transport, 'request').mockResolvedValue(preview)
  store.openFrontDoor(CONTEXT)

  const result = await store.previewFrontDoor({ context: CONTEXT, source: 'version: 2\n', vars: { branch: 'main' } })

  expect(result).toEqual(preview)
  expect(spy).toHaveBeenCalledWith('authoring/start/preview', { context: CONTEXT, source: 'version: 2\n', vars: { branch: 'main' } })
  expect(store.getSnapshot().frontDoor?.preview).toEqual(preview)
})

it('previewFrontDoor is a no-op on frontDoor.preview once the door is closed', async () => {
  const preview = previewOf('t1')
  vi.spyOn(store.transport, 'request').mockResolvedValue(preview)
  // No openFrontDoor call: nothing is open to write the reply into.
  const result = await store.previewFrontDoor({ context: CONTEXT, source: 'version: 2\n', vars: {} })
  expect(result).toEqual(preview)
  expect(store.getSnapshot().frontDoor).toBeNull()
})

it('clears the live preview synchronously on every call, before the request even resolves', async () => {
  const first = previewOf('t1')
  let resolveFirst!: (value: FrontDoorPreview) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async () => new Promise<FrontDoorPreview>((resolve) => { resolveFirst = resolve })) as never)
  store.openFrontDoor(CONTEXT)

  const inFlight = store.previewFrontDoor({ context: CONTEXT, source: 'version: 2\n', vars: {} })
  resolveFirst(first)
  await inFlight
  expect(store.getSnapshot().frontDoor?.preview).toEqual(first)

  // A second call — a different shape or a typed variable — must blank the
  // live preview immediately, synchronously, so a stale token cannot enable
  // Start for even one render while the fresh dry run is still in flight.
  vi.spyOn(store.transport, 'request').mockImplementation((async () => new Promise<FrontDoorPreview>(() => {})) as never)
  void store.previewFrontDoor({ context: CONTEXT, source: 'version: 2\nname: Other\n', vars: {} })
  expect(store.getSnapshot().frontDoor?.preview).toBeNull()
})

it('older preview cannot reenable Start: a stale reply landing after a newer request is dropped', async () => {
  store.openFrontDoor(CONTEXT)
  let resolveOld!: (value: FrontDoorPreview) => void
  let resolveNew!: (value: FrontDoorPreview) => void
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (_method: HostMethodName, params: unknown) => {
    const source = (params as { readonly source: string }).source
    return new Promise<FrontDoorPreview>((resolve) => {
      if (source === 'old') resolveOld = resolve
      else resolveNew = resolve
    })
  }) as never)

  // The person chooses a shape (the "old" request starts)…
  const old = store.previewFrontDoor({ context: CONTEXT, source: 'old', vars: {} })
  // …then changes their mind and chooses a different one before the first ever answers.
  const fresh = store.previewFrontDoor({ context: CONTEXT, source: 'new', vars: {} })

  // The newer request's own reply lands first…
  resolveNew(previewOf('new-token'))
  await fresh
  expect(store.getSnapshot().frontDoor?.preview?.flow.token).toBe('new-token')

  // …and the older one, asked for first, answers last. Its token must never
  // reach `frontDoor.preview` — a component reading store state for Start
  // can never see it, however late it arrives.
  resolveOld(previewOf('old-token'))
  await old
  expect(store.getSnapshot().frontDoor?.preview?.flow.token).toBe('new-token')
  expect(spy).toHaveBeenCalledTimes(2)
})
