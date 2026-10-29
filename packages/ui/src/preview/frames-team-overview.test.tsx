import { expect, it, vi } from 'vitest'
import { overviewPreviewStore } from './frames-team-overview'

const focused = vi.hoisted(() => ({ creates: 0 }))
vi.mock('./harness', async importOriginal => {
  const actual = await importOriginal<typeof import('./harness')>()
  return { ...actual, previewStore: (...args: Parameters<typeof actual.previewStore>) => {
    const [seed] = args
    if (seed && Object.keys(seed).sort().join(',') === 'accountsByRuntime,theme') focused.creates++
    return actual.previewStore(...args)
  } }
})

it('creates the focused preview store on demand and reuses the audited instance', () => {
  expect(focused.creates).toBe(0)
  const first = overviewPreviewStore()
  expect(overviewPreviewStore()).toBe(first)
  expect(first.getSnapshot().accountsByRuntime).toEqual({})
  expect(focused.creates).toBe(1)
})
