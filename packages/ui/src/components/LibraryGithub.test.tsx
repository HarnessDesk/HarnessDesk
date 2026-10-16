import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type Library, type LibraryPlan, type LibrarySourceResult } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import { LibraryFlows, PlanDialog } from './LibraryActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const columns = [{ id: runtimeId('one'), label: 'Alpha' }, { id: runtimeId('two'), label: 'Beta' }, { id: runtimeId('three'), label: 'Gamma' }]
const library = { generatedAt: 1, home: '/home/jane', runtimes: columns.map(c => c.id), entries: [], gaps: [], locations: columns.slice(0, 2).map(c => ({ runtime: c.id, kind: 'skill', path: '/skills', scope: 'user', scanned: true, exists: true, readOnly: false })) } as Library
const fetched: LibrarySourceResult = {
  url: 'https://github.com/acme-dev/skills', repo: 'acme-dev/skills', ref: 'main', commit: '1a2b3c4d', path: 'review',
  skills: [
    { name: 'notes', dir: '', sourcePath: '/cache/notes', files: 1, runnable: 0, binary: 0, bytes: 100, bundle: 'notes-bundle' },
    { name: 'review', dir: 'review/code', sourcePath: '/cache/review', files: 3, runnable: 1, binary: 1, bytes: 300, bundle: 'review-bundle' },
  ], refused: [{ dir: 'legacy', reason: 'It contains a link.' }],
}
let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const button = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === name)!
const checkbox = (name: string) => [...document.body.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(b => b.closest('label')?.textContent === name)!
const click = async (node: HTMLElement) => { expect(node).toBeTruthy(); await act(async () => node.click()) }
const fill = async (name: string, value: string) => {
  const label = [...document.body.querySelectorAll('label')].find(l => l.textContent === name)!
  const input = document.getElementById(label.htmlFor) as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const mount = async (node: React.ReactNode, request = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => fetched)) => {
  const store = { transport: { request }, subscribe: () => () => {}, getSnapshot: () => ({}) } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}>{node}</StoreProvider>))
  return request
}
const github = (setFlow = vi.fn()) => <LibraryFlows flow={{ type: 'github' }} setFlow={setFlow} library={library} columns={columns} onApplied={() => {}} />
const find = async () => { await fill('Repository or folder', '  https://github.com/acme-dev/skills  '); await click(button('Find skills')) }

it('fetches trimmed params, lists facts and refusals, and selects only plain skills by default', async () => {
  const request = await mount(github())
  await fill('Branch, tag or commit', '   ')
  expect(button('Review 0 skills…').disabled).toBe(true)
  await find()
  expect(request).toHaveBeenCalledWith('library/source/fetch', { url: fetched.url })
  expect(document.body.textContent).toContain('Found 2 skills · acme-dev/skills @ 1a2b3c4')
  expect(document.body.textContent).toContain('legacy was not fetched: It contains a link.')
  expect(document.body.textContent).toContain('1 can run')
  expect(document.body.textContent).toContain('1 binary')
  expect(document.body.textContent).toContain('3 files')
  expect(document.body.textContent).toContain('acme-dev/skills')
  expect(checkbox('notes').getAttribute('aria-checked')).toBe('true')
  expect(checkbox('review').getAttribute('aria-checked')).toBe('false')
  expect(checkbox('Alpha').getAttribute('aria-checked')).toBe('false')
  expect(checkbox('Gamma')).toBeUndefined()
  expect(button('Review 1 skills…').disabled).toBe(true)
  expect(button('Review 1 skills…').title).toContain('agent')
  await click(checkbox('notes'))
  await click(checkbox('Alpha'))
  expect(button('Review 0 skills…').disabled).toBe(true)
})

it('makes exact skill by agent intents with each skill path and bundle', async () => {
  const setFlow = vi.fn(), request = await mount(github(setFlow))
  await fill('Branch, tag or commit', '  v1  ')
  await find()
  expect(request).toHaveBeenCalledWith('library/source/fetch', { url: fetched.url, ref: 'v1' })
  await click(checkbox('review')); await click(checkbox('Alpha')); await click(checkbox('Beta'))
  await click(button('Review 2 skills…'))
  expect(setFlow).toHaveBeenCalledWith({ type: 'plan', title: 'Install 2 skills', intents: fetched.skills.flatMap(skill => columns.slice(0, 2).map(c => ({ kind: 'installSkill', name: skill.name, sourcePath: skill.sourcePath, targetRuntime: c.id, origin: { url: fetched.url, ref: fetched.ref, commit: fetched.commit, path: skill.dir, bundle: skill.bundle } }))) })
})

it('names a single skill and clears results when either field changes', async () => {
  const setFlow = vi.fn(); await mount(github(setFlow)); await find()
  await click(checkbox('Alpha')); await click(button('Review 1 skills…'))
  expect(setFlow.mock.calls[0]![0].title).toBe('Install notes')
  await fill('Branch, tag or commit', 'other')
  expect(document.body.textContent).not.toContain('Found 2 skills')
  await click(button('Find skills'))
  await fill('Repository or folder', fetched.url + '/tree/main/review')
  expect(document.body.textContent).not.toContain('Found 2 skills')
})

it('keeps fields and the host sentence on failure, and renders an empty refusal result', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('This repository is unavailable.')).mockResolvedValue({ ...fetched, skills: [] })
  await mount(github(), request); await find()
  expect(document.body.textContent).toContain('This repository is unavailable.')
  expect((document.body.querySelector('input') as HTMLInputElement).value.trim()).toBe(fetched.url)
  await click(button('Find skills'))
  expect(document.body.textContent).toContain('legacy was not fetched: It contains a link.')
  expect(checkbox('notes')).toBeUndefined()
  expect(button('Review 0 skills…').disabled).toBe(true)
})

it('shows Finding while pending and ignores a response after an input edit', async () => {
  let resolve!: (value: LibrarySourceResult) => void
  await mount(github(), vi.fn(() => new Promise(r => { resolve = r })))
  await find()
  expect(button('Finding…').disabled).toBe(true)
  await fill('Branch, tag or commit', 'new')
  await act(async () => resolve(fetched))
  expect(document.body.textContent).not.toContain('Found 2 skills')
})

const files = [
  { path: 'SKILL.md', bytes: 100, runnable: false, binary: false, reason: 'do not show this' },
  { path: 'scripts/run.sh', bytes: 118, runnable: true, binary: false, reason: 'starts with #!' },
  { path: 'data.bin', bytes: 16, runnable: false, binary: true, reason: null },
]
const op = { id: 'remote', kind: 'skill' as const, name: 'review', action: 'create' as const, targetPath: '/home/jane/.alpha/skills/review', sourcePath: '/cache/review', guardDigest: null, backup: false, files, origin: { url: fetched.url, ref: fetched.ref, commit: fetched.commit, path: 'review/code', bundle: 'review-bundle' } }
const planNode = <PlanDialog title="Install review" intents={[]} columns={columns} onClose={() => {}} onApplied={() => {}} />
it('lists every file, runnable reasons only, and acknowledges only incoming remote flagged ops', async () => {
  const { origin: _origin, ...local } = op
  const ops: LibraryPlan['ops'] = [op, { ...local, id: 'local' }, { ...op, id: 'plain', files: [files[0]!] }, { ...op, id: 'removed', files: [{ ...files[1]!, change: 'removed' }] }]
  const request = vi.fn(async (method: string, _params: unknown) => method === 'library/plan' ? { plannedAt: 1, ops } : [])
  await mount(planNode, request)
  expect(document.body.textContent).toContain('3 files · 1 can run · 1 binary')
  expect(document.body.textContent).toContain('SKILL.md')
  expect(document.body.textContent).toContain('Can run')
  expect(document.body.textContent).toContain('Binary')
  expect(document.body.textContent).toContain('starts with #!')
  expect(document.body.textContent).not.toContain('do not show this')
  expect(button('Apply 4 changes').disabled).toBe(true)
  await click(button('Apply 4 changes'))
  expect(request).toHaveBeenCalledTimes(1)
  await click(checkbox('I read the files that can run or are binary'))
  await click(button('Apply 4 changes'))
  expect(request).toHaveBeenLastCalledWith('library/apply', { ops: [{ ...op, acknowledged: true }, ...ops.slice(1)] })
})

it('local scripts show their files without acknowledgement or Read; remote ops need a source to read', async () => {
  const { origin: _origin, ...local } = op
  const { sourcePath: _source, ...withoutSource } = op
  await mount(planNode, vi.fn(async () => ({ plannedAt: 1, ops: [local, { ...withoutSource, id: 'no-source', files: [] }] })))
  expect(document.body.textContent).toContain('scripts/run.sh')
  expect(document.body.querySelector('[role="checkbox"]')).toBeNull()
  expect(button('Read')).toBeUndefined()
  expect(button('Apply 2 changes').disabled).toBe(false)
})

it('reads plain text, toggles Hide, and shows truncation, binary and host failures', async () => {
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'library/plan') return { plannedAt: 1, ops: [op] }
    const path = (params as { path: string }).path
    if (path === 'data.bin') return { text: null, truncated: false }
    return { text: '<img src=x onerror=alert(1)>\n# plain text', truncated: true }
  })
  await mount(planNode, request)
  await click(button('Read'))
  expect(request).toHaveBeenLastCalledWith('library/source/file', { sourcePath: op.sourcePath, path: 'scripts/run.sh' })
  expect(document.body.querySelector('[data-slot="code-block-body"]')?.textContent).toBe('<img src=x onerror=alert(1)>\n# plain text')
  expect(document.body.querySelector('[data-slot="code-block-body"] img')).toBeNull()
  expect(document.body.textContent).toContain('Showing the first 256 KB.')
  await click(button('Hide'))
  expect(document.body.querySelector('[data-slot="code-block-body"]')).toBeNull()
  const reads = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === 'Read')
  await click(reads[1]!)
  expect(document.body.textContent).toContain('This file is binary and is not shown.')
  request.mockRejectedValueOnce(new Error('The cached file is gone.'))
  await click(reads[0]!)
  expect(document.body.textContent).toContain('The cached file is gone.')
})

it('uses the singular acknowledgement and displays a host apply refusal on the op', async () => {
  const single = { ...op, files: [files[1]!] }
  const request = vi.fn(async (method: string): Promise<unknown> => method === 'library/plan' ? { plannedAt: 1, ops: [single] } : [{ id: op.id, outcome: 'failed', detail: 'Read the list and acknowledge it before installing.' }])
  await mount(planNode, request)
  await click(checkbox('I read the file that can run'))
  await click(button('Apply 1 change'))
  expect(document.body.textContent).toContain('Read the list and acknowledge it before installing.')
})

it('offers no file read when a fetched operation lacks its source path', async () => {
  const { sourcePath: _source, ...withoutSource } = op
  await mount(planNode, vi.fn(async () => ({ plannedAt: 1, ops: [withoutSource] })))
  expect(document.body.textContent).toContain('scripts/run.sh')
  expect(button('Read')).toBeUndefined()
  expect(button('Apply 1 change').disabled).toBe(true)
})

it('asks for a binary-only incoming file but asks nothing for a removed script', async () => {
  const request = vi.fn(async () => ({ plannedAt: 1, ops: [{ ...op, files: [files[2]!] }] }))
  await mount(planNode, request)
  expect(checkbox('I read the file that is binary')).toBeTruthy()
  expect(button('Apply 1 change').disabled).toBe(true)
  await act(async () => root.unmount())
  root = createRoot(container)
  await mount(planNode, vi.fn(async () => ({ plannedAt: 1, ops: [{ ...op, files: [{ ...files[1]!, change: 'removed' }] }] })))
  expect(document.body.querySelector('[role="checkbox"]')).toBeNull()
  expect(button('Apply 1 change').disabled).toBe(false)
  expect(document.body.textContent).toContain('Removed · 118 B')
})
