import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { itemId, type NoticeItem } from '@harnessdesk/protocol'
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
const render = (item: NoticeItem) => {
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><ItemView item={item} /></StoreProvider>))
}
const brief = {
  id: itemId('brief'), type: 'notice', kind: 'agentBrief',
  text: '## Before you write code\n\n- Read the task.\n- Run the tests.\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))',
} satisfies NoticeItem

it('an Agent brief starts as one folded line and opens as sanitized Markdown', () => {
  render(brief)
  const toggle = container.querySelector<HTMLButtonElement>('button')
  expect(toggle?.textContent).toBe('Agent brief')
  expect(toggle?.getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('Read the task.')
  act(() => toggle!.click())
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelector('h2')?.textContent).toBe('Before you write code')
  expect([...container.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Read the task.', 'Run the tests.'])
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
  act(() => toggle!.click())
  expect(container.querySelector('h2')).toBeNull()
})

it('other notices keep their plain, unfolded appearance, even with brief-like text', () => {
  const { kind: _kind, ...notice } = brief
  render(notice)
  expect(container.textContent).toBe(brief.text)
  expect(container.querySelector('button')).toBeNull()
  expect(container.querySelector('h2')).toBeNull()
})
