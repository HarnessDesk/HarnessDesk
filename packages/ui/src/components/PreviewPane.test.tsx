import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import { MountProvider } from '../panels/mount'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { PreviewPane } from './PreviewPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the too-large result for Markdown previews', async () => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async (method: string) => method === 'workspace/readFile'
      ? { kind: 'tooLarge', size: 2 * 1024 * 1024 + 1 }
      : { kind: 'file', isSymlink: false, modifiedAt: 1 }) },
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <MountProvider scope={{ area: 'main', id: 'preview-too-large', view: { kind: 'preview', path: '/work/large.md', runtime: runtimeId('claude') } }}>
        <PreviewPane />
      </MountProvider>
    </StoreProvider>,
  ))
  await act(async () => {})
  expect(container.textContent).toContain('File too large — 2.0 MB')
})
