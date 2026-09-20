import { useEffect, useRef, useState } from 'react'

import type { RuntimeInfo } from '@harnessdesk/protocol'

import { Note, Row, RowChoice, Rows, SectionHead } from '../design'
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
  const [watched, setWatched] = useState<UnheldCeilings | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setWatched(null)
    void store.loadUnheldCeilings().then((next) => {
      if (live) setWatched(next)
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

  const disabled = watched === null || busy
  return (
    <section ref={section} aria-label="Ceilings" tabIndex={-1}>
      <SectionHead name="Ceilings" />
      <Note>
        The most a seat may do. Runtime controls are set and read back when a seat opens; a live seat reports its own result.
        The desk’s tools enforce its ceiling either way.
      </Note>
      <Rows>
        {snapshot.runtimes.map((runtime) => <RuntimeCeilings key={runtime.id} runtime={runtime} />)}
      </Rows>

      <SectionHead name="If a runtime cannot hold a ceiling" />
      <Note>In a conversation you are watching:</Note>
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
    </section>
  )
}
