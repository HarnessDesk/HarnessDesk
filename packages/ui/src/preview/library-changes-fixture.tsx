import { useEffect, useRef } from 'react'
import type { HostResult, LibraryPlannedOp } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'
import { useStore } from '../state/context'
import { libraryWriteToasts } from '../components/LibraryWriteToast'

/** All dates are relative to the preview clock, including across local midnight. */
export const libraryChangesEntries = (store: AppStore): HostResult<'audit/query'> => {
  const [alpha, beta, gamma] = store.getSnapshot().runtimes
  const today = new Date(); today.setHours(11, 0, 0, 0)
  const at = (days: number, hour: number) => { const date = new Date(today); date.setDate(date.getDate() - days); date.setHours(hour); return date.getTime() }
  return ([
    ['code-review', 'update', 0, 11, alpha, true], ['project-checks', 'update', 0, 10, alpha, true],
    ['changelog', 'create', 0, 9, beta, false], ['deploy-notes', 'remove', 1, 16, gamma, true],
    ['security-audit', 'create', 1, 14, beta, false], ['benchmark', 'replace', 6, 15, alpha, true],
    ['brainstorming', 'create', 9, 11, beta, false],
  ] as const).map(([name, op, days, hour, runtime, backup]) => ({
    kind: 'library/write', at: at(days, hour), runtime: runtime!.id,
    sessionId: 'synthetic-library', op: `skill/${op}`, name, path: `/home/jane/skills/${name}/SKILL.md`,
    status: name === 'security-audit' ? 'failed' : 'done',
    ...(backup ? { backupPath: `/home/jane/backups/${name}/SKILL.md` } : {}),
    ...(name === 'security-audit' ? { detail: 'Permission denied' } : {}),
  }))
}
export const installLibraryChangesFixture = (store: AppStore, empty = false): void => {
  const request = store.transport.request.bind(store.transport)
  Object.assign(store.getSnapshot(), { runtimes: store.getSnapshot().runtimes.map((runtime, index) => ({ ...runtime, presentation: { ...runtime.presentation, name: ['Alpha', 'Beta', 'Gamma'][index] ?? runtime.presentation.name } })) })
  store.transport.request = (async (method, params) => {
    if (method === 'audit/query') return empty ? [] : libraryChangesEntries(store)
    const result = await request(method, params as never)
    if (method === 'library/read') return { ...result as object, home: '/home/jane' }
    return result
  }) as typeof store.transport.request
}
/** Toast frames exercise the same helper called after a real Library apply. */
export const LibraryWriteToastFixture = ({ shape }: { readonly shape: string | null }) => {
  const store = useStore()
  const raised = useRef(false)
  useEffect(() => {
    if (!shape || raised.current) return
    raised.current = true
    const op: LibraryPlannedOp = { id: 'one', kind: 'skill', name: 'code-review', action: 'update', targetPath: '/home/jane/skills/code-review', guardDigest: null, backup: false }
    const ops = shape === 'several' || shape === 'installs' || shape === 'failures' ? [op, { ...op, id: 'two', name: 'project-checks' }] : [op]
    libraryWriteToasts(shape === 'installs' ? ops.map(one => ({ ...one, action: 'create' as const })) : ops,
      ops.map(one => ({ id: one.id, outcome: shape === 'failed' || shape === 'failures' ? 'failed' : 'done', detail: 'Permission denied' })),
      () => store.openDestination({ kind: 'library', section: 'changes' }))
  }, [store, shape])
  return null
}
