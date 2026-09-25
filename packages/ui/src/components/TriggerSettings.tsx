import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { TriggerPreferences } from '@harnessdesk/protocol'

import { KeyValue, KeyValueRow, Note, Row, RowInput, Rows, SectionHead, Switch } from '../design'
import { useStore } from '../state/context'

const money = (usd: number | null): string => (usd === null ? 'Unknown' : `$${usd.toFixed(2)}`)

/**
 * Workspaces › Triggers on this Mac: the one machine-wide pause and the
 * daily cap every armed trigger reserves against.
 *
 * A read-back precedes every shown value — turning the pause switch or
 * changing the cap never flips to its new-looking state until the host has
 * actually said so, and a rejected write (a stale revision, an invalid cap)
 * leaves exactly what was there before it. Like every Settings value, the cap
 * applies as it is changed (`RowInput`: Enter, or leaving the field); a cap
 * that is refused stays in its field, marked, with the reason read with it.
 */
export const TriggerSettings = ({ focus = null }: { readonly focus?: string | null }) => {
  const store = useStore()
  const [prefs, setPrefs] = useState<TriggerPreferences | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /** Why the cap in its field was refused; cleared by the next cap that is taken, or by Escape. */
  const [capProblem, setCapProblem] = useState<string | null>(null)
  const capNote = useId()
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const section = useRef<HTMLElement>(null)

  useEffect(() => {
    if (focus !== 'triggers') return
    section.current?.scrollIntoView({ block: 'start' })
    section.current?.focus()
  }, [focus])

  const load = useCallback((): void => {
    store.triggerPreferences().then(
      (next) => setPrefs(next),
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    )
  }, [store])

  useEffect(() => { load() }, [load])

  const apply = async (paused: boolean, dailyUsd: number, field: 'pause' | 'cap'): Promise<void> => {
    if (!prefs || saving.current) return
    saving.current = true
    setBusy(true)
    setProblem(null)
    if (field === 'cap') setCapProblem(null)
    try {
      const next = await store.setTriggerPreferences(prefs.revision, paused, dailyUsd)
      setPrefs(next)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'This could not be saved.'
      if (field === 'cap') setCapProblem(text)
      else setProblem(text)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const saveCap = (typed: string): void => {
    if (!prefs) return
    const value = Number(typed)
    if (typed.trim() === '' || !Number.isFinite(value) || value < 0) {
      setCapProblem('Give a daily cap of zero or more — zero means no new paid work.')
      return
    }
    void apply(prefs.paused, value, 'cap')
  }

  return (
    <section ref={section} aria-label="Triggers on this Mac" tabIndex={-1}>
      <SectionHead name="Triggers on this Mac" />
      <Note>
        Stops when reported spend reaches the limit. Work already running can cost more before it stops.
      </Note>
      {problem && <Note tone="bad">{problem}</Note>}
      {!prefs ? (
        <Rows><Row title="Reading…" /></Rows>
      ) : (
        <>
          <Rows>
            <Row
              title="Pause every trigger"
              desc="Stops watching every source and holds the work triggers started, interrupting what runs now. Resuming continues it and reads what arrived meanwhile; a check stopped part-way waits for you to run it again."
              control={(
                <Switch
                  checked={prefs.paused}
                  disabled={busy}
                  aria-label="Pause every trigger"
                  onCheckedChange={(checked) => void apply(checked, prefs.dailyUsd, 'pause')}
                />
              )}
            />
            <Row
              title="Stop for the day after"
              desc="US dollars of reported spend. Resets at midnight UTC; zero means no new paid work today."
              control={(
                <RowInput
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  aria-label="Stop for the day after, in US dollars"
                  {...(capProblem ? { 'aria-describedby': capNote } : {})}
                  disabled={busy}
                  value={String(prefs.dailyUsd)}
                  invalid={capProblem !== null}
                  onCommit={saveCap}
                  onRestore={() => setCapProblem(null)}
                />
              )}
            />
          </Rows>
          {capProblem && <Note id={capNote} tone="bad">{capProblem}</Note>}
          <KeyValue variant="panel">
            <KeyValueRow label="Today (UTC)">{prefs.day}</KeyValueRow>
            <KeyValueRow label="Reserved today">{money(prefs.reservedUsd)}</KeyValueRow>
            <KeyValueRow label="Charged today">{money(prefs.chargedUsd)}</KeyValueRow>
          </KeyValue>
          {prefs.dailyUsd === 0 && <Note>No new paid work: the daily cap is zero.</Note>}
          {prefs.chargedUsd === null && <Note>Today’s charged amount could not be vouched for; treated as unknown, never zero.</Note>}
        </>
      )}
    </section>
  )
}
