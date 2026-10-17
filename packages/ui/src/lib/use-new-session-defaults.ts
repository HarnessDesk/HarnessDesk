import { useEffect, useRef, useState } from 'react'
import type { ConfigOption, OptionValue, RuntimeId } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { explainedBySignIn } from './sign-in-refusal'

/** Settings keeps recovery declarations separate from validated start values. */
export const useNewSessionDefaults = (runtime: RuntimeId, active: boolean) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const health = snapshot.healthByRuntime[runtime]?.state
  const account = snapshot.accountsByRuntime[runtime]
  const [options, setOptions] = useState<readonly ConfigOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const read = async (operation: () => Promise<readonly ConfigOption[]>, validate = false) => {
    const request = ++generation.current
    const current = () => generation.current === request
    try {
      let loaded = await operation()
      if (validate && current()) loaded = await store.newSessionDefaultsFor(runtime)
      if (current()) { setOptions(loaded); setError(null) }
    } catch (failure) {
      if (!current()) return
      // A signed-out agent's refusal is what its page already says (#1775).
      setError(explainedBySignIn(failure, account) ? null
        : failure instanceof Error ? failure.message : 'The runtime could not read its new-conversation defaults. Try again.')
      const choices = await store.newSessionDefaultChoicesFor(runtime).catch(() => [])
      if (current()) setOptions(choices)
    }
  }

  useEffect(() => {
    setOptions(null)
    setError(null)
    if (active) void read(() => store.newSessionDefaultsFor(runtime))
    return () => { generation.current++ }
  }, [active, store, runtime, health])

  return { options, error,
    pick: (id: string, value: OptionValue) => { void read(() => store.setNewSessionDefault(runtime, id, value), error !== null) },
    clear: (id: string) => { void read(() => store.clearNewSessionDefault(runtime, id)) },
  }
}
