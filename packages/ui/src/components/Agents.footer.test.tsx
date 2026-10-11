import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { Agents } from './Agents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('leaves the empty sub-agent footer blank instead of reporting zero started', async () => {
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  const onFoot = vi.fn()
  await act(async () => root.render(<StoreProvider store={store}>
    <Agents query="" onFoot={onFoot} />
  </StoreProvider>))
  expect(onFoot).toHaveBeenLastCalledWith('', '')
})
