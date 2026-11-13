import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { itemId, type SubagentItem } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ItemView } from './Items'

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

it('keeps a name handle non-openable and sanitizes the member and prompt as plain agent text', () => {
  const snapshot = emptySnapshot()
  const openSession = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openSession } as unknown as AppStore
  const item: SubagentItem = {
    id: itemId('spawn'), type: 'subagent', action: 'spawn', status: 'inProgress',
    prompt: '\u001b[31mRead <script>fixture</script>\u001b[0m',
    members: [{ sessionId: 'helper', nickname: '\u001b[31mScout <img src=x onerror=alert(1)>\u001b[0m', state: 'running', openable: false }],
  }
  act(() => root.render(<StoreProvider store={store}><ItemView item={item} /></StoreProvider>))
  expect(container.textContent).toContain('Scout <img src=x onerror=alert(1)>')
  expect(container.textContent).toContain('Read <script>fixture</script>')
  expect(container.textContent).not.toContain('\u001b')
  expect(container.querySelector('img, script')).toBeNull()
  const member = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.disabled)
  expect(member?.textContent).toContain('Scout')
  act(() => member!.click())
  expect(openSession).not.toHaveBeenCalled()
})
