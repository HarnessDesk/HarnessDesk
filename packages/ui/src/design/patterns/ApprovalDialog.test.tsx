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
})
