import { useEffect, useRef, useState } from 'react'

import type { RuntimeInfo } from '@harnessdesk/protocol'

import { Row, RowChoice, Rows, Section } from '../design'
import { runtimeHolds } from '../lib/ceilings'
import { useSnapshot, useStore } from '../state/context'
import type { UnheldCeilings } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import { CeilingChip } from './CeilingChip'

const RuntimeCeilings = ({ runtime }: { readonly runtime: RuntimeInfo }) => (
  <Row
    mark={<RuntimeMark runtime={runtime} size={13} />}
    title={runtime.presentation.name}
    control={
      <span className="flex flex-wrap justify-end gap-2">
        {runtimeHolds(runtime).map((hold) => (
          <CeilingChip
            key={hold.level}
            ceiling={{ level: hold.level, hold: hold.held ? 'held' : 'asked' }}
            note={hold.how}
          />
        ))}
      </span>
    }
  />
)

/** Runtime hold declarations and the policy for a watched seat they cannot hold. */
export const CeilingsSection = ({ focus = null }: { readonly focus?: string | null }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const section = useRef<HTMLElement>(null)
  const saving = useRef(false)
  const savingUnattended = useRef(false)
  const [watched, setWatched] = useState<UnheldCeilings | null>(null)
  const [unattended, setUnattended] = useState<UnheldCeilings | null>(null)
  const [busy, setBusy] = useState(false)
  const [unattendedBusy, setUnattendedBusy] = useState(false)

  useEffect(() => {
    let live = true
    setWatched(null)
    setUnattended(null)
    void store.loadUnheldCeilings().then((next) => {
      if (live) setWatched(next)
    })
    void store.loadUnattendedCeilings().then((next) => {
      if (live) setUnattended(next)
    })
    return () => { live = false }
  }, [store])

  useEffect(() => {
    if (focus !== 'ceilings') return
    section.current?.scrollIntoView({ block: 'start' })
    section.current?.focus()
  }, [focus])

  const choose = async (next: UnheldCeilings): Promise<void> => {
    if (watched === null || saving.current) return
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
