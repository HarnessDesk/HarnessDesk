import { installTopBarTestLayout } from '../test/top-bar-layout'
import { act, useState } from 'react'
import type { PageDestination } from '../state/destinations'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { LibrarySection } from '../components/Library'
import { PluginsSection } from '../components/PluginsSection'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReleaseStills } from './release-stills'

// This check owns the clip store and real page controls. Retained work, the
// sidebar and the other App destinations are covered by release-stills.test.
vi.mock('./page-preview', () => ({ CurrentPagePreview: ({ page }: { page: PageDestination }) => {
  const [section, setSection] = useState<'installed' | 'capabilities'>('capabilities')
  const [id, setId] = useState<string | null>(null)
  return <TopBarProvider><TopBarOutlet owner="clip" fallback={{ place: '', more: () => null }} />
    <DestinationPageScope owner="clip" active>
      {page.kind === 'library'
        ? <LibrarySection section="skill" onSection={() => {}} importIntent={0} />
        : <PluginsSection section={section} id={id} onSection={setSection} onPlugin={setId} />}
    </DestinationPageScope>
  </TopBarProvider>
} }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

installTopBarTestLayout()
// Advance the rig's layout frame directly; jsdom has no paint to wait for.
beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] }))
afterEach(() => vi.useRealTimers())
const settle = () => act(async () => { vi.advanceTimersToNextFrame() })
const selectLibraryMatrix = async (host: ParentNode): Promise<void> => {
  const trigger = host.querySelector<HTMLButtonElement>('[data-slot="popover-trigger"][title="How to show the library"]')
  expect(trigger).toBeTruthy()
  await act(async () => trigger!.click())
  const matrix = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find(node => node.textContent?.trim() === 'Matrix')
  expect(matrix).toBeTruthy()
  await act(async () => matrix!.click())
}

it('the clip rig answers real plugin switches and reads a public skill definition', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(name))!
  try {
    window.history.replaceState(null, '', '/?release-stills=plugin-permissions&site-clip')
    await act(async () => root.render(<ReleaseStills />))
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Plugin sections"]')!.click())
    const installed = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(button => button.textContent?.startsWith('Installed'))!
    await act(async () => installed.click()); await settle()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-plugin-name="Project docs"]')!.click()); await settle()
    const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label$="Project docs"]')!
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle().click()); await settle()
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    await act(async () => toggle().click()); await settle()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await act(async () => root.render(null))
    window.history.replaceState(null, '', '/?release-stills=library&site-clip')
    await act(async () => root.render(<ReleaseStills />))
    await selectLibraryMatrix(host)
    expect(host.querySelector('[data-slot="library-matrix"]')).toBeTruthy()
    await act(async () => button('code-review').click())
    await act(async () => button('Read the definition').click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Correctness first')
    expect(dialog.textContent).not.toContain('/home/')
  } finally {
    act(() => root.unmount())
    host.remove()
    window.history.replaceState(null, '', '/')
  }
})
