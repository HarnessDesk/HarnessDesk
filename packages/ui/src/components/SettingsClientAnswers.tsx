import { useDestinationActive } from '../panels/destination-page'
import { useEffect, useRef, useState } from 'react'

import type { McpStartsView } from '@harnessdesk/protocol'

import { NativeSelect, Row, Rows, Section, SectionHead, Switch } from '../design'
import { useStore } from '../state/context'

const LABEL = 'Let command-line clients answer for me'
const MCP_LABEL = 'Let MCP clients start work'
const DAILY_LABEL = 'Starts a day'
/** The daily numbers offered. The desk accepts any from 1 to 50; a number set elsewhere is shown too. */
const DAILY_CHOICES = [1, 3, 5, 10, 20, 50] as const

/** The stored preference; a scripted desk can also grant answers through its environment. */
export const ClientAnswersSection = () => {
  const destinationActive = useDestinationActive()

  const store = useStore()
  const saving = useRef(false)
  const readRevision = useRef(0)
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!destinationActive || saving.current) return

    const revision=++readRevision.current
    let live = true
    setAllowed(null)
    // Preview and older stub stores do not offer this preference: stay off
    // and disabled rather than presenting a switch that cannot be saved.
    if (typeof store.loadClientsMayAnswer === 'function' && typeof store.setClientsMayAnswer === 'function') {
      void store.loadClientsMayAnswer().then((next) => {
        if (live && revision===readRevision.current && !saving.current) setAllowed(next === true)
      })
    }
    return () => { live = false }
  }, [destinationActive, store])

  const choose = async (next: boolean): Promise<void> => {
    if (allowed === null || saving.current || next === allowed) return
    readRevision.current++
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
      <McpStartsRows active={destinationActive} />
    </Section>
  )
}

/**
 * Whether an MCP client may start work, and how many times a day. The desk
 * holds this, not window preferences, and a start it refuses is not counted.
 */
const McpStartsRows = ({ active }: { active: boolean }) => {
  const store = useStore()
  const saving = useRef(false)
  const readRevision = useRef(0)
  const [view, setView] = useState<McpStartsView | null>(null)
  const [busy, setBusy] = useState(false)
  const offered = typeof store.loadMcpStarts === 'function' && typeof store.setMcpStarts === 'function'

  const read = (): (() => void) => {
    const revision = ++readRevision.current
    let live = true
    if (offered) {
      void store.loadMcpStarts().then((next) => {
        if (live && revision === readRevision.current && !saving.current) setView(next)
      })
    }
    return () => { live = false }
  }

  useEffect(() => {
    if (!active || saving.current) return
    setView(null)
    return read()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, store])

  const change = async (patch: { mayStart?: boolean; dailyStarts?: number }): Promise<void> => {
    if (view === null || saving.current) return
    readRevision.current++
    saving.current = true
    const before = view
    setView({ ...view, ...patch })
    setBusy(true)
    let saved: McpStartsView | null = null
    try {
      saved = await store.setMcpStarts(before.revision, patch)
      setView(saved ?? before)
    } finally {
      saving.current = false
      setBusy(false)
    }
    // A refused save may mean the stored revision moved on: read it again.
    if (saved === null) read()
  }

  const environment = view?.source === 'environment'
  const choices = view && !DAILY_CHOICES.includes(view.dailyStarts as typeof DAILY_CHOICES[number])
    ? [...DAILY_CHOICES, view.dailyStarts].sort((a, b) => a - b) : [...DAILY_CHOICES]

  return (
    <>
      <SectionHead level="label" name="MCP clients" />
      <Rows>
        <Row
          title={MCP_LABEL}
          tooltip={environment ? 'Turned on by HARNESSDESK_MCP_MAY_START in this desk’s environment.' : undefined}
          desc={view?.mayStart ? `${view.started} of ${view.dailyStarts} used today` : undefined}
          control={
            <Switch
              aria-label={MCP_LABEL}
              checked={view?.mayStart === true}
              disabled={view === null || busy || environment}
              onCheckedChange={(next) => void change({ mayStart: next })}
            />
          }
        />
        <Row
          title={DAILY_LABEL}
          tooltip="Counted from midnight, your time. A start that fails is not counted."
          control={
            <NativeSelect
              aria-label={DAILY_LABEL}
              value={String(view?.dailyStarts ?? 5)}
              disabled={view === null || !view.mayStart || busy}
              onChange={(event) => void change({ dailyStarts: Number(event.target.value) })}
            >
              {choices.map((count) => <option key={count} value={count}>{count}</option>)}
            </NativeSelect>
          }
        />
      </Rows>
    </>
  )
}
