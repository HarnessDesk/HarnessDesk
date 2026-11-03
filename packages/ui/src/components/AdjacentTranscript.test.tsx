import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { runtimeId, sessionId, sessionKey, type Session } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { PaneProvider, StoreProvider } from '../state/context'
import { AdjacentTranscript } from './AdjacentTranscript'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('shows the secondary transcript without actions that edit or navigate the main subject', () => {
  const store = new AppStore('ws://localhost:0/'), runtime = runtimeId('other'), id = sessionId('secondary'), key = sessionKey(runtime, id)
  const session = { runtime, id, cwd: '/project', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Secondary prompt' }] },
    { id: 'assistant', type: 'assistantMessage', text: 'Unique secondary answer' },
    { id: 'child', type: 'subagent', action: 'spawn', status: 'inProgress', members: [{ sessionId: 'child', nickname: 'Child' }] },
  ] }] } as unknown as Session
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'secondary', view: { kind: 'conversation', session: key }, sessionKey: key }}><AdjacentTranscript session={session} /></PaneProvider></StoreProvider>))
    expect(host.textContent).toContain('Secondary prompt')
    expect(host.textContent).toContain('Unique secondary answer')
    expect(host.textContent).toContain('Child')
    expect(host.querySelector('[aria-label="Edit this message"]')).toBeNull()
    expect([...host.querySelectorAll('button')].some(button => button.title.includes('Open child'))).toBe(false)
    expect(host.querySelector('textarea')).toBeNull()
  } finally { act(() => root.unmount());host.remove() }
})
