import { useDestinationActive } from '../panels/destination-page'
import { useEffect, useRef, useState } from 'react'

import type { RuntimeInfo } from '@harnessdesk/protocol'

import { Chip, DisclosureChevron, Row, RowButton, RowChoice, Rows, Section, SegmentedReadout } from '../design'
import { agentGroups } from '../lib/accounts'
import { runtimeHolds } from '../lib/ceilings'
import { ceilingWords } from '../lib/agents'
import { useSnapshot, useStore } from '../state/context'
import type { UnheldCeilings } from '../state/store'
import { RuntimeMark } from './BrandIcons'

const RuntimeCeilings = ({ runtime }: { readonly runtime: RuntimeInfo }) => {
  const holds = runtimeHolds(runtime)
  const effective = [...holds].reverse().find((hold) => hold.held)?.level ?? 'read'
  const enforced = holds.some((hold) => hold.level === effective && hold.held)
  const options = holds.map((hold) => ({
    value: hold.level,
    label: hold.level === 'read' ? 'Read only' : ceilingWords(hold.level),
    disabled: true,
  }))
  return <Row
    mark={<RuntimeMark runtime={runtime} size={13} />}
    title={runtime.presentation.name}
    titleChip={<Chip tone="neutral" size="sm">{enforced ? 'Enforced' : 'Asked'}</Chip>}
    control={<SegmentedReadout
      label={`${runtime.presentation.name} ceiling`}
      options={options}
      value={effective}
    />}
  />
}

/** Runtime hold declarations and the policy for a watched seat they cannot hold. */
export const CeilingsSection = ({ focus = null }: { readonly focus?: string | null }) => {
  const destinationActive = useDestinationActive()

  const store = useStore()
  const snapshot = useSnapshot()
  const section = useRef<HTMLElement>(null)
  const saving = useRef(false)
  const savingUnattended = useRef(false)
  const watchedRead=useRef(0),unattendedRead=useRef(0)
  const [watched, setWatched] = useState<UnheldCeilings | null>(null)
  const [unattended, setUnattended] = useState<UnheldCeilings | null>(null)
  const [busy, setBusy] = useState(false)
  const [unattendedBusy, setUnattendedBusy] = useState(false)
  const [otherOpen, setOtherOpen] = useState(false)
  const used = new Set([
    ...snapshot.sessions.values(), ...snapshot.history, ...snapshot.historyIdentity,
  ].map(session => session.runtime))
  const groups = agentGroups(snapshot.runtimes)
  const inUse = (group: typeof groups[number]): boolean => group.siblings.some(info =>
    (snapshot.accountsByRuntime[info.id]?.accounts.length ?? 0) > 0 || used.has(info.id))
  const active = groups.filter(inUse)
  const other = groups.filter(group => !inUse(group))

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
          {active.flatMap(group => group.siblings).map(runtime => <RuntimeCeilings key={runtime.id} runtime={runtime} />)}
          {other.length > 0 && <RowButton
            title={`Other runtimes · ${other.length}`}
            aria-expanded={otherOpen}
            chevron={false}
            control={<DisclosureChevron open={otherOpen} placement="trailing" />}
            onClick={() => setOtherOpen(open => !open)}
          />}
          {otherOpen && other.flatMap(group => group.siblings).map(runtime => <RuntimeCeilings key={runtime.id} runtime={runtime} />)}
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
