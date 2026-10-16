import { useEffect, useRef, useState } from 'react'
import type { AgentTemplateInfo, RuntimeInfo } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'

/** One background scan per window store, including StrictMode and pane remounts. */
const scans = new WeakMap<AppStore, { result: Promise<readonly AgentTemplateInfo[]>; added: Set<string> }>()
const scan = (store: AppStore) => {
  let entry = scans.get(store)
  if (!entry) {
    const result = new Promise<readonly AgentTemplateInfo[]>(resolve => {
      const deadline = setTimeout(() => resolve([]), 8_000)
      void Promise.resolve().then(() => store.agentCatalog()).then(
        templates => { clearTimeout(deadline); resolve(templates ?? []) },
        () => { clearTimeout(deadline); resolve([]) },
      )
    })
    entry = { result, added: new Set() }
    scans.set(store, entry)
  }
  return entry
}

/** Uses exactly the Add a runtime page's detection and template registration. */
export const useInstalledAgents = (store: AppStore, runtimes: readonly RuntimeInfo[]) => {
  const [templates, setTemplates] = useState<readonly AgentTemplateInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const entry = scan(store)
    void entry.result.then(loaded => {
      if (!cancelled && loaded.length > 0) setTemplates(loaded.filter(template => !entry.added.has(template.key)))
    })
    return () => { cancelled = true; mounted.current = false }
  }, [store])

  const add = async (key: string) => {
    if (pending.current) return
    pending.current = true
    setBusy(key)
    try {
      const added = await store.addAgent({ template: key })
      if (added) {
        scan(store).added.add(key)
        if (mounted.current) setTemplates(current => current.filter(template => template.key !== key))
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(null)
    }
  }
  return {
    offers: templates.filter(template => template.available && template.requires?.found && !template.registered
      && !runtimes.some(runtime => runtime.id === template.key)),
    busy,
    add,
  }
}
