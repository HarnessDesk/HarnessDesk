import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Turn } from '@harnessdesk/protocol'
import { useSnapshot } from '../state/context'
import { splitTurn } from '../lib/turn-view'
import { SIDE_BY_SIDE_KEYS } from './side-by-side-fixture'
import { ReadCeilingFrames } from './frames-read-ceiling'

vi.mock('./main', () => ({ Frame: ({ children }: { children: React.ReactNode }) => children }))
let turn: Turn
vi.mock('../components/Conversation', () => ({ Conversation: () => {
  turn = useSnapshot().sessions.get(SIDE_BY_SIDE_KEYS[0]!)!.turns[0]!
  return null
} }))

afterEach(() => window.history.replaceState(null, '', '/'))

for (const state of ['before', 'after']) {
  it(`places the ${state} refusal frame's refused tool in the turn's work`, async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.history.replaceState(null, '', `/?read-ceiling=${state}`)
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<ReadCeilingFrames />))
      const view = splitTurn(turn)
      expect(view.work[0]).toMatchObject({ type: 'toolCall', tool: 'Edit', status: 'failed' })
      expect(view.prompt.map(item => item.type)).toEqual(['userMessage'])
      expect(view.work.map(item => item.type)).toEqual(state === 'after' ? ['toolCall', 'notice'] : ['toolCall'])
      expect(view.answer).toHaveLength(1)
    } finally { act(() => root.unmount()) }
  })
}
