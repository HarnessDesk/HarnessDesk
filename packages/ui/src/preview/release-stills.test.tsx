import { installTopBarTestLayout } from '../test/top-bar-layout'
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FlowPreview } from '@harnessdesk/protocol'
import { useStore } from '../state/context'
import { ReleaseStills } from './release-stills'
import { RUN_FLOW_SOURCE } from './run-view-fixture'

installTopBarTestLayout()
const settle = () => act(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
const selectLibraryMatrix = async (host: ParentNode): Promise<void> => {
  const trigger = host.querySelector<HTMLButtonElement>('[data-slot="popover-trigger"][title="How to show the library"]')
  expect(trigger).toBeTruthy()
  await act(async () => trigger!.click())
  const matrix = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find(node => node.textContent?.trim() === 'Matrix')
  expect(matrix).toBeTruthy()
  await act(async () => matrix!.click())
}

it('retains a Library inventory and its expanded skill while visiting the installed plugin page', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '/?release-stills=library')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ReleaseStills />))
    expect(container.textContent).toContain('Library')
    await selectLibraryMatrix(container)
    expect(container.querySelector('[data-slot="library-matrix"]')).toBeTruthy()
    const skill = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('code-review'))
    expect(skill).toBeTruthy()
    await act(async () => skill!.click())
    expect(skill!.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Read the definition')
    const column = container.querySelector('[data-left-column]')!
    const plugins = [...column.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent==='Plugins')!
    await act(async()=>plugins.click()); await settle()
    expect(container.textContent).toContain('Project docs')
    expect(container.textContent).toContain('Project checks')
    const back = column.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!
    await act(async()=>back.click()); await settle()
    expect(container.querySelector('[data-page-destination="library"]:not([hidden]) [aria-expanded="true"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    window.history.replaceState(null, '', '/')
  }
})

it('shows a plugin’s held access in the production detail page', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '/?release-stills=plugin-permissions')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ReleaseStills />))
    const installed = container.querySelector<HTMLButtonElement>('[data-team-page="installed"]') ?? [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button=>button.textContent?.startsWith('Installed'))!
    await act(async()=>installed.click()); await settle()
    const plugin = container.querySelector<HTMLButtonElement>('[data-plugin-name="Project docs"]')
    expect(plugin).toBeTruthy()
    await act(async () => plugin!.click()); await settle()
    expect(container.textContent).toContain('Access')
    expect(container.textContent).toContain('Read files in the open project')
    expect(container.textContent).toContain('Reach docs.acme.dev')
    expect(container.textContent).not.toContain('Change files in the open project')
    expect(container.textContent).not.toContain('Run programs on this machine')
    expect(container.textContent).not.toContain('Reach any host')
  } finally {
    act(() => root.unmount())
    container.remove()
    window.history.replaceState(null, '', '/')
  }
})

let preview: FlowPreview
let source: string
vi.mock('../components/FlowStart', () => ({ FlowStart: ({ root, initial }: { root: string; initial: { source: string; vars: Record<string, string> } }) => {
  const store = useStore()
  useEffect(() => {
    source = initial.source
    void store.previewFlow(root, source, initial.vars).then(value => { preview = value })
  }, [store, root, initial])
  return null
} }))

it('previews every declared agent slot with a distinct role and index', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '/?release-stills=flow-start-preview')
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<ReleaseStills />))
    expect(source).toBe(RUN_FLOW_SOURCE)
    const reviewerCount = Number(source.match(/  reviewer:\n[\s\S]*?    count: (\d+)/)?.[1])
    expect(preview.seats.filter(seat => seat.role === 'reviewer')).toHaveLength(reviewerCount)
    const document = preview.compiled.document
    expect(document.format).toBe('agents')
    if (document.format !== 'agents') throw new Error('Expected an agent Flow')
    const slots = document.flow.roles.flatMap(role => role.kind === 'agent'
      ? Array.from({ length: role.count ?? 1 }, (_, index) => ({ role: role.id, index })) : [])
    expect(preview.seats.map(({ role, index }) => ({ role, index }))).toEqual(slots)
    expect(preview.seats.filter(seat => seat.reviews).map(seat => seat.plan.ceiling)).toEqual([
      { level: 'read', hold: 'held' }, { level: 'read', hold: 'held' },
    ])
  } finally {
    act(() => root.unmount())
    window.history.replaceState(null, '', '/')
  }
})
