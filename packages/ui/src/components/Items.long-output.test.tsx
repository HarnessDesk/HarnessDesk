import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { itemId, type AgentItem, type AssistantMessageItem, type NoticeItem, type ToolCallItem, type UserMessageItem } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import noteCss from '../design/patterns/Settings.module.css?raw'
import { ItemView } from './Items'
import itemsCss from './Items.module.css?raw'
import markdownCss from './Markdown.module.css?raw'

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

const token = 'x'.repeat(600)
const snapshot = emptySnapshot()

const renderItem = (item: AgentItem, open = false) => {
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><ItemView item={item} /></StoreProvider>))
  if (open) act(() => container.querySelector<HTMLButtonElement>('button')?.click())
}

describe('long transcript content stays inside the conversation column', () => {
  it('wraps a 600-character user message token', () => {
    const item: UserMessageItem = { id: itemId('long-user'), type: 'userMessage', content: [{ type: 'text', text: token }] }
    renderItem(item)
    expect(container.textContent).toContain(token)
    expect(container.querySelector('[data-slot="bubble-content"]')?.className).toContain('[overflow-wrap:anywhere]')
  })

  it('wraps a 600-character assistant prose token', () => {
    const item: AssistantMessageItem = { id: itemId('long-answer'), type: 'assistantMessage', text: token }
    renderItem(item)
    expect(container.textContent).toContain(token)
    expect(markdownCss).toMatch(/\.markdown\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  })

  it('wraps a 600-character notice token', () => {
    const item: NoticeItem = { id: itemId('long-notice'), type: 'notice', text: token }
    renderItem(item)
    expect(container.querySelector('[data-slot="note"]')?.textContent).toBe(token)
    expect(noteCss).toMatch(/\.note\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  })

  it('wraps a 600-character Markdown heading token', () => {
    const item: AssistantMessageItem = { id: itemId('long-heading'), type: 'assistantMessage', text: `# ${token}` }
    renderItem(item)
    expect(container.querySelector('h1')?.textContent).toBe(token)
    expect(markdownCss).toMatch(/\.markdown\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  })

  it('keeps a 600-character tool result inside its code plate', () => {
    const item = {
      id: 'long-tool', type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status: 'completed',
      args: {}, result: [{ type: 'text', text: token }],
    } as unknown as ToolCallItem
    renderItem(item, true)
    expect(container.querySelector('[data-slot="code-block-body"]')?.textContent).toBe(token)
    expect(markdownCss).toMatch(/\.markdown pre code\s*\{[^}]*overflow-x:\s*auto/s)
  })

  it('keeps code blocks and tables horizontally contained by their own boxes', () => {
    expect(markdownCss).toMatch(/\.markdown pre code\s*\{[^}]*overflow-x:\s*auto/s)
    expect(markdownCss).toMatch(/\.markdown table\s*\{[^}]*overflow-x:\s*auto/s)
    expect(itemsCss).toMatch(/\.wire\s*\{[^}]*overflow-wrap:\s*anywhere/s)
    expect(itemsCss).toMatch(/\.argValue\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  })
})
