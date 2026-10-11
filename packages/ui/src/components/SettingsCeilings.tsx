import { useDestinationActive } from '../panels/destination-page'
import { useEffect, useRef, useState } from 'react'

import type { RuntimeInfo } from '@harnessdesk/protocol'

import { InlineParts, Note, Row, RowChoice, Rows, Section, RowValue, Text } from '../design'
import { runtimeHolds } from '../lib/ceilings'
import { useSnapshot, useStore } from '../state/context'
import type { UnheldCeilings } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import { CeilingChip } from './CeilingChip'

const RuntimeCeilings = ({ runtime }: { readonly runtime: RuntimeInfo }) => {
  const holds = runtimeHolds(runtime)
  return <Row
    mark={<RuntimeMark runtime={runtime} size={13} />}
    title={runtime.presentation.name}
    control={
      <RowValue>
        <InlineParts>
          {holds.map((hold) => (
            <CeilingChip
              key={hold.level}
              ceiling={{ level: hold.level, hold: hold.held ? 'held' : 'asked' }}
              note={hold.how}
              showHold={false}
            />
          ))}
        </InlineParts>
      </RowValue>
    }
  />
}

/** Runtime hold declarations and the policy for a watched seat they cannot hold. */
export const CeilingsSection = ({ focus = null }: { readonly focus?: string | null }) => {
  const destinationActive = useDestinationActive()

  const store = useStore()
  const snapshot = useSnapshot()
  const hasAskedCeiling = snapshot.runtimes.some((runtime) => runtimeHolds(runtime).some((hold) => !hold.held))
  const section = useRef<HTMLElement>(null)
  const saving = useRef(false)
  const savingUnattended = useRef(false)
  const watchedRead=useRef(0),unattendedRead=useRef(0)
  const [watched, setWatched] = useState<UnheldCeilings | null>(null)
  const [unattended, setUnattended] = useState<UnheldCeilings | null>(null)
  const [busy, setBusy] = useState(false)
  const [unattendedBusy, setUnattendedBusy] = useState(false)

  useEffect(() => {
    if (!destinationActive) return

    const watchedRevision=++watchedRead.current,unattendedRevision=++unattendedRead.current
    let live = true
    if (!saving.current) setWatched(null)
    if (!savingUnattended.current) setUnattended(null)
    if (!saving.current) void store.loadUnheldCeilings().then((next) => {
      if (live && watchedRevision===watchedRead.current && !saving.current) setWatched(next)
    })
    if (!savingUnattended.current) void store.loadUnattendedCeilings().then((next) => {
      if (live && unattendedRevision===unattendedRead.current && !savingUnattended.current) setUnattended(next)
    })
    return () => { live = false }
  }, [destinationActive, store])

  useEffect(() => {
    if (!destinationActive) return

    if (focus !== 'ceilings') return
    section.current?.scrollIntoView({ block: 'start' })
    section.current?.focus()
  }, [destinationActive, focus])

  const choose = async (next: UnheldCeilings): Promise<void> => {
    if (watched === null || saving.current) return
    watchedRead.current++
    saving.current = true
    setWatched(next)
    setBusy(true)
    try {
      await store.saveUnheldCeilings(next)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const chooseUnattended = async (next: UnheldCeilings): Promise<void> => {
    if (unattended === null || savingUnattended.current) return
    unattendedRead.current++
    savingUnattended.current = true
    setUnattended(next)
    setUnattendedBusy(true)
    try {
      await store.setUnattendedCeilings(next)
    } finally {
      savingUnattended.current = false
      setUnattendedBusy(false)
    }
  }

  const disabled = watched === null || busy
  const unattendedDisabled = unattended === null || unattendedBusy
  return (
    <>
      <Section
        ref={section}
        title="Ceilings"
        description="The most a seat may do. The desk’s tools enforce it, whatever a runtime reports back."
        tabIndex={-1}
      >
        <Rows>
          {snapshot.runtimes.map((runtime) => <RuntimeCeilings key={runtime.id} runtime={runtime} />)}
        </Rows>
        {hasAskedCeiling && <Note><span data-slot="ceiling-group-note"><Text role="meta">Asked, not enforced</Text></span></Note>}
      </Section>

      <Section title="A ceiling a runtime cannot hold" description="In a conversation you are watching.">
        <Rows role="radiogroup" aria-label="If a runtime cannot hold a ceiling">
          <RowChoice
            title="Seat it and say so"
            desc="The seat opens with its ceiling asked, drawn in the warning tone wherever it appears."
            selected={watched === 'seat'}
            disabled={disabled}
            onClick={() => void choose('seat')}
          />
          <RowChoice
            title="Refuse to seat it"
            desc="It is passed over, with why, and the next seat the Agent prefers is tried."
            selected={watched === 'refuse'}
            disabled={disabled}
            onClick={() => void choose('refuse')}
          />
        </Rows>
      </Section>

      <Section title="A ceiling a runtime cannot hold, unattended" description="In a Goal a trigger opened, with nobody watching.">
        <Rows role="radiogroup" aria-label="If a runtime cannot hold a ceiling in a Goal a trigger opened">
          <RowChoice
            title="Refuse to seat it"
            desc="It is passed over, with why. This is the default: unattended work never seats a Seat it cannot hold."
            selected={unattended === 'refuse'}
            disabled={unattendedDisabled}
            onClick={() => void chooseUnattended('refuse')}
          />
          <RowChoice
            title="Seat it and say so"
            desc="The seat opens with its ceiling asked, drawn in the warning tone wherever it appears — choosing this is an explicit decision, not a default."
            selected={unattended === 'seat'}
            disabled={unattendedDisabled}
            onClick={() => void chooseUnattended('seat')}
          />
        </Rows>
      </Section>
    </>
  )
}
