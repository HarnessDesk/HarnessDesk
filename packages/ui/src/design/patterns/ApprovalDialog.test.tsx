import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ApprovalCode,
  ApprovalDialog,
  ApprovalFilePath,
  ApprovalMeta,
  ApprovalPermissionList,
  ApprovalQuestionText,
  ApprovalReason,
  type ApprovalDialogAction,
} from './ApprovalDialog'

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

  it('owns the readable anatomy inside an approval', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    await act(() => root.render(
      <>
        <ApprovalReason>Needed to finish the task.</ApprovalReason>
        <ApprovalCode>pnpm verify</ApprovalCode>
        <ApprovalMeta label="in">/workspace</ApprovalMeta>
        <ApprovalFilePath>src/app.ts</ApprovalFilePath>
        <ApprovalPermissionList><li>/tmp/report</li></ApprovalPermissionList>
        <ApprovalQuestionText>Which environment?</ApprovalQuestionText>
      </>,
    ))

    expect(host.querySelector('[data-slot="approval-reason"]')?.tagName).toBe('P')
    expect(host.querySelector('[data-slot="approval-code"]')?.tagName).toBe('PRE')
    expect(host.querySelector('[data-slot="approval-meta"]')?.textContent).toBe('in/workspace')
    expect(host.querySelector('[data-slot="approval-file-path"]')?.textContent).toBe('src/app.ts')
    expect(host.querySelector('[data-slot="approval-permission-list"]')?.tagName).toBe('UL')
    expect(host.querySelector('[data-slot="approval-question"]')?.tagName).toBe('P')

    await act(() => root.unmount())
  })

  it('docked, is a card in normal flow: no portal, no scrim, not a dialog, one filled act', async () => {
    const host = document.createElement('div')
    const before = document.createElement('p')
    before.textContent = 'The thread above'
    host.append(before)
    document.body.append(host)
    const slot = document.createElement('div')
    host.append(slot)
    const root = createRoot(slot)
    const three: readonly ApprovalDialogAction[] = [
      { id: 'deny', label: 'Deny', shortcut: 3, placement: 'safe', tone: 'destructive', onSelect: vi.fn() },
      { id: 'session', label: 'Allow for this session', shortcut: 2, placement: 'proceed', onSelect: vi.fn() },
      { id: 'allow', label: 'Allow', shortcut: 1, placement: 'proceed', onSelect: vi.fn() },
    ]

    await act(() => root.render(
      <ApprovalDialog title="Run this command?" icon={null} focused focusKey="a1" actions={three} placement="docked">
        <ApprovalCode>ls -la</ApprovalCode>
        <ApprovalMeta label="in" kind="folder" title="/work/widgets">widgets</ApprovalMeta>
      </ApprovalDialog>,
    ))

    const card = slot.querySelector<HTMLElement>('[data-slot="approval-card"]')
    expect(card, 'drawn in place, inside its own slot').not.toBeNull()
    expect(card?.parentElement).toBe(slot)
    expect(card?.getAttribute('role')).toBeNull()
    expect(card?.getAttribute('aria-labelledby')).toBe(card?.querySelector('h2')?.id)
    expect(document.querySelector('[role="dialog"], [data-slot="dialog-popup"], [data-slot="dialog-overlay"]')).toBeNull()
    expect(before.closest('[inert], [aria-hidden="true"]')).toBeNull()
    // It takes the focus an approval always takes, so its numbers answer.
    expect(document.activeElement).toBe(card)
    const buttons = [...card!.querySelectorAll('button')]
    expect(buttons.map((one) => one.textContent)).toEqual(['Deny3', 'Allow for this session2', 'Allow1'])
    expect(buttons.filter((one) => one.hasAttribute('data-filled')).map((one) => one.textContent)).toEqual(['Allow1'])
    expect(buttons.some((one) => one.getAttribute('data-variant') === 'destructive')).toBe(false)
    // A folder is a place, set in the interface's type; only the command is code.
    expect(card!.querySelector('[data-slot="approval-meta"]')?.getAttribute('data-kind')).toBe('folder')

    await act(() => root.unmount())
  })

  it('keeps the overlay a dialog: the session view’s surface does not change', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(() => root.render(
      <ApprovalDialog title="Permission" icon={null} focused focusKey="k" actions={actions}>Review.</ApprovalDialog>,
    ))
    expect(document.querySelector('[data-slot="approval-dialog-scope"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="dialog-popup"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="approval-card"]')).toBeNull()
    await act(() => root.unmount())
  })
})
