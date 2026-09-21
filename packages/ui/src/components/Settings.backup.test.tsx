import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { BackupFile, BackupReport } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { BackupRows } from './Settings'

/**
 * The Backup rows' outcome sentence, pinned after review found it still
 * calling the registered runtimes "agents" — the rename Task 11 made
 * everywhere else. It counts four things apart: the runtimes registered here,
 * this Mac's own Agent files, this Mac's seats for them, and its
 * preferences/conversations, and records of what the desk observed — never
 * folding runtimes and Agents into one word.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom has no object URL registry and would otherwise throw reading the
  // click-to-download that export triggers.
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const render = (store: AppStore): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <BackupRows />
      </StoreProvider>,
    )
  })
}

const button = (label: string): HTMLButtonElement | HTMLLabelElement => {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement | HTMLLabelElement>('button, label'),
  ].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no control reading “${label}”`)
  return found
}

const BACKUP: BackupFile = {
  kind: 'harnessdesk-backup',
  version: 1,
  exportedAt: 0,
  hostVersion: '0.0.0',
  agents: [{ id: 'codex' }, { id: 'cursor' }],
  preferences: {},
  transcripts: [{ runtime: 'codex', id: 's1', data: {} }],
  agentFolders: [
    { id: 'code-reviewer', files: [] },
    { id: 'judge', files: [] },
    { id: 'implementer', files: [] },
  ],
  seating: {},
}

it('says the runtimes it exported are runtimes, and counts Agents and seats apart', async () => {
  const request = vi.fn(async () => BACKUP)
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), transport: { request } } as unknown as AppStore
  render(store)
  await act(async () => {
    button('Export…').click()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(request).toHaveBeenCalledWith('backup/export', {})
  const text = container.textContent ?? ''
  expect(text).toContain('Exported 2 runtimes, 3 Agents of yours, 1 conversation and 0 records of what the desk observed.')
  expect(text).not.toMatch(/\b2 agents\b/)
})

const REPORT: BackupReport = {
  agents: { restored: 1, skipped: 1 },
  preferences: 2,
  transcripts: { restored: 4, skipped: 0 },
  agentFolders: { restored: 3, skipped: 0 },
  seating: { restored: 1, skipped: 0 },
  provenance: { restored: 0, duplicate: 0, refused: 0 },
  evidence: { restored: 5, duplicate: 2, refused: 0, failed: 0 },
}

it('says the runtimes it restored are runtimes, and counts Agents and seats apart', async () => {
  const request = vi.fn(async () => REPORT)
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), transport: { request } } as unknown as AppStore
  render(store)
  const input = container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  const file = new File(['{}'], 'backup.json', { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(request).toHaveBeenCalledWith('backup/import', { backup: {} })
  const text = container.textContent ?? ''
  expect(text).toContain(
    'Restored 1 runtime, 3 Agents, 1 seat choice, 2 preferences, 4 conversations and 5 records of what the desk observed. 3 already here or newer, left alone.',
  )
  expect(text).not.toMatch(/\b1 agent\b/)
})
