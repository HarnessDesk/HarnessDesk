import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodeBlock } from './CodeBlock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (node: React.ReactNode): void => {
  act(() => root.render(node))
}

describe('CodeBlock', () => {
  it('keeps the prompt, wrapping command, and named copy action on one command line', () => {
    render(<CodeBlock command="pnpm vitest run checkout" />)

    const line = container.querySelector('[data-slot="code-block-command"]')
    expect(line?.querySelector('[data-slot="code-block-prompt"]')?.textContent).toBe('$')
    expect(line?.querySelector('code')?.textContent).toBe('pnpm vitest run checkout')
    expect(line?.querySelector('button')?.getAttribute('aria-label')).toBe('Copy this command')
  })

  it('renders output and a non-zero exit as separate parts of the same plate', () => {
    render(<CodeBlock command="pnpm test" output="one suite failed" exitCode={1} />)

    const block = container.querySelector('[data-slot="code-block"]')
    expect(block?.querySelector('[data-slot="code-block-body"]')?.textContent).toBe('one suite failed')
    expect(block?.querySelector('[data-slot="code-block-exit"]')?.textContent).toBe('Exit code 1')
    expect(container.querySelectorAll('[data-slot="code-block"]')).toHaveLength(1)
  })

  it.each([0, null])('does not draw an exit line for %s', (exitCode) => {
    render(<CodeBlock output="complete" exitCode={exitCode} />)
    expect(container.querySelector('[data-slot="code-block-exit"]')).toBeNull()
  })
})
