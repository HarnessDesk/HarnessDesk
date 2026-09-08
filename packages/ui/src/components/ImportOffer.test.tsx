import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { ImportableConfig, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { afterDismiss, type NoticeIdentity } from '../lib/notice-policy'
import { ImportOffer } from './ImportOffer'

/**
 * "Not now" has to mean not now, and not once per agent.
 *
 * The offer used to write a flag per runtime, so the same question came back
 * for every agent on the roster and again for each one registered afterwards —
 * four agents, four refusals of one decision. It is a `once` notice now, which
 * is the lifetime that answers a question for good.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const FOUND: readonly ImportableConfig[] = [
  { kind: 'SKILLS', label: 'Migrate skills from /home/u/.claude/skills' },
  { kind: 'MCP_SERVER_CONFIG', label: 'Migrate MCP servers from /home/u into /home/u/.codex' },
] as unknown as readonly ImportableConfig[]

const runtimeId = (value: string): RuntimeId => value as unknown as RuntimeId

const runtime = (id: string, name: string): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { extensionStore: true },
    presentation: { name },
  }) as unknown as RuntimeInfo

const makeStore = (over: Partial<AppSnapshot>) => {
  let snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtimeId('codex'),
    runtimes: [runtime('codex', 'OpenAI Codex'), runtime('cursor', 'Cursor')],
    preferencesLoaded: true,
    ...over,
  }
  const listeners = new Set<() => void>()
  let detections = 0
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    detectImports: () => {
      detections += 1
      return Promise.resolve(FOUND)
    },
    dismissStanding: (identity: NoticeIdentity) => {
      snapshot = { ...snapshot, noticePolicy: afterDismiss(snapshot.noticePolicy, identity, Date.now()) }
      for (const listener of listeners) listener()
    },
    policy: () => snapshot.noticePolicy,
    detections: () => detections,
  } as unknown as AppStore & {
    policy: () => AppSnapshot['noticePolicy']
    detections: () => number
  }
}

const mount = async (
  over: Partial<AppSnapshot>,
  onReview: () => void = () => {},
): Promise<ReturnType<typeof makeStore>> => {
  const store = makeStore(over)
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <ImportOffer onReview={onReview} />
      </StoreProvider>,
    )
  })
  return store
}

const notNow = (): HTMLButtonElement | null =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Not now',
  ) ?? null

it('offers what it found, once there is something to offer', async () => {
  await mount({})
  expect(container.textContent).toContain(
    'Your other agents have skills and servers this machine could share',
  )
  // The evidence is the *kind* of thing found, never the detector's label —
  // those labels carry absolute paths nobody can read in a glance.
  expect(container.textContent).toContain('It found skills and MCP servers')
  expect(container.textContent).not.toContain('/home/u')
  // The promise the Library keeps: the banner sells a preview, not a migration.
  expect(container.textContent).toContain('nothing is copied until you confirm it')
})

it('routes to the Library and never asks again — following the signpost answers it', async () => {
  let reviewed = 0
  const store = await mount({}, () => {
    reviewed += 1
  })
  const review = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Review in Library',
  )
  act(() => review?.click())
  expect(reviewed).toBe(1)
  expect(container.textContent).toBe('')

  // The question was answered by being followed: a later launch stays quiet.
  act(() => root.unmount())
  root = createRoot(container)
  await mount({ noticePolicy: store.policy() })
  expect(container.textContent).toBe('')
})

it('takes "not now" as an answer, for every agent and not just this one', async () => {
  const store = await mount({})
  act(() => notNow()?.click())
  expect(container.textContent).toBe('')

  // A later launch, on a different agent, reading the same host state.
  act(() => root.unmount())
  root = createRoot(container)
  const next = await mount({ activeRuntime: runtimeId('cursor'), noticePolicy: store.policy() })
  expect(container.textContent).toBe('')
  // And it did not even go looking: an answered question costs nothing to
  // re-ask only if nobody re-asks it.
  expect(next.detections()).toBe(0)
})

it('waits for the host before asking, so an answered question never flashes', async () => {
  const store = await mount({ preferencesLoaded: false })
  expect(container.textContent).toBe('')
  expect(store.detections()).toBe(0)
})
