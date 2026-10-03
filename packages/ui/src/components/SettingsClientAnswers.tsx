import { useEffect, useRef, useState } from 'react'

import { Row, Rows, Section, Switch } from '../design'
import { useStore } from '../state/context'

const LABEL = 'Let command-line clients answer for me'

/** The stored preference; a scripted desk can also grant answers through its environment. */
export const ClientAnswersSection = () => {
  const store = useStore()
  const saving = useRef(false)
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setAllowed(null)
    // Preview and older stub stores do not offer this preference: stay off
    // and disabled rather than presenting a switch that cannot be saved.
    if (typeof store.loadClientsMayAnswer === 'function' && typeof store.setClientsMayAnswer === 'function') {
      void store.loadClientsMayAnswer().then((next) => {
        if (live) setAllowed(next === true)
      })
    }
    return () => { live = false }
  }, [store])

  const choose = async (next: boolean): Promise<void> => {
    if (allowed === null || saving.current || next === allowed) return
    saving.current = true
    const before = allowed
    setAllowed(next)
    setBusy(true)
    try {
      if (!await store.setClientsMayAnswer(next)) setAllowed(before)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <Section title="Local clients">
      <Rows title="Let command-line clients and other local clients answer for you.">
        <Row
          title={LABEL}
          control={
            <Switch
              aria-label={LABEL}
              checked={allowed === true}
              disabled={allowed === null || busy}
              onCheckedChange={(next) => void choose(next)}
            />
          }
        />
      </Rows>
    </Section>
  )
}
