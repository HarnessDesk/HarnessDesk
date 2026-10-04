import { useEffect, useRef, useState } from 'react'
import type { FindingPublishAction, FindingPublicationsView } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'

/** Both publication doors use the same call, refusal, and read-back. No action is automatic. */
export function useFindingPublicationActions(goal: string, run: string, stamp: string) {
  const store = useStore()
  const snapshot = useSnapshot()
  const scope = JSON.stringify([goal, run])
  const [state, setState] = useState<{ scope: string; view: FindingPublicationsView | null; error: string | null; pending: string | null; acted: boolean }>(
    { scope, view: null, error: null, pending: null, acted: false },
  )
  const active = useRef<string | null>(scope)
  const busy = useRef<string | null>(null)
  const generation = useRef(0)
  const epoch = useRef(0)
  const patch = (change: Partial<Omit<typeof state, 'scope'>>) => setState(previous => ({
    ...(previous.scope === scope ? previous : { scope, view: null, error: null, pending: null, acted: false }), ...change,
  }))
  useEffect(() => {
    epoch.current += 1
    active.current = scope
    busy.current = null
    setState({ scope, view: null, error: null, pending: null, acted: false })
    return () => { active.current = null; epoch.current += 1; generation.current += 1 }
  }, [scope])
  useEffect(() => {
    const ticket = ++generation.current
    store.readFindingPublications(goal, run).then(
      view => { if (active.current === scope && ticket === generation.current) patch({ view }) },
      failure => { if (active.current === scope && ticket === generation.current) patch({ error: failure instanceof Error ? failure.message : String(failure) }) },
    )
    return () => { generation.current += 1 }
  }, [store, goal, run, stamp, snapshot.findingRuns.get(run)])

  const act = async (what: string, action: FindingPublishAction): Promise<boolean> => {
    if (busy.current !== null || active.current !== scope) return false
    const submitted = epoch.current
    const current = () => active.current === scope && epoch.current === submitted
    busy.current = what
    generation.current += 1
    patch({ pending: what, error: null })
    try {
      const view = await store.publishFinding({ goal, run, action })
      if (current()) patch({ view, acted: true })
      return current()
    } catch (failure) {
      if (current()) {
        patch({ error: failure instanceof Error ? failure.message : String(failure) })
        const ticket = ++generation.current
        // A refusal can itself leave a new uncertain posting: show the host's read-back.
        void store.readFindingPublications(goal, run).then(view => {
          if (current() && ticket === generation.current) patch({ view })
        }, () => {})
      }
      return false
    } finally {
      if (current()) { busy.current = null; patch({ pending: null }) }
    }
  }
  return { ...(state.scope === scope ? state : { view: null, error: null, pending: null, acted: false }), act }
}
