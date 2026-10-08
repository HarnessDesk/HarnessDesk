import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FlowPreview } from '@harnessdesk/protocol'
import { useStore } from '../state/context'
import { ReleaseStills } from './release-stills'
import { RUN_FLOW_SOURCE } from './run-view-fixture'

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
