import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runtimeId, sessionId, sessionKey, type Session } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { PaneProvider, StoreProvider } from '../state/context'
import { AdjacentTranscript } from './AdjacentTranscript'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('shows the secondary transcript without actions that edit or navigate the main subject', () => {
  const store = new AppStore('ws://localhost:0/'), runtime = runtimeId('other'), id = sessionId('secondary'), key = sessionKey(runtime, id)
  const session = { runtime, id, cwd: '/project', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, itemsLoaded: true, historyPending: true, turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Secondary prompt' }] },
    { id: 'assistant', type: 'assistantMessage', text: 'Unique secondary answer' },
    { id: 'child', type: 'subagent', action: 'spawn', status: 'inProgress', members: [{ sessionId: 'child', nickname: 'Child' }] },
  ] }] } as unknown as Session
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'secondary', view: { kind: 'conversation', session: key }, sessionKey: key }}><AdjacentTranscript session={session} /></PaneProvider></StoreProvider>))
    expect(host.textContent).toContain('Secondary prompt')
    expect(host.textContent).toContain('Unique secondary answer')
    expect(host.textContent).toContain('Recent activity is still being saved.')
    expect(host.textContent).toContain('Child')
    expect(host.querySelector('[aria-label="Edit this message"]')).toBeNull()
    expect([...host.querySelectorAll('button')].some(button => button.title.includes('Open child'))).toBe(false)
    expect(host.querySelector('textarea')).toBeNull()
  } finally { act(() => root.unmount());host.remove() }
})

it('prevents file links from navigating away and explains why', () => {
  const store = new AppStore('ws://localhost:0/'), runtime = runtimeId('other'), id = sessionId('secondary'), key = sessionKey(runtime, id)
  const notice = vi.spyOn(store, 'notice')
  const session = { runtime, id, cwd: '/project', turns: [{ id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'assistantMessage', text: '[Source](src/file.ts:12)' }] }] } as unknown as Session
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'secondary', view: { kind: 'conversation', session: key }, sessionKey: key }}><AdjacentTranscript session={session} /></PaneProvider></StoreProvider>))
    const link = host.querySelector<HTMLAnchorElement>('a[href="src/file.ts:12"]')!
    expect(link).not.toBeNull()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    expect(notice).toHaveBeenCalledWith('warning', expect.stringContaining('File links'))
  } finally { act(() => root.unmount()); host.remove() }
})

it('starts at the tail, follows growth and late layout only while pinned, and resets for a new session', () => {
  const store = new AppStore('ws://localhost:0/'), runtime = runtimeId('other'), id = sessionId('secondary'), key = sessionKey(runtime, id)
  const makeSession = (text: string, nextId = id) => ({ runtime, id: nextId, cwd: '/project', turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'answer', type: 'assistantMessage', text }] }] }) as unknown as Session
  let height = 500
  const observers: ResizeObserverCallback[] = []
  let frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback) } observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const flushFrame = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
  const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height)
  const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const render = (session: Session) => act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'secondary', view: { kind: 'conversation', session: key }, sessionKey: key }}><AdjacentTranscript session={session} /></PaneProvider></StoreProvider>))
  try {
    render(makeSession('A'))
    const thread = host.querySelector<HTMLElement>('[aria-label="Read-only transcript"]')!
    expect(thread.scrollTop).toBe(500)
    height = 600; render(makeSession('AB')); expect(thread.scrollTop).toBe(600)
    height = 700; act(() => observers.at(-1)?.([], {} as ResizeObserver)); expect(thread.scrollTop).toBe(700)
    flushFrame()
    act(() => { thread.scrollTop = 20; thread.dispatchEvent(new Event('scroll', { bubbles: true })) })
    height = 800; render(makeSession('ABC')); expect(thread.scrollTop).toBe(20)
    render(makeSession('Different', sessionId('another'))); expect(thread.scrollTop).toBe(800)
    flushFrame()
    const text = thread.querySelector('p')?.firstChild
    expect(text).toBeTruthy()
    const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 1)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    act(() => document.dispatchEvent(new Event('selectionchange')))
    height = 900; render(makeSession('Different again', sessionId('another'))); expect(thread.scrollTop).toBe(800)
    selection.removeAllRanges()
  } finally { act(() => root.unmount()); host.remove(); scrollHeight.mockRestore(); clientHeight.mockRestore(); vi.unstubAllGlobals() }
})
