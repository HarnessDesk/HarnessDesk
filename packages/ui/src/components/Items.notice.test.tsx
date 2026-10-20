import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { itemId, type AgentItem, type NoticeItem } from '@harnessdesk/protocol'
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
const render = (item: AgentItem) => {
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

it('does not infer an Agent brief from another notice’s brief-like text', () => {
  const { kind: _kind, ...notice } = brief
  render(notice)
  const toggle = container.querySelector<HTMLButtonElement>('button')!
  expect(toggle.textContent).toBe('Recorded note')
  expect(container.textContent).not.toContain('Agent brief')
  act(() => toggle.click())
  expect(container.textContent).toContain(brief.text)
  expect(container.querySelector('h2')).toBeNull()
})


it('folds long neutral recorded notes without guessing their text and preserves sanitized full content', () => {
  const text = 'Recorded setup information. '.repeat(30) + '<script>literal</script>\u001b[31mred\u001b[0m'
  render({ id: itemId('long-note'), type: 'notice', text, count: 2 })
  const toggle = container.querySelector<HTMLButtonElement>('button')!
  expect(toggle.textContent).toContain('Recorded note')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('Recorded setup information.')
  act(() => toggle.click())
  expect(container.textContent).toContain('Recorded setup information. '.repeat(30))
  expect(container.textContent).toContain('<script>literal</script>red')
  expect(container.textContent).not.toContain('\u001b')
  expect(container.querySelector('script')).toBeNull()
  expect(container.textContent).toContain('×2')
})

it('keeps long warnings visibly identified with a complete short summary and explicit full details', () => {
  const summary = 'A runtime setting needs attention.'
  const detail = 'Full diagnostic detail. '.repeat(100)
  render({ id: itemId('long-warning'), type: 'notice', kind: 'conversation:warning', text: `${summary}\n${detail}` })
  expect(container.querySelector('[data-slot="note"][data-tone="warn"]')?.textContent).toContain('Runtime warning')
  expect(container.textContent).toContain(summary)
  expect(container.textContent).not.toContain(detail)
  const toggle = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Show details')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  act(() => toggle.click())
  expect(container.textContent).toContain(detail)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
})

it('keeps a short warning and a long error fully visible', () => {
  render({ id: itemId('short-warning'), type: 'notice', kind: 'conversation:warning', text: 'The operation needs attention.' })
  expect(container.textContent).toContain('The operation needs attention.')
  expect(container.querySelector('button')).toBeNull()
  const message = 'This command failed and must be repaired. '.repeat(40)
  render({ id: itemId('long-error'), type: 'error', message })
  expect(container.textContent).toContain(message)
  expect(container.querySelector('button')).toBeNull()
})

it('does not fold a long normal reply or a person’s brief-like message', () => {
  const text = 'Card #1, Goal and lane are words a person can also write. '.repeat(20)
  render({ id: itemId('person-message'), type: 'userMessage', content: [{ type: 'text', text }] })
  expect(container.textContent).toContain(text)
  expect(container.textContent).not.toContain('Recorded note')
  render({ id: itemId('normal-reply'), type: 'assistantMessage', text })
  expect(container.textContent).toContain(text)
  expect(container.textContent).not.toContain('Recorded note')
})
