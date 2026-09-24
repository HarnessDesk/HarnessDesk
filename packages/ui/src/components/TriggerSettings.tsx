import { useCallback, useEffect, useRef, useState } from 'react'

import type { TriggerPreferences } from '@harnessdesk/protocol'

import { Button, Field, Input, KeyValue, KeyValueRow, Note, Row, Rows, SectionHead, Switch } from '../design'
import { useStore } from '../state/context'

const money = (usd: number | null): string => (usd === null ? 'Unknown' : `$${usd.toFixed(2)}`)

/**
 * Workspaces › Triggers on this Mac: the one machine-wide pause and the
 * daily cap every armed trigger reserves against.
 *
 * A read-back precedes every shown value — turning the pause switch or
 * saving a cap never flips to its new-looking state until the host has
 * actually said so, and a rejected write (a stale revision, an invalid cap)
 * leaves exactly what was there before it.
 */
export const TriggerSettings = ({ focus = null }: { readonly focus?: string | null }) => {
  const store = useStore()
  const [prefs, setPrefs] = useState<TriggerPreferences | null>(null)
  const [dailyInput, setDailyInput] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
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
      (next) => { setPrefs(next); setDailyInput(String(next.dailyUsd)) },
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    )
  }, [store])

  useEffect(() => { load() }, [load])

  const apply = async (paused: boolean, dailyUsd: number): Promise<void> => {
    if (!prefs || saving.current) return
    saving.current = true
    setBusy(true)
    setProblem(null)
    try {
      const next = await store.setTriggerPreferences(prefs.revision, paused, dailyUsd)
      setPrefs(next)
      setDailyInput(String(next.dailyUsd))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'This could not be saved.')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const saveCap = (): void => {
    if (!prefs) return
    const value = Number(dailyInput)
    if (!Number.isFinite(value) || value < 0) {
      setProblem('Give a daily cap of zero or more — zero means no new paid work.')
      return
    }
    void apply(prefs.paused, value)
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
              desc="Stops watching every source and holds the work triggers started, interrupting what runs now. Resuming continues it and reads what arrived meanwhile."
              control={(
                <Switch
                  checked={prefs.paused}
                  disabled={busy}
                  aria-label="Pause every trigger"
                  onCheckedChange={(checked) => void apply(checked, prefs.dailyUsd)}
                />
              )}
            />
          </Rows>
          <Field label="Stop for the day after" hint="Resets at midnight UTC. Zero means no new paid work today.">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                inputMode="decimal"
                disabled={busy}
                value={dailyInput}
                onChange={(event) => setDailyInput(event.target.value)}
              />
            )}
          </Field>
          <Button variant="secondary" disabled={busy || dailyInput === String(prefs.dailyUsd)} onClick={saveCap}>
            Save
          </Button>
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
