import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { Markdown } from './Markdown'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const writeText = vi.fn<(text: string) => Promise<void>>()
const notice = vi.fn()
const snapshot = emptySnapshot()
const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, notice } as unknown as AppStore

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  writeText.mockResolvedValue()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  writeText.mockReset()
  notice.mockReset()
})

const render = (text: string): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Markdown text={text} />
      </StoreProvider>,
    )
  })
}

describe('fenced code in prose', () => {
  it('draws the named language and a copy action in a header', () => {
    render('```ts\nconst opened = true\n```')

    expect(container.querySelector('[data-code-language]')?.textContent).toBe('ts')
    expect(container.querySelector('button[aria-label="Copy this code"]')).not.toBeNull()
  })

  it('copies only the code, without the header', async () => {
    render('```ts\nconst opened = true\n```')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy this code"]')?.click()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('const opened = true\n')
  })

  it('leaves the language slot empty when the fence has no label', () => {
    render('```\nplain text\n```')

    expect(container.querySelector('[data-code-language]')).toBeNull()
    expect(container.querySelector('button[aria-label="Copy this code"]')).not.toBeNull()
  })

  it('announces a clipboard failure through the app notice', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    render('```ts\nconst opened = true\n```')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy this code"]')?.click()
      await Promise.resolve()
    })

    expect(notice).toHaveBeenCalledWith('warning', 'Could not copy to the clipboard.')
  })
})
