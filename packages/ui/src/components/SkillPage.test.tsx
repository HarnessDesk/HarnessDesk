import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type Library, type LibraryEntry, type LibrarySkillUpdate, type LibraryUsage, type RuntimeInfo } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider, useSnapshot } from '../state/context'
import type { PageDestination } from '../state/destinations'
import { MAIN_PAGE_ENTRIES } from '../app/main-page-entries'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const one = runtimeId('one'), two = runtimeId('two')
const origin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: '1234567890abcdef', path: 'review' }
const raw = '---\nname: review\ndescription: Review the diff.\n---\n\n# Review\n\nRead **every** caller.\n<script>bad()</script>\n'
const skill = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({ kind: 'skill', name: 'review', title: 'A different title', description: 'Review the diff.',
  copies: [{ path: '/home/jane/.one/skills/review', scope: 'user', readBy: [one], hollow: false, digest: 'same', readOnly: false }],
  reach: [{ runtime: one, state: 'reaches', basis: 'reported', toggleable: true, reportedPath: '/home/jane/.one/skills/review/SKILL.md' }, { runtime: two, state: 'absent', basis: 'scanned' }], ...over })
const update = (status: LibrarySkillUpdate['status'], over: Partial<LibrarySkillUpdate> = {}): LibrarySkillUpdate => ({ name: 'review', runtime: one, origin, status, latest: 'abcdef123456', reason: null, ...over })
const route = (id = 'review') => ({ kind: 'library', section: 'skill', id }) as PageDestination
let root: Root, box: HTMLDivElement, store: AppStore
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === name)!
const page = () => box.querySelector('[data-slot="skill-page"]')!
const card = (name: string) => page()?.querySelector(`[data-slot="tool-section"][aria-label="${name}"]`)
const press = async (name: string) => { expect(button(name), name).toBeTruthy(); await act(async () => { button(name).click(); await new Promise(resolve => requestAnimationFrame(resolve)) }) }
/** Whether a dialog stood in the DOM at the commit that first carried each route id, before any passive effect could clear it. */
let dialogAtCommit: Map<string | undefined, boolean>
const CommitProbe = ({ id }: { id: string | undefined }) => {
  useLayoutEffect(() => { if (!dialogAtCommit.has(id)) dialogAtCommit.set(id, document.querySelector('[role="dialog"]') !== null) })
  return null
}
const Routes = () => {
  const snapshot = useSnapshot(), destination = snapshot.workbench.navigation.current
  return destination.kind === 'library' ? <DestinationPageScope owner="destination:library" active>
    {MAIN_PAGE_ENTRIES.library!({ page: destination, visit: d => store.openDestination(d), replace: d => store.replaceDestination(d), onSignIn: vi.fn(), onNewTeam: vi.fn(), libraryImportIntent: 0 })}
    <CommitProbe id={'id' in destination ? destination.id : undefined} />
  </DestinationPageScope> : <div>Conversation</div>
}
beforeEach(() => { dialogAtCommit = new Map(); box = document.createElement('div'); document.body.append(box); root = createRoot(box); store = new AppStore('ws://localhost:0/') })
afterEach(() => { act(() => root.unmount()); box.remove(); vi.restoreAllMocks() })
const mount = async (entries = [skill()], id = 'review', definition: unknown = { name: 'review', kind: 'skill', path: '/home/jane/.one/skills/review', text: raw, files: [{ path: 'SKILL.md', bytes: 90 }], moreFiles: 0, truncated: false }, readFailure?: string, usage: LibraryUsage | null = { generatedAt: 1, sessionsScanned: 0, skills: {} }) => {
  const runtimeIds = [...new Set([one, two, ...entries.flatMap(entry => entry.reach.map(reach => reach.runtime))])]
  const value: Library = { generatedAt: 1, runtimes: runtimeIds, entries, gaps: [], home: '/home/jane', locations: runtimeIds.map(runtime => ({ runtime, kind: 'skill', path: `/home/jane/.${runtime}/skills`, scope: 'user', scanned: true, exists: true, readOnly: false })) }
  Object.assign(store.getSnapshot(), { status: 'open', runtimes: runtimeIds.map((id, i) => ({ id, name: `Runtime ${i + 1}`, capabilities: {}, presentation: { name: `Runtime ${i + 1}` } })) as RuntimeInfo[] })
  vi.spyOn(store, 'loadAgents').mockResolvedValue()
  const request = vi.spyOn(store.transport, 'request').mockImplementation(async method => { if (method === 'library/read' && readFailure) throw new Error(readFailure); return (method === 'library/read' ? value : method === 'library/definition' ? definition : method === 'library/usage' ? usage : method === 'library/plan' ? { plannedAt: 1, ops: [] } : null) as never })
  store.openDestination({ kind: 'library', section: 'skill' }); store.openDestination(route(id))
  await act(async () => root.render(<StoreProvider store={store}><TopBarProvider><Routes /><TopBarOutlet owner="destination:library" fallback={{ place: 'Fallback', more: () => null }} /></TopBarProvider></StoreProvider>))
  return request
}
it('visits a wide skill detail and returns to Library through the head and history', async () => {
  await mount()
  expect(box.querySelector('[data-slot="page"]')?.getAttribute('data-width')).toBe('wide')
  expect(page()).toBeTruthy(); expect(page().closest('[role="dialog"]')).toBeNull()
  await press('Back to Library'); expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'library', section: 'skill' })
  await act(async () => { await store.navigateBack(); await new Promise(resolve => requestAnimationFrame(resolve)) }); expect(page()).toBeTruthy()
})
it('shows one short missing-name state with Back to Library', async () => {
  await mount([], 'removed'); expect(box.querySelector('[data-slot="empty-state"]')?.textContent).toBe('Skill not foundBack to Library')
  expect(box.querySelector('[data-slot="empty-state"] p')).toBeNull(); await press('Back to Library')
  expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'library', section: 'skill' })
})
it('heads the page with its name, description, Skill chip, one composer verb and More', async () => {
  await mount(); expect(box.querySelector('h1')?.textContent).toBe('review'); expect(page().textContent).toContain('Review the diff.')
  expect(page().querySelector('[data-slot="chip"]')?.textContent).toBe('Skill'); expect(button('Use in composer').getAttribute('data-variant')).toBe('outline')
  expect(document.querySelector('[aria-label="More"]')).toBeTruthy()
})
it('renders the description as the sheet does, links and paragraphs whole', async () => {
  await mount([skill({ description: 'Read the [guide](https://example.com/guide) first.\n\nThen review the diff.' })])
  const description = [...page().children].find(node => !node.hasAttribute('data-slot') && node.querySelector('p'))!
  expect(description.querySelectorAll('p')).toHaveLength(2); expect(description.querySelectorAll('a')).toHaveLength(1)
  expect(description.querySelector('a')?.getAttribute('href')).toBe('https://example.com/guide'); expect(description.querySelector('a')?.textContent).toBe('guide')
  expect(description.textContent).toContain('Then review the diff.')
})
it('Use in composer returns to work before handing over the command', async () => {
  await mount(); const calls: string[] = []; vi.spyOn(store, 'returnToWork').mockImplementation(() => { calls.push('work') })
  const listener = (event: Event) => { const detail = (event as CustomEvent).detail; calls.push(detail.text); detail.onReceived() }
  window.addEventListener('harnessdesk:compose', listener)
  try { await press('Use in composer') } finally { window.removeEventListener('harnessdesk:compose', listener) }
  expect(calls).toEqual(['work', '/review '])
})
it('frames SKILL.md, renders sanitized Markdown and frontmatter, switches to exact source and copies it', async () => {
  const request = await mount(); const definition = page().querySelector('[aria-label="Definition"]')!
  expect(definition.textContent).toContain('SKILL.md'); expect(definition.querySelector('strong')?.textContent).toBe('every'); expect(definition.querySelector('script')).toBeNull()
  expect(definition.textContent).toContain('description: Review the diff.')
  expect(request).toHaveBeenCalledWith('library/definition', { kind: 'skill', name: 'review', path: '/home/jane/.one/skills/review' })
  const group = definition.querySelector('[role="radiogroup"][aria-label="How to show the definition"]')!
  expect(group.getAttribute('data-slot')).toBe('toggle-group'); expect(definition.querySelector('[data-slot="page-options"]')).toBeNull()
  expect(group.nextElementSibling?.textContent).toBe('Copy')
  const choice = (name: string) => [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(n => n.textContent === name)!
  await act(async () => choice('Rendered').click()); expect(definition.querySelector('strong')?.textContent).toBe('every'); expect(choice('Rendered').getAttribute('aria-checked')).toBe('true')
  await act(async () => choice('Source').click())
  expect(definition.querySelector('pre')?.textContent).toBe(raw)
  await act(async () => choice('Source').click()); expect(definition.querySelector('pre')?.textContent).toBe(raw); expect(choice('Source').getAttribute('aria-checked')).toBe('true')
  const copy = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  await press('Copy'); expect(copy).toHaveBeenCalledWith(raw)
})
it.each([null, { unexpected: true }])('keeps an unreadable definition visible for %j', async answer => {
  await mount([skill()], 'review', answer); expect(page().textContent).toContain('No definition to read'); expect(button('Copy').disabled).toBe(true)
})
it.each(['behind', 'gone', 'unreachable', 'current'] as const)('shows the %s update record with the same words and chip', async status => {
  const request = await mount([skill({ update: [update(status, { reason: 'No response.' })] })]); if (status === 'current') expect(card('Update')).toBeNull(); else expect(card('Update')).toBeTruthy()
  expect(page().querySelector('[data-slot="chip"]')?.textContent).toBe(status === 'behind' ? 'Update available' : 'Skill')
  if (status === 'behind') { expect(card('Update')?.textContent).toContain('1234567 → abcdef1'); expect(button('Review update…')).toBeTruthy() }
  if (status === 'gone') { expect(card('Update')?.textContent).toContain('Source branch is gone'); expect(card('Update')?.textContent).toContain('The branch main no longer exists in acme-dev/skills.') }
  if (status === 'unreachable') expect(card('Update')?.textContent).toContain('Could not check: No response.')
  expect(request.mock.calls.some(([m]) => m === 'library/source/fetch')).toBe(false)
})
it('wears a problem reach state in the warning tone and leaves the rest plain', async () => {
  await mount([skill({ reach: [{ runtime: one, state: 'differs', basis: 'scanned' }, { runtime: two, state: 'absent', basis: 'scanned' }] })])
  const rows = [...card('Loaded by')!.querySelectorAll('[data-slot="row"]')]
  const value = (row: Element) => row.querySelector('[data-slot="text"][data-tone="warning"]')
  expect(rows[0]!.textContent).toContain('Copies differ'); expect(value(rows[0]!)?.textContent).toBe('Copies differ')
  expect(rows[1]!.textContent).toContain('Not installed'); expect(value(rows[1]!)).toBeNull()
})
it('omits Update without a check and reserves the page-aside rail for Loaded by', async () => {
  await mount(); expect(card('Update')).toBeNull(); expect(card('Loaded by')?.querySelectorAll('[data-slot="row"]')).toHaveLength(2)
  expect(page().querySelector('[data-slot="skill-page-columns"]')?.className).toContain('var(--hd-page-aside)')
})
it('fetches behind origins only on Review, disables Fetching and opens the existing update plan', async () => {
  const request = await mount([skill({ update: [update('behind'), update('behind', { runtime: two })] })]); let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
  await press('Review update…'); expect(button('Fetching…').disabled).toBe(true)
  await act(async () => finish({ commit: 'fresh', skills: [{ dir: 'review', bundle: 'bundle' }], refused: [] }))
  expect(request.mock.calls.filter(([m]) => m === 'library/source/fetch')).toHaveLength(1)
  expect(request).toHaveBeenCalledWith('library/plan', { intents: [one, two].map(targetRuntime => ({ kind: 'updateSkill', name: 'review', targetRuntime, origin: { ...origin, commit: 'fresh', bundle: 'bundle' } })) })
})
it('keeps a fetch failure in place of commits and ignores a late fetch after Back', async () => {
  const request = await mount([skill({ update: [update('behind')] })]); request.mockRejectedValueOnce(new Error('No repository.'))
  await press('Review update…'); expect(card('Update')?.textContent).toContain('No repository.'); expect(card('Update')?.textContent).not.toContain('1234567 →')
  let finish!: (value: unknown) => void; request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
  await press('Review update…'); await press('Back to Library'); expect(page()).toBeNull(); await act(async () => finish({ commit: 'fresh', skills: [{ dir: 'review', bundle: 'bundle' }], refused: [] }))
  expect(request.mock.calls.some(([m]) => m === 'library/plan')).toBe(false)
})
it('Loaded by toggles the reported path on the named runtime and previews Install on the missing runtime', async () => {
  await mount(); const toggle = vi.spyOn(store, 'setSkillEnabled').mockResolvedValue(); const row = card('Loaded by')!.querySelector('[data-slot="row"]')!
  expect(row.textContent).toContain('Runtime 1On'); await act(async () => row.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  expect(toggle).toHaveBeenCalledWith({ name: 'review', path: '/home/jane/.one/skills/review/SKILL.md' }, false, one)
  await press('Install'); expect(store.transport.request).toHaveBeenCalledWith('library/plan', { intents: [{ kind: 'installSkill', name: 'review', sourcePath: '/home/jane/.one/skills/review', targetRuntime: two }] })
})
it('Loaded by re-reads stale runtimes and keeps their refusal', async () => {
  const request = await mount([skill({ reach: [{ runtime: one, state: 'stale', basis: 'reported' }] })]); request.mockResolvedValueOnce({ refreshed: false, reason: 'A turn is running.' } as never)
  await press('Have it look again'); expect(request).toHaveBeenCalledWith('runtime/refreshCatalog', { runtime: one }); expect(card('Loaded by')?.textContent).toContain('Runtime 1 — A turn is running.')
})
it('re-reads the displayed definition when a rescan replaces the same copy on disk', async () => {
  const request = await mount(); const original = request.getMockImplementation()!
  request.mockImplementation(async (method, params) => {
    if (method === 'library/read') {
      const value = await original(method, params) as Library
      return { ...value, entries: value.entries.map(entry => ({ ...entry, copies: entry.copies.map(copy => ({ ...copy, digest: 'replacement' })) })) } as never
    }
    if (method === 'library/definition') return { name: 'review', kind: 'skill', path: '/home/jane/.one/skills/review', text: '# Replacement definition', files: [], moreFiles: 0, truncated: false } as never
    return original(method, params)
  })
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Rescan')!.click())
  expect(request.mock.calls.filter(([method]) => method === 'library/definition')).toHaveLength(2)
  expect(page().textContent).toContain('Replacement definition')
})
it('leaves a skill plan behind when navigation returns to the Library cards', async () => {
  await mount(); await press('Install'); expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  await act(async () => { store.openDestination({ kind: 'library', section: 'skill' }); await new Promise(resolve => requestAnimationFrame(resolve)) })
  expect(box.querySelector('[data-slot="skill-cards"]')).toBeTruthy()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('never renders the previous skill\'s plan for the skill opened next', async () => {
  await mount([skill(), skill({ name: 'other' })]); await press('Install'); expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  await act(async () => { store.openDestination(route('other')); await new Promise(resolve => requestAnimationFrame(resolve)) })
  expect(box.querySelector('h1')?.textContent).toBe('other')
  expect(dialogAtCommit.get('other')).toBe(false); expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('reports a failed Library read without claiming the skill is missing', async () => {
  await mount([], 'review', null, 'The library did not answer.')
  expect(box.textContent).toContain('The library did not answer.')
  expect(box.textContent).not.toContain('Skill not found')
  await press('Back to Library')
  expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'library', section: 'skill' })
})

const openMore = async () => { await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click()) }
const selectMenu = async (label: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)
  expect(item, label).toBeTruthy()
  await act(async () => { item!.click(); await new Promise(resolve => requestAnimationFrame(resolve)) })
}
it('Source deduplicates recorded origins before any update check and keeps each distinct ref', async () => {
  const copy = skill().copies[0]!
  const request = await mount([skill({ copies: [copy, { ...copy, path: '/home/jane/.two/skills/review' }, { ...copy, path: '/home/jane/.three/skills/review', origin: { ...origin, ref: 'stable' } }].map(c => ({ ...c, origin: c.origin ?? origin })) })])
  expect(card('Source')!.textContent!.match(/acme-dev\/skills/g)).toHaveLength(2)
  expect(card('Source')!.textContent).toContain('review · main, pinned at 1234567')
  expect(card('Source')!.textContent).toContain('review · stable, pinned at 1234567')
  expect(card('Update')).toBeNull()
  expect(request.mock.calls.some(([method]) => method === 'library/source/fetch')).toBe(false)
})
it('Source keeps local provenance honest and lists copy paths, readers, hollow and shipped facts', async () => {
  const copy = skill().copies[0]!
  await mount([skill({ copies: [copy, { ...copy, path: '/home/jane/.two/skills/review', hollow: true, readBy: [], readOnly: true }] })])
  const text = card('Source')!.textContent!
  expect(text).toContain('This Mac')
  expect(text).toContain('~/.one/skills/review')
  expect(text).toContain('Read by Runtime 1.')
  expect(text).toContain('No definition inside — the name lists and nothing loads.')
  expect(text).toContain('Shipped by the runtime.')
  expect(text).not.toContain('pinned at')
})
it('Files shows bundle sizes, folds long lists and keeps the count beyond the read cap', async () => {
  await mount([skill()], 'review', { text: raw, files: [{ path: 'SKILL.md', bytes: 90 }, ...Array.from({ length: 7 }, (_, i) => ({ path: `references/file-${i}.md`, bytes: i === 0 ? 2097152 : 2048 }))], moreFiles: 2 })
  expect(card('Files')!.textContent).toContain('90 B')
  expect(card('Files')!.textContent).toContain('2.0 MB')
  expect(card('Files')!.querySelector('[data-slot="tool-fold"]')).toBeTruthy()
  await press('Show all files')
  expect(card('Files')!.textContent).toContain('references/file-6.md')
  expect(card('Files')!.textContent).toContain('and 2 more files not listed')
})
it('Cost shows the catalogue price, measured activations, Last used, coverage and copy count', async () => {
  await mount([skill({ catalogTokens: 96 })], 'review', undefined, undefined, { generatedAt: 1, sessionsScanned: 42, skills: { review: { activations: 18, sessions: 9, lastAt: 1700000000000, byRuntime: {} } } })
  const text = card('Cost')!.textContent!
  expect(text).toContain('Every turn≈96 tok'); expect(text).toContain('Fired here18× in 9 conversations')
  expect(text).toContain('Last used' + new Date(1700000000000).toLocaleDateString())
  expect(text).toContain('On disk1 copy')
  expect(text).toContain('Counted in the 42 conversations this desk stores. What ran elsewhere is not counted.')
  expect(card('Cost')!.querySelector('[title*="3.6 characters per token"]')).toBeTruthy()
})
it('Cost distinguishes unknown usage from never fired and Files distinguishes an unreadable definition', async () => {
  await mount([skill()], 'review', null, undefined, null)
  expect(card('Cost')!.textContent).not.toContain('Fired here')
  expect(card('Cost')!.textContent).not.toContain('Last used')
  expect(card('Files')!.textContent).toContain('No file list to read')
})
it('shows one full-width warning per Why reason, titled with every affected runtime', async () => {
  const reason = 'missing field `description`'
  await mount([skill({ reach: [{ runtime: one, state: 'rejected', basis: 'reported', note: reason }, { runtime: two, state: 'absent', basis: 'reported', note: reason }] })])
  const banners = [...page().querySelectorAll('[data-slot="alert"]')]
  expect(banners).toHaveLength(1)
  expect(banners[0]!.querySelector('[data-slot="alert-title"]')?.textContent).toBe('Runtime 1, Runtime 2')
  expect(banners[0]!.querySelector('[data-slot="alert-description"]')?.textContent).toBe(reason)
  expect(page().textContent).not.toContain('would not load this one.')
  expect(page().textContent!.match(/missing field `description`/g)).toHaveLength(1)
  const columns = page().querySelector('[data-slot="skill-page-columns"]')!
  for (const banner of banners) { expect(banner.compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(banner.getAttribute('data-tone')).toBe('warning'); expect(banner.parentElement?.getAttribute('data-measure')).toBe('container') }
})
it('keeps distinct Why reasons as separate banners, warning only for a problem state', async () => {
  await mount([skill({ reach: [{ runtime: one, state: 'rejected', basis: 'reported', note: 'Invalid frontmatter.' }, { runtime: two, state: 'absent', basis: 'scanned', note: 'No skill directory.' }] })])
  const banners = [...page().querySelectorAll('[data-slot="alert"]')]
  expect(banners.map(banner => [banner.querySelector('[data-slot="alert-title"]')?.textContent, banner.querySelector('[data-slot="alert-description"]')?.textContent, banner.getAttribute('data-tone')])).toEqual([
    ['Runtime 1', 'Invalid frontmatter.', 'warning'], ['Runtime 2', 'No skill directory.', 'neutral'],
  ])
})
it('never warns for a note on a runtime that switched the skill off', async () => {
  await mount([skill({ reach: [{ runtime: one, state: 'off', basis: 'scanned', note: "Installed and switched off in this agent's own settings." }] })])
  const banners = [...page().querySelectorAll('[data-slot="alert"]')]
  expect(banners.map(banner => banner.getAttribute('data-tone'))).toEqual(['neutral'])
})
it('lets every finding banner span the same container as the page columns', async () => {
  const copy = skill().copies[0]!
  await mount([skill({ copies: [copy, { ...copy, path: '/home/jane/.two/skills/review', digest: 'different' }], reach: [{ runtime: one, state: 'rejected', basis: 'reported', note: 'Invalid frontmatter.' }] })])
  const banners = [...page().querySelectorAll('[data-slot="alert"]')]
  expect(banners.length).toBeGreaterThan(0)
  for (const banner of banners) expect(banner.parentElement?.getAttribute('data-measure')).toBe('container')
})
it.each([1, 2])('More keeps the refusal caution beside Install for %i refused runtimes', async count => {
  const three = runtimeId('three')
  await mount([skill({ reach: [{ runtime: one, state: 'rejected', basis: 'reported', note: 'Invalid frontmatter.' }, { runtime: two, state: count === 2 ? 'rejected' : 'reaches', basis: 'reported', note: count === 2 ? 'Invalid frontmatter.' : undefined }, { runtime: three, state: 'absent', basis: 'scanned' }] })])
  expect(page().textContent).not.toContain('would not load this one.')
  await openMore()
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.textContent).toContain('Install to Runtime 3')
  const note = menu.querySelector('[data-menu-note]')!
  expect(note.textContent).toBe(count === 1 ? 'Runtime 1 would not load this one.' : 'Runtime 1, Runtime 2 would not load this one.')
  expect(note.previousElementSibling?.textContent).toContain('Install to Runtime 3')
})
it('More previews removal for each writable copy and never offers shipped copies', async () => {
  const copy = skill().copies[0]!
  const request = await mount([skill({ copies: [copy, { ...copy, path: '/home/jane/.two/skills/review', readOnly: true }] })])
  await openMore()
  expect(document.querySelector('[role="menu"]')!.textContent).not.toContain('Remove the copy at ~/.two/skills/review')
  const removal = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Remove the copy at ~/.one/skills/review')
  expect(removal).toBeTruthy()
  expect(removal?.getAttribute('title')).toContain(copy.path)
  await selectMenu('Remove the copy at ~/.one/skills/review')
  expect(request).toHaveBeenCalledWith('library/plan', { intents: [{ kind: 'removeCopy', name: 'review', path: copy.path }] })
})
it('More installs to a missing runtime with the same source and intent as Loaded by', async () => {
  const request = await mount()
  await openMore(); await selectMenu('Install to Runtime 2')
  expect(request).toHaveBeenCalledWith('library/plan', { intents: [{ kind: 'installSkill', name: 'review', sourcePath: '/home/jane/.one/skills/review', targetRuntime: two }] })
})
it('More resolves disagreeing copies and refuses to spread an arbitrary copy', async () => {
  const copy = skill().copies[0]!
  await mount([skill({ copies: [copy, { ...copy, path: '/home/jane/.two/skills/review', digest: 'different' }] })])
  expect(button('Install')).toBeUndefined()
  expect(page().textContent).toContain('Resolve the copies before installing anywhere else.')
  expect(page().textContent!.match(/Resolve the copies before installing anywhere else\./g)).toHaveLength(1)
  expect(card('Cost')!.textContent).not.toContain('Resolve the copies')
  expect(page().querySelector('[data-slot="alert"]')?.parentElement?.getAttribute('data-measure')).toBe('container')
  await openMore(); expect(document.querySelector('[role="menu"]')!.textContent).not.toContain('Install to')
  await selectMenu('Resolve copies…')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Resolve')
})
it.each(['reaches', 'off'] as const)('keeps install availability out of Cost when the runtime is %s', async state => {
  await mount([skill({ reach: [{ runtime: one, state, basis: 'reported' }] })])
  const message = state === 'reaches' ? 'Every runtime already loads this.' : 'Nowhere left to install this.'
  expect(card('Cost')!.textContent).not.toContain(message)
  expect(page().textContent).not.toContain(message)
  await openMore()
  expect(document.querySelector('[role="menu"]')!.querySelector('[data-menu-note]')?.textContent).toBe(message)
})
it('More previews cleanup of writable empty copies only', async () => {
  const copy = skill().copies[0]!
  const request = await mount([skill({ copies: [copy, { ...copy, path: '/home/jane/.empty/skills/review', hollow: true, readOnly: false }, { ...copy, path: '/home/jane/.shipped/skills/review', hollow: true, readOnly: true }] })])
  await openMore(); await selectMenu('Clean up empty copy')
  expect(request).toHaveBeenCalledWith('library/plan', { intents: [{ kind: 'removeCopy', name: 'review', path: '/home/jane/.empty/skills/review' }] })
})

it('More batches more than three missing runtime targets into the existing per-runtime install plan', async () => {
  const targets = Array.from({ length: 5 }, (_, i) => runtimeId(`missing-${i}`))
  const request = await mount([skill({ reach: targets.map(runtime => ({ runtime, state: 'absent', basis: 'scanned' })) })])
  await openMore(); await selectMenu('Install to all 5 missing…')
  expect(request).toHaveBeenCalledWith('library/plan', { intents: targets.map(targetRuntime => ({ kind: 'installSkill', name: 'review', sourcePath: '/home/jane/.one/skills/review', targetRuntime })) })
})
it('Files does not invent an on-disk size when a flat definition is truncated', async () => {
  await mount([skill()], 'review', { text: raw, truncated: true, files: [], moreFiles: 0 })
  expect(card('Files')!.textContent).toContain('SKILL.md')
  expect(card('Files')!.textContent).not.toMatch(/\d+ B/)
})


it('shows host file flags on their own rows and the recorded install date', async () => {
  const installedAt = Date.UTC(2026, 9, 10, 12)
  const entry = skill()
  await mount([{ ...entry, copies: entry.copies.map(copy => ({ ...copy, origin: { ...origin, installedAt } })) }], 'review', {
    name: 'review', kind: 'skill', path: entry.copies[0]!.path, text: raw, truncated: false, moreFiles: 0,
    files: [{ path: 'SKILL.md', bytes: 90 }, { path: 'runner', bytes: 20, runnable: true }, { path: 'data.bin', bytes: 10, binary: true },
      { path: 'a.txt', bytes: 1 }, { path: 'b.txt', bytes: 1 }, { path: 'hidden.sh', bytes: 2, runnable: true }],
  })
  const rows = [...card('Files')!.querySelectorAll('[data-slot="row"]')]
  expect(rows.find(row => row.textContent?.includes('runner'))?.querySelector('[data-slot="chip"]')?.textContent).toBe('Can run')
  expect(rows.find(row => row.textContent?.includes('data.bin'))?.querySelector('[data-slot="chip"]')?.textContent).toBe('Binary')
  expect(rows[0]?.querySelector('[data-slot="chip"]')).toBeNull()
  expect(card('Source')?.textContent).toContain(`Installed${new Date(installedAt).toLocaleDateString()}`)
  await press('Show all files')
  expect(card('Files')?.textContent).toContain('hidden.shCan run')
})
it('omits unreported file flags and install date', async () => {
  await mount()
  expect(card('Files')?.querySelector('[data-slot="chip"]')).toBeNull()
  expect(card('Files')?.querySelector('[data-slot="row-title-chip"]')).toBeNull()
  expect(card('Source')?.textContent).not.toContain('Installed')
})

it('renders the recorded install date independently of file flags', async () => {
  const installedAt = Date.UTC(2026, 9, 10, 12), entry = skill()
  await mount([{ ...entry, copies: entry.copies.map(copy => ({ ...copy, origin: { ...origin, installedAt } })) }])
  expect(card('Source')?.textContent).toContain(`Installed${new Date(installedAt).toLocaleDateString()}`)
})

it.each([false, true])('merges matching sources and shows the newest copy date (reversed: %s)', async reverse => {
  const entry = skill(), older = Date.UTC(2026, 9, 9, 12), newer = Date.UTC(2026, 9, 10, 12)
  const copies = [
    { ...entry.copies[0]!, origin: { ...origin, installedAt: older } },
    { ...entry.copies[0]!, path: '/home/jane/.two/skills/review', readBy: [two], origin: { ...origin, installedAt: newer } },
  ]
  await mount([skill({ copies: reverse ? copies.reverse() : copies })])
  const source = card('Source')!
  expect([...source.querySelectorAll('[data-slot="row"]')].filter(row => row.textContent === 'acme-dev/skills')).toHaveLength(1)
  const date = source.querySelector('[title="Installed or updated"]')!
  expect(date).toBeTruthy()
  expect(date.querySelector('[data-slot="row-title"]')?.textContent).toBe('Installed')
  expect(date.textContent).toBe(`Installed${new Date(newer).toLocaleDateString()}`)
  expect(date.querySelector('[data-slot="row-ctl"]')?.textContent).toBe(new Date(newer).toLocaleDateString())
  expect(source.textContent).not.toContain(new Date(older).toLocaleDateString())
})


it('uses the same disclosure on every metadata aside card and keeps update problems initially readable', async () => {
  await mount([skill({ update: [update('unreachable', { reason: 'No response.' })], catalogTokens: 24 })])
  const aside = page().querySelector('[data-slot="skill-page-facts"]')!
  const sections = [...aside.querySelectorAll('[data-slot="tool-section"]')]
  expect(sections.map(one => one.getAttribute('aria-label'))).toEqual(['Update', 'Loaded by', 'Source', 'Files', 'Cost'])
  for (const section of sections) {
    const toggle = section.querySelector<HTMLButtonElement>('[data-slot="tool-section-fold"]')!
    expect(toggle, section.getAttribute('aria-label')!).not.toBeNull()
    expect(section.querySelector('[data-slot="tool-section-value"]')?.textContent).toBeTruthy()
  }
  expect(card('Update')?.querySelector<HTMLElement>('[data-slot="tool-section-body"]')?.hidden).toBe(false)
  expect(card('Source')?.querySelector<HTMLElement>('[data-slot="tool-section-body"]')?.hidden).toBe(true)
  expect(card('Files')?.querySelector<HTMLElement>('[data-slot="tool-section-body"]')?.hidden).toBe(true)
  expect(card('Cost')?.querySelector<HTMLElement>('[data-slot="tool-section-body"]')?.hidden).toBe(true)
})
