import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { CaptureHealth } from '@harnessdesk/protocol'

import { captureHealth, PROVENANCE_ROOT } from '../preview/provenance-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ProjectProvenance } from './ProjectProvenance'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let reactRoot: Root
let snapshot: AppSnapshot
let store: AppStore
let notify: () => void
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const keep = (health: CaptureHealth) => {
  snapshot = { ...snapshot, captureHealth: new Map(snapshot.captureHealth).set(health.project, health) }
  notify()
}
const render = async (root = PROVENANCE_ROOT) => {
  await act(async () => reactRoot.render(<StoreProvider store={store}><ProjectProvenance root={root} /></StoreProvider>))
}
const toggle = () => host.querySelector<HTMLElement>('[role="switch"]')
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name)!

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); reactRoot = createRoot(host)
  notify = () => {}
  snapshot = { ...emptySnapshot(), status: 'open', captureHealth: new Map([[PROVENANCE_ROOT, captureHealth()]]) }
  store = {
    subscribe: (listener: () => void) => { notify = listener; return () => { notify = () => {} } },
    getSnapshot: () => snapshot,
    loadCaptureHealth: vi.fn(async () => {}),
    setCapture: vi.fn(async (_root: string, enabled: boolean) => {
      const result = captureHealth({ enabled, state: enabled ? 'healthy' : 'stopped', revision: 2 })
      keep(result); return result
    }),
    retryCapture: vi.fn(async () => captureHealth()),
  } as unknown as AppStore
})
afterEach(() => { act(() => reactRoot.unmount()); host.remove() })

it('default-on capture displays the host reason and next step', async () => {
  await render()
  expect(toggle()?.getAttribute('aria-checked')).toBe('true')
  expect(host.textContent).toContain(captureHealth().reason)
  expect(host.textContent).toContain(captureHealth().nextStep)
  expect(host.querySelector('[data-tone="success"]')).not.toBeNull()
})

it('a pending preference write keeps the saved value visible and disables both actions', async () => {
  snapshot = { ...snapshot, captureHealth: new Map([[PROVENANCE_ROOT, captureHealth({ enabled: false, state: 'stopped' })]]) }
  const pending = deferred<CaptureHealth>(); vi.mocked(store.setCapture).mockReturnValue(pending.promise)
  await render(); await act(async () => toggle()?.click())
  expect(store.setCapture).toHaveBeenCalledWith(PROVENANCE_ROOT, true)
  expect(toggle()?.getAttribute('aria-checked')).toBe('false')
  expect(toggle()?.getAttribute('aria-disabled')).toBe('true')
  expect(button('Retry capture').disabled).toBe(true)
  await act(async () => pending.reject(new Error('private path')))
  expect(toggle()?.getAttribute('aria-checked')).toBe('false')
  expect(host.textContent).toContain('The capture preference could not be saved.')
  expect(host.textContent).not.toContain('private path')
})

it('a saved off preference remains visible and enabling only updates after success', async () => {
  await render(); await act(async () => toggle()?.click())
  expect(toggle()?.getAttribute('aria-checked')).toBe('false')
  expect(host.textContent).toContain('Turn capture on before retrying.')
  expect(button('Retry capture').disabled).toBe(true)
  await act(async () => toggle()?.click())
  expect(toggle()?.getAttribute('aria-checked')).toBe('true')
})

it('retry is serialized, reports failure, and does not change the saved enabled value', async () => {
  const pending = deferred<CaptureHealth>(); vi.mocked(store.retryCapture).mockReturnValue(pending.promise)
  await render(); await act(async () => button('Retry capture').click())
  expect(toggle()?.getAttribute('aria-disabled')).toBe('true')
  expect(button('Retry capture').disabled).toBe(true)
  await act(async () => pending.reject(new Error('no access')))
  expect(host.textContent).toContain('Capture could not be retried.')
  expect(toggle()?.getAttribute('aria-checked')).toBe('true')
})

it('loading and a failed status read have distinct states and a Retry path', async () => {
  const pending = deferred<void>(); vi.mocked(store.loadCaptureHealth).mockReturnValueOnce(pending.promise)
  await render(); expect(host.textContent).toContain('Reading capture status'); expect(toggle()).toBeNull()
  await act(async () => pending.reject(new Error('private status')))
  expect(host.textContent).toContain('Capture status could not be read.')
  await act(async () => button('Retry status').click())
  expect(toggle()?.getAttribute('aria-checked')).toBe('true')
})

it('non-Git and unavailable folders retain a disabled control with the right reason', async () => {
  snapshot = { ...snapshot, captureHealth: new Map(), workspaces: [{ path: PROVENANCE_ROOT, name: 'project', lastOpenedAt: 1, git: null, repo: null }] }
  await render(); expect(host.textContent).toContain('This folder has no Git history to capture.'); expect(store.loadCaptureHealth).not.toHaveBeenCalled(); expect(toggle()?.getAttribute('aria-disabled')).toBe('true')
  await render('/work/missing'); expect(host.textContent).toContain('Capture is unavailable for this folder.'); expect(toggle()?.getAttribute('aria-disabled')).toBe('true')
})

it('refused, watch failure, backlog, and gap health preserve host explanations', async () => {
  for (const health of [captureHealth({ state: 'stopped', reason: 'Repository metadata is refused.', nextStep: 'Use a supported checkout.' }), captureHealth({ state: 'degraded', reason: 'Watching failed; polling continues.', nextStep: 'Retry capture.' }), captureHealth({ state: 'degraded', reason: 'Catching up.', pending: 20 }), captureHealth({ state: 'degraded', reason: 'A ref history is missing.', gaps: 1 })]) {
    snapshot = { ...snapshot, captureHealth: new Map([[PROVENANCE_ROOT, health]]) }; await render()
    expect(host.textContent).toContain(health.reason)
    if (health.pending) expect(host.textContent).toContain('20 commits are waiting for capture.')
    if (health.gaps) expect(host.textContent).toContain('Retrying cannot recreate history Git no longer has.')
  }
})

it('a root switch retires an old action error', async () => {
  const pending = deferred<CaptureHealth>(); vi.mocked(store.setCapture).mockReturnValue(pending.promise)
  snapshot = { ...snapshot, captureHealth: new Map([[PROVENANCE_ROOT, captureHealth()], ['/work/next', captureHealth({ project: '/work/next', reason: 'Next project.' })]]) }
  await render(); await act(async () => toggle()?.click()); await render('/work/next'); await act(async () => pending.reject(new Error('old')))
  expect(host.textContent).toContain('Next project.'); expect(host.textContent).not.toContain('could not be saved')
})

it('linked checkouts use their canonical project and disconnected controls are unavailable', async () => {
  snapshot = { ...snapshot, workspaces: [{ path: '/work/tree', name: 'tree', lastOpenedAt: 1, repo: { root: PROVENANCE_ROOT, worktree: true } }] }
  await render('/work/tree'); expect(toggle()?.getAttribute('aria-checked')).toBe('true')
  snapshot = { ...snapshot, status: 'reconnecting' }; await render('/work/tree')
  expect(host.textContent).toContain('Capture status is unavailable while disconnected.'); expect(toggle()).toBeNull()
})

it('a late status rejection cannot turn the next project into an error', async () => {
  const pending = deferred<void>(); vi.mocked(store.loadCaptureHealth).mockReturnValueOnce(pending.promise)
  await render('/work/old'); await render(); await act(async () => pending.reject(new Error('old private failure')))
  expect(host.textContent).not.toContain('could not be read'); expect(toggle()?.getAttribute('aria-checked')).toBe('true')
})

it('an uninspected recent workspace is not declared non-Git', async () => {
  snapshot = { ...snapshot, workspaces: [{ path: PROVENANCE_ROOT, name: 'project', lastOpenedAt: 1, git: null }] }
  await render(); expect(store.loadCaptureHealth).toHaveBeenCalledWith(PROVENANCE_ROOT); expect(host.textContent).not.toContain('This folder has no Git history to capture.')
})
