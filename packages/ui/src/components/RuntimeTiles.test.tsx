import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { LibraryEntry } from '@harnessdesk/protocol'
import { previewStore, runtime } from '../preview/harness'
import { StoreProvider } from '../state/context'
import { AddAgentsTestPage } from '../test-support/settings-page'
import { RuntimeFace } from './RuntimeFace'
import { SkillRow, SkillList } from './SkillRow'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps each brand tint across Add, the runtime roster and Loaded by, independent of account tint and runtime id', async () => {
  const brands = ['codex', 'claudecode', 'cursor'] as const
  const infos = brands.map((brand, index) => ({ ...runtime(`installed-${index}`, `Runtime ${index}`), presentation: { name: `Runtime ${index}`, brand } }))
  const store = previewStore({ runtimes: infos, accountPrefs: Object.fromEntries(infos.map(info => [`${info.id}:oauth:dev@example.com`, { tint: 'rose' as const }])), accountsByRuntime: Object.fromEntries(infos.map(info => [info.id, { accounts: [{ kind: 'oauth', label: 'dev@example.com' }], signInMethods: [] }])) })
  store.agentCatalog = async () => brands.map((brand, index) => ({ key: `template-${index}`, name: `Runtime ${index}`, brand, available: true, registered: false }))
  const entry = { kind: 'skill', name: 'shared', copies: [], reach: infos.map(info => ({ runtime: info.id, state: 'reaches', basis: 'reported' })) } as LibraryEntry
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<StoreProvider store={store}>
      <section data-surface="add"><AddAgentsTestPage onBack={() => {}} onDone={() => {}} /></section>
      <section data-surface="roster">{infos.map(info => <RuntimeFace key={info.id} runtime={info} />)}</section>
      <section data-surface="library"><SkillList><SkillRow entry={entry} columns={infos.map(info => ({ id: info.id, label: info.presentation.name, info }))} onOpen={() => {}} /></SkillList></section>
    </StoreProvider>))
    const tints = (surface: string, selector: string) => [...host.querySelectorAll(`[data-surface="${surface}"] ${selector}`)].map(tile => tile.getAttribute('data-tint'))
    const add = tints('add', '[data-slot="icon-tile"]')
    expect(tints('roster', '[data-slot="icon-tile"]')).toEqual(add)
    expect(tints('library', '[data-slot="avatar"]')).toEqual(add)
    expect(new Set(add).size).toBe(3)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
