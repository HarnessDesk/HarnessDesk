import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApprovalDialog, type ApprovalDialogAction } from './ApprovalDialog'

const actions: readonly ApprovalDialogAction[] = [
  {
    id: 'deny',
    label: 'Deny',
    shortcut: 1,
    placement: 'safe',
    onSelect: vi.fn(),
  },
  {
    id: 'allow',
    label: 'Allow',
    shortcut: 2,
    placement: 'proceed',
    onSelect: vi.fn(),
  },
]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ApprovalDialog', () => {
  it('has no hidden dismiss control and re-enters focus for the next queued approval', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    const render = (focusKey: string) => act(() => root.render(
      <ApprovalDialog title="Permission" icon={null} focused focusKey={focusKey} actions={actions}>
        Review this request.
      </ApprovalDialog>,
    ))

    await render('first')
    const surface = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')
    expect(surface).not.toBeNull()
    expect(document.activeElement).toBe(surface)
    expect(document.querySelector('[aria-label="Choose the safe answer"]')).toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(2)

    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    await render('second')
    expect(document.activeElement).toBe(surface)

    await act(() => root.unmount())
  })
})
