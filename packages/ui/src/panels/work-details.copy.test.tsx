import type { Session } from '@harnessdesk/protocol'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { PREVIEW_SESSION_KEY, previewStore } from '../preview/harness'
import { ConversationDetails } from './work-details'

let name: string | null = null
vi.mock('../state/seat-agent', () => ({ useSeatAgent: () => ({ id: 'reviewer', name }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('labels the displayed identity as Runtime until the seated Agent’s name is read', () => {
  const host = document.createElement('div'), root = createRoot(host), store = previewStore()
  document.body.append(host)
  const saved = store.getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!
  const session: Session = { ...saved, settings: { ...saved.settings, cwd: saved.cwd ?? '/work/storefront', model: saved.settings?.model ?? 'fixture-model', agent: 'reviewer' } }
  const draw = () => act(() => root.render(<StoreProvider store={store}><ConversationDetails session={session} /></StoreProvider>))
  try {
    draw()
    expect(host.querySelector('dt')?.textContent).toBe('Runtime')
    name = 'Code reviewer'
    draw()
    expect(host.querySelector('dt')?.textContent).toBe('Agent')
    expect(host.querySelector('dd')?.textContent).toBe('Code reviewer')
  } finally { act(() => root.unmount()); host.remove(); name = null }
})
