import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import * as editor from './index'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('renders file paragraphs through the existing sanitizer', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><editor.MarkdownView text={'# Notes\n\nWrapped\nparagraph.\n\n<script>window.fileExecuted = true</script>\n\n[unsafe](javascript:alert(1))\n\n<img src="https://example.com/image.png" onerror="alert(1)">'} /></StoreProvider>))
    expect(container.querySelector('h1')?.textContent).toBe('Notes')
    expect(container.querySelector('br')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).not.toContain('fileExecuted')
    expect(container.querySelector('[onerror], a[href^="javascript:"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})
