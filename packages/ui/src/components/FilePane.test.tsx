import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import { MountProvider } from '../panels/mount'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { FileConflictNotice, FilePane } from './FilePane'

vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (value: string) => void }) => (
    <textarea aria-label="file editor" value={value} readOnly={readOnly} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const settle = () => act(async () => {})
const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot

const mount = async (path: string, result: unknown) => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reportEditor: vi.fn(),
    transport: { request: vi.fn(async (method: string) => method === 'workspace/readFile' ? result : { kind: 'file', isSymlink: false, modifiedAt: 1 }) },
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <MountProvider scope={{ area: 'main', id: 'file-test', view: { kind: 'file', path, runtime: runtimeId('claude') } }}>
        <FilePane />
      </MountProvider>
    </StoreProvider>,
  ))
  await settle()
  return store
}

it('offers creation only when the host marks the read as missing', async () => {
  await mount('/work/missing.ts', { kind: 'missing' })
  expect(container.textContent).toContain('missing.ts does not exist yet.')
  expect(container.querySelector('button')?.textContent).toBe('Create this file')
})

it('keeps an unreadable file distinct from a missing file', async () => {
  await mount('/work/private.txt', { kind: 'unreadable', message: 'Permission denied.' })
  expect(container.textContent).toContain('Permission denied.')
  expect(container.textContent).not.toContain('Create this file')
})

it('shows binary size without offering to create the existing file', async () => {
  await mount('/work/data.bin', { kind: 'binary', content: '', size: 1536, hash: 'hash' })
  expect(container.textContent).toContain('Binary file — 1.5 KB')
  expect(container.textContent).not.toContain('Create this file')
})

it('shows an explicit size state when the host refuses an oversized file', async () => {
  await mount('/work/large.txt', { kind: 'tooLarge', size: 2 * 1024 * 1024 + 1 })
  expect(container.textContent).toContain('File too large — 2.0 MB')
  expect(container.textContent).not.toContain('Create this file')
})

it('shows a binary save refusal without offering a text conflict overwrite', async () => {
  act(() => root.render(
    <FileConflictNotice conflict={{ kind: 'binary', size: 6 }} onTakeTheirs={vi.fn()} onOverwrite={vi.fn()} />,
  ))
  expect(container.textContent).toContain('This file is now binary. Your save was refused.')
  expect(container.textContent).not.toContain('Overwrite with mine')
  expect(container.textContent).not.toContain('Take theirs')
})

it.each([
  ['binary', { saved: false, reason: 'binary', size: 6 }, 'This file is now binary. Your save was refused.'],
  ['too large', { saved: false, reason: 'tooLarge', size: 2 * 1024 * 1024 + 1 }, 'This file is now too large to edit. Your save was refused.'],
] as const)('keeps the editable draft after a %s save refusal', async (_label, refusal, message) => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reportEditor: vi.fn(),
    notice: vi.fn(),
    transport: { request: vi.fn(async (method: string) => {
      if (method === 'workspace/readFile') return { kind: 'text', content: 'original', hash: 'old-hash', truncated: false }
      if (method === 'file/save') return refusal
      return { kind: 'file', isSymlink: false, modifiedAt: 1 }
    }) },
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <MountProvider scope={{ area: 'main', id: 'file-test', view: { kind: 'file', path: '/work/notes.txt', runtime: runtimeId('claude') } }}>
        <FilePane />
      </MountProvider>
    </StoreProvider>,
  ))
  await settle()
  const edit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Edit')
  if (!edit) throw new Error('Edit button is missing')
  act(() => edit.click())
  const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="file editor"]')
  if (!editor) throw new Error('Editor is missing')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(editor, 'person’s unsaved draft')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Save')
  if (!save) throw new Error('Save button is missing')
  await act(async () => { save.click() })
  await settle()
  expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Save')?.disabled).toBe(true)
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="file editor"]')?.value).toBe('person’s unsaved draft')
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="file editor"]')?.readOnly).toBe(false)
  expect(container.textContent).toContain(message)
})

it('previews a 2–10 MiB image from the single bounded read', async () => {
  const size = 3 * 1024 * 1024
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reportEditor: vi.fn(),
    transport: { request: vi.fn(async (method: string, params?: { maxBytes?: number; encoding?: string }) => {
      if (method === 'workspace/readFile') return { kind: 'binary', content: 'aGVsbG8=', size, hash: 'hash' }
      return { kind: 'file', isSymlink: false, modifiedAt: 1 }
    }) },
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <MountProvider scope={{ area: 'main', id: 'file-test', view: { kind: 'file', path: '/work/tiny.png', runtime: runtimeId('claude') } }}>
        <FilePane />
      </MountProvider>
    </StoreProvider>,
  ))
  await settle()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
  expect(store.transport.request).toHaveBeenCalledTimes(2) // one file read and one stat
  expect(store.transport.request).toHaveBeenCalledWith('workspace/readFile', expect.objectContaining({ maxBytes: 10 * 1024 * 1024, encoding: 'base64' }))
})

it('renders an image result from one read', async () => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reportEditor: vi.fn(),
    transport: { request: vi.fn(async (method: string) => {
    if (method === 'workspace/readFile') return { kind: 'binary', content: 'aGVsbG8=', size: 5, hash: 'hash' }
    return { kind: 'file', isSymlink: false, modifiedAt: 1 }
    }) },
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <MountProvider scope={{ area: 'main', id: 'file-test', view: { kind: 'file', path: '/work/tiny.png', runtime: runtimeId('claude') } }}>
        <FilePane />
      </MountProvider>
    </StoreProvider>,
  ))
  await settle()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
  expect(container.textContent).not.toContain('Create this file')
})
