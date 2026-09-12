import { useCallback, useEffect, useMemo, useState } from 'react'

import type { FlowDryRun, FlowFile } from '@harnessdesk/protocol'

import { Banner, Field, Input, Select } from '../design'
import { useStore } from '../state/context'
import styles from './FlowStart.module.css'

/**
 * Choosing a flow for a new room, and seeing what it would do before it does
 * it.
 *
 * The dry run is not a preview, it is the safety. A flow opens several agents
 * on somebody's repository and keeps them working, and the only honest moment
 * to show that is *before* the person presses the thing — so this surface is
 * the report, with Start underneath it rather than beside it: every seat,
 * what opening them costs and the fact that it is not what *running* them
 * costs, every command a check would run verbatim, and a trace of the loop.
 *
 * The cost line has been wrong once already and the correction is the lesson:
 * it said "4 requests", which reads as the price of the run and under-reported
 * it by an order of magnitude, because a seat lives inside one turn and keeps
 * thinking — 26 to 46 model round trips each, measured, for one fix and one
 * review round. A disclosure that can be misread as the total is not one.
 *
 * It runs against the flow's **text**, not its path, so what is checked is
 * what is about to run rather than what was last saved. A flow with an error
 * offers no Start at all: one that names a role that does not exist, or loops
 * with no way out, is what this feature exists to catch here rather than at
 * the fourth round.
 */

/** Nothing chosen. A room without a flow is the ordinary room, and the default. */
const NONE = ''

/** What the parent needs to start the flow once the room exists. */
export interface FlowChoice {
  readonly source: string
  readonly path: string
  readonly vars: Record<string, string>
}

export const FlowStart = ({
  root,
  disabled,
  onChange,
}: {
  readonly root: string
  readonly disabled?: boolean
  /**
   * What the room should be started with, or null for none.
   *
   * The parent owns the room: it is created first and the flow started into
   * it, so a flow that fails to seat leaves a room behind rather than nothing.
   */
  readonly onChange: (choice: FlowChoice | null) => void
}) => {
  const store = useStore()
  const [files, setFiles] = useState<readonly FlowFile[] | null>(null)
  const [path, setPath] = useState<string>(NONE)
  const [source, setSource] = useState<string>('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [report, setReport] = useState<FlowDryRun | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void store
      .listFlows(root)
      .then((found) => {
        if (live) setFiles(found)
      })
      .catch(() => {
        if (live) setFiles([])
      })
    return () => {
      live = false
    }
  }, [root, store])

  const choose = useCallback(
    async (next: string): Promise<void> => {
      setPath(next)
      setReport(null)
      setProblem(null)
      setVars({})
      if (next === NONE) {
        setSource('')
        onChange(null)
        return
      }
      try {
        const text = await store.readFlow(root, next)
        setSource(text)
        const dry = await store.dryRunFlow(root, text)
        setReport(dry)
        const filled = Object.fromEntries(
          (dry.flow?.inputs ?? []).map((input) => [input.id, input.default ?? '']),
        )
        setVars(filled)
        onChange(
          dry.problems.some((one) => one.level === 'error')
            ? null
            : { source: text, path: next, vars: filled },
        )
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'That flow could not be read.')
        onChange(null)
      }
    },
    [onChange, root, store],
  )

  const errors = useMemo(
    () => (report?.problems ?? []).filter((one) => one.level === 'error'),
    [report],
  )
  const warnings = useMemo(
    () => (report?.problems ?? []).filter((one) => one.level === 'warning'),
    [report],
  )

  const setVar = useCallback(
    (id: string, value: string): void => {
      const next = { ...vars, [id]: value }
      setVars(next)
      if (source !== '' && errors.length === 0) onChange({ source, path, vars: next })
    },
    [errors, onChange, path, source, vars],
  )

  if (files !== null && files.length === 0) {
    return (
      <p className={styles.empty}>
        No flows in this project yet. A flow is a file in <code>.harnessdesk/flows</code>, versioned with
        the code it governs.
      </p>
    )
  }

  return (
    <div className={styles.flow}>
      <Field
        label="Run a flow in it"
        hint="A flow declares who does what and what moves work between them, so a loop of agents runs without you routing every card."
      >
        {(control) => (
          <Select
            {...control}
            label="Flow"
            value={path}
            disabled={disabled || files === null}
            onChange={(next) => void choose(next)}
            options={[
              { value: NONE, label: files === null ? 'Looking…' : 'No flow — an ordinary room' },
              ...(files ?? []).map((file) => ({
                value: file.path,
                label: file.problem ? `${file.name} — will not run` : file.name,
              })),
            ]}
          />
        )}
      </Field>

      {problem && (
        <Banner tone="danger" title="That flow could not be read">
          {problem}
        </Banner>
      )}

      {errors.length > 0 && (
        <Banner tone="danger" title="This flow will not run yet">
          <ul className={styles.problems}>
            {errors.map((one) => (
              <li key={`${one.at}-${one.text}`}>
                <code>{one.at}</code> — {one.text}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {report?.flow && errors.length === 0 && (
        <>
          {report.flow.inputs.map((input) => (
            <Field key={input.id} label={input.label}>
              {(control) => (
                <Input
                  {...control}
                  value={vars[input.id] ?? ''}
                  onChange={(event) => setVar(input.id, event.target.value)}
                />
              )}
            </Field>
          ))}

          <section className={styles.report} aria-label="What this flow would do">
            <h4 className={styles.head}>
              {report.seats.length === 0
                ? 'It opens no agents'
                : `It opens ${report.seats.length} ${report.seats.length === 1 ? 'agent' : 'agents'}`}
              <span className={styles.cost}>
                {report.seatingTurns} {report.seatingTurns === 1 ? 'turn' : 'turns'} to seat
              </span>
            </h4>
            <ul className={styles.seats}>
              {report.seats.map((seat) => (
                <li key={`${seat.role}-${seat.index}`}>
                  <span className={styles.role}>{seat.role}</span>
                  <span className={styles.seat}>{seat.seat}</span>
                  <span className={styles.tag} data-permission={seat.permission}>
                    {seat.permission}
                  </span>
                </li>
              ))}
            </ul>

            {report.commands.length > 0 && (
              <>
                {/* Verbatim, and before anything runs one: a check is the only
                    thing a flow file makes happen on this machine, and a flow
                    arrives through a pull request like any other file. */}
                <h4 className={styles.head}>It runs these commands</h4>
                <ul className={styles.commands}>
                  {report.commands.map((command) => (
                    <li key={`${command.role}-${command.run}`}>
                      <span className={styles.role}>{command.role}</span>
                      <code>{command.run}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h4 className={styles.head}>How it would go</h4>
            <ol className={styles.trace}>
              {report.trace.map((step) => (
                <li key={step.n}>
                  <span className={styles.role}>{step.role}</span>
                  <span className={styles.count}>
                    {step.count === 1 ? '1 card' : `${step.count} cards`}
                  </span>
                  <span className={styles.answers}>{step.outcomes.join(', ')}</span>
                  <span className={styles.next}>{step.next ? `→ ${step.next}` : 'ends here'}</span>
                </li>
              ))}
            </ol>
            {report.seats.length > 0 && (
              /* The number above is the entry fee, not the price, and a cost
                 disclosure that lets that be misread is not one. A seat lives
                 inside its one turn and keeps thinking: measured on the first
                 live runs, 26 to 46 model round trips per seat for one fix
                 and one review round. */
              <p className={styles.note}>
                That is what opening them costs. Each seat then keeps working inside its one turn —
                one round trip per step, for as long as the flow runs — so on usage-based pricing the
                run costs more than the seating.
              </p>
            )}
            {!report.settled && report.trace.length > 0 && (
              <p className={styles.note}>
                Simulated {report.trace.length} rounds without reaching an end — against these answers
                it keeps going.
              </p>
            )}
          </section>

          {warnings.length > 0 && (
            <Banner tone="warning" title="Worth reading first">
              <ul className={styles.problems}>
                {warnings.map((one) => (
                  <li key={`${one.at}-${one.text}`}>
                    <code>{one.at}</code> — {one.text}
                  </li>
                ))}
              </ul>
            </Banner>
          )}
        </>
      )}
    </div>
  )
}
