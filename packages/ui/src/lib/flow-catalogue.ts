import { useEffect, useState } from 'react'
import type { FlowEntry, FlowExecution, FlowPolicy } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import type { AppStore } from '../state/store'
import { projectRootOf } from './projects'
import { projectWorkspaces } from './chats'

export interface CatalogueFlow { readonly root: string; readonly entry: FlowEntry }
interface CatalogueResult {
  readonly rows: readonly CatalogueFlow[]
  readonly roots: readonly string[]
  readonly loading: boolean
  readonly problems: readonly { readonly root: string; readonly message: string }[]
}

/** Shared layers appear once; a project's same-named Flow remains its own file. */
export const catalogueFlows = (lists: readonly { readonly root: string; readonly entries: readonly FlowEntry[] }[]): CatalogueFlow[] => {
  const rows = new Map<string, CatalogueFlow>()
  for (const { root, entries } of lists) for (const entry of entries) {
    const key = JSON.stringify([entry.origin, entry.origin === 'project' ? root : null, entry.id])
    if (!rows.has(key)) rows.set(key, { root, entry })
  }
  return [...rows.values()]
}

const canonical = (policy: FlowPolicy): string => JSON.stringify(policy, (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)

/** Count the exact saved policy, rather than aliasing two unrelated Flows with the same title. */
export const matchingFlowRuns = (policy: FlowPolicy | null | undefined, runs: Iterable<FlowExecution>): FlowExecution[] => {
  if (!policy) return []
  const wanted = canonical(policy)
  return [...runs].filter(run => run.document.format === 'agents' && canonical(run.document.flow) === wanted)
}
export const runsForPolicy = (policy: FlowPolicy | null | undefined, runs: Iterable<FlowExecution>): number => matchingFlowRuns(policy, runs).length

/** A missing execution is not proof that a Team had no Flow; retain the batch reader's coverage. */
export const useFlowRunCoverage = (active: boolean) => {
  const store = useStore(), snapshot = useSnapshot()
  const [catalogueReady, setCatalogueReady] = useState(false)
  useEffect(() => {
    if (!active) return
    let live = true
    setCatalogueReady(false)
    void Promise.resolve().then(() => store.loadGoals()).then(() => { if (live) setCatalogueReady(true) }, () => {})
    return () => { live = false }
  }, [active, store])
  const key = JSON.stringify([...snapshot.goals.keys()].sort())
  const [coverage, setCoverage] = useState<{ key: string; unavailable: ReadonlySet<string> } | null>(null)
  useEffect(() => {
    if (!active || !catalogueReady) return
    let live = true
    const teams = JSON.parse(key) as string[]
    if (!teams.length) { setCoverage({ key, unavailable: new Set() }); return }
    void Promise.resolve().then(() => store.loadTeamRunsBatch(teams)).then(result => {
      if (live) setCoverage({ key, unavailable: new Set(teams.filter(team => !result.loaded.has(team) || result.unavailable.has(team))) })
    }, () => { if (live) setCoverage({ key, unavailable: new Set(teams) }) })
    return () => { live = false }
  }, [active, store, key, catalogueReady])
  return (root?: string): boolean => catalogueReady && coverage?.key === key
    && ![...coverage.unavailable].some(team => !root || snapshot.goals.get(team)?.goal.root === root)
}

const pending = new WeakMap<AppStore, Map<string, Promise<readonly FlowEntry[]>>>()
const read = (store: AppStore, root: string): Promise<readonly FlowEntry[]> => {
  let reads = pending.get(store)
  if (!reads) { reads = new Map(); pending.set(store, reads) }
  const held = reads.get(root)
  if (held) return held
  const request = Promise.resolve().then(() => store.flowCatalog(root))
  reads.set(root, request)
  void request.finally(() => { if (reads.get(root) === request) reads.delete(root) }).catch(() => {})
  return request
}

/** Catalogue reads spend nothing and are retired when their destination or project set changes. */
export const useFlowCatalogue = (active = true): CatalogueResult & { readonly retry: () => void } => {
  const store = useStore(), snapshot = useSnapshot()
  const roots = [...new Set(projectWorkspaces([...(snapshot.workspace ? [snapshot.workspace] : []), ...snapshot.workspaces], snapshot.chatsFolderRoots).map(projectRootOf).filter((root): root is string => !!root))]
  const rootsKey = JSON.stringify(roots)
  const routeKey = JSON.stringify(snapshot.workbench.navigation.current)
  const [attempt, setAttempt] = useState(0)
  const key = `${rootsKey}\0${routeKey}\0${attempt}`
  const [result, setResult] = useState<CatalogueResult & { key: string }>({ key: '', rows: [], roots: [], loading: true, problems: [] })
  useEffect(() => {
    if (!active) return
    let live = true
    const requested = JSON.parse(rootsKey) as string[]
    // Keep known project choices and an open trigger editor stable during a
    // reread. Screens still wait for settlement before offering new work.
    setResult(previous => ({ key, rows: [], roots: previous.roots.filter(root => requested.includes(root)), loading: true, problems: [] }))
    void Promise.allSettled(requested.map(root => read(store, root))).then(results => {
      if (!live) return
      const lists: { root: string; entries: readonly FlowEntry[] }[] = [], problems: { root: string; message: string }[] = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') lists.push({ root: requested[index]!, entries: result.value })
        else problems.push({ root: requested[index]!, message: result.reason instanceof Error ? result.reason.message : String(result.reason) })
      })
      // Remembered folders can outlive their checkout. Only successful reads
      // establish a project the gallery can offer for editing or starting.
      setResult({ key, rows: catalogueFlows(lists), roots: lists.map(list => list.root), loading: false, problems })
    })
    return () => { live = false }
  }, [store, rootsKey, key, active])
  return { ...(result.key === key ? result : { rows: [], loading: true, problems: [], roots: result.roots.filter(root => roots.includes(root)) }), retry: () => setAttempt(value => value + 1) }
}
