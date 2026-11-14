import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { IdleStopFrames } from './frames-idle-stop'

vi.mock('./main', () => ({ Frame: ({ id, children }: { id: string; children: React.ReactNode }) => <section data-frame-id={id}>{children}</section> }))
/* The frame's own subject is the composer; the rest of the conversation is not what this frame shows. */
vi.mock('../components/Conversation', async () => {
  const { Composer } = await import('../components/Composer')
  return { Conversation: () => <Composer onChooseProject={() => {}} /> }
})

afterEach(() => { sessionStorage.clear() })

it('draws Stop with no Send while sub-agents outlast the turn, and Send beside Stop once a message is typed', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<IdleStopFrames />))
    const empty = host.querySelector('[data-frame-id="idle-stop-subagents"]')!
    expect(empty.querySelector('[aria-label="Stop"]')?.getAttribute('title')).toBe('Stop the sub-agents still working')
    expect(empty.querySelector('[aria-label="Send"]')).toBeNull()
    const typed = host.querySelector('[data-frame-id="idle-stop-typed"]')!
    expect(typed.querySelector('textarea')?.value).toBe('Also try a timeout instead of a 502.')
    expect(typed.querySelector('[aria-label="Send"]')).not.toBeNull()
    expect(typed.querySelector('[aria-label="Stop"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
