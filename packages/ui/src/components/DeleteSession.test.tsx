import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runtimeId, sessionId, type RuntimeInfo, type SessionSummary } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { DeleteSession } from './DeleteSession'

it('confirms moving the conversation to Trash and reports the same disposition', async () => {
  const runtime = { id: runtimeId('agent'), presentation: { name: 'Agent' }, capabilities: { deleteHistory: 'trash' } } as unknown as RuntimeInfo
  const summary: SessionSummary = { id: sessionId('synthetic'), runtime: runtime.id, title: 'Synthetic task', cwd: '/repo', createdAt: 1, updatedAt: 2, status: { type: 'notLoaded' } }
  const snapshot = { ...emptySnapshot(), runtimes: [runtime] }
  const deleteSession = vi.fn().mockResolvedValue({ disposition: 'trash', removed: 1 })
  const notice = vi.fn()
  const onClose = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, deleteSession, notice } as unknown as AppStore
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<StoreProvider store={store}><DeleteSession summary={summary} onClose={onClose} /></StoreProvider>))
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Delete "Synthetic task" everywhere?')
    expect(dialog.textContent).toContain('It moves to the Trash, and Agent can no longer resume it.')
    const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(entry => entry.textContent === 'Move to Trash')!
    await act(async () => button.click())
    expect(deleteSession).toHaveBeenCalledWith(summary.id, summary.runtime)
    expect(notice).toHaveBeenCalledWith('info', 'Moved to the Trash')
    expect(onClose).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); host.remove() }
})
