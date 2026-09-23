import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentEntry, FlowEntry, FlowPolicy, FlowPreview, FlowPreviewSeat, FlowProblem } from '@harnessdesk/protocol'

import { ActionError, Banner, Chip, CodeText, Field, Input, NativeSelect, Note, NoteList, Rows, Row, RowValue, SectionHead, Text } from '../design'
import { agentName, firstReason, fixWords, markFor, reasonWords, seatTaken } from '../lib/agents'
import { evidenceGuardsWords, messagingWords } from '../lib/flows'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { BriefIcon } from './Icons'
import { CeilingChip } from './CeilingChip'
import styles from './FlowStart.module.css'

/**
 * Choosing a flow for a new Goal, and seeing what it would do before it does
 * it.
 *
 * The dry run is not a preview, it is the safety. It runs against the flow's
 * **text**, freshly read, not a cached read of it: what is checked is what
 * is about to run. Its token is a receipt for exactly this text, these
 * variables, this Agent roster and this machine's seating — an edit to any
 * of them invalidates it immediately, `onChange(null)`, before the next
 * preview has even landed, so Start can never fire on stale seating.
 */

const NONE = ''

/** What the parent needs to start the flow, once it holds a live token. */
export interface FlowChoice {
  readonly source: string
  readonly token: string
  readonly vars: Readonly<Record<string, string>>
}

export interface FlowStartProps {
  readonly root: string
  readonly disabled?: boolean
  readonly onChange: (choice: FlowChoice | null) => void
}

export const FlowStart = ({ root, disabled, onChange }: FlowStartProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [entries, setEntries] = useState<readonly FlowEntry[] | null>(null)
  /* Why the project's flows could not be listed, when they could not — kept
     apart from `entries`, because an empty list is a claim (this project has
     none) and a folder the host was refused has not made one. */
  const [unlisted, setUnlisted] = useState<string | null>(null)
  const [roster, setRoster] = useState<ReadonlyMap<string, AgentEntry>>(new Map())
  const [id, setId] = useState<string>(NONE)
  const [source, setSource] = useState<string>('')
  const [vars, setVars] = useState<Readonly<Record<string, string>>>({})
  const [preview, setPreview] = useState<FlowPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /* Bumped on every choice or edit, so a preview that lands after a newer one
     was already asked for is a stale reply rather than a late correction. */
  const sequence = useRef(0)

  useEffect(() => {
    let live = true
    void store.flowCatalog(root).then(
      (found) => {
        if (live) {
          setUnlisted(null)
          setEntries(found)
        }
      },
      (error: unknown) => {
        if (live) setUnlisted(error instanceof Error ? error.message : String(error))
      },
    )
    void store.agentsIn(root).then(
      (list) => {
        if (live) setRoster(new Map(list.map((entry) => [entry.id, entry])))
      },
      () => {
        // A roster this call could not read leaves names as bare ids, below.
      },
    )
    return () => {
      live = false
    }
  }, [root, store])

  const runPreview = useCallback(
    async (text: string, nextVars: Readonly<Record<string, string>>): Promise<void> => {
      const mine = ++sequence.current
      const generation = store.flowGeneration()
      onChange(null)
      try {
        const dry = await store.previewFlow(root, text, nextVars)
        if (mine !== sequence.current || generation !== store.flowGeneration()) return
        setPreview(dry)
        const errors = dry.problems.filter((one) => one.level === 'error')
        if (dry.token && errors.length === 0) onChange({ source: text, token: dry.token, vars: nextVars })
      } catch (error) {
        if (mine !== sequence.current) return
        setProblem(error instanceof Error ? error.message : 'That flow could not be checked.')
      }
    },
    [onChange, root, store],
  )

  const choose = useCallback(
    async (next: string): Promise<void> => {
      sequence.current += 1
      setId(next)
      setPreview(null)
      setProblem(null)
      setVars({})
      onChange(null)
      if (next === NONE) {
        setSource('')
        return
      }
      const mine = sequence.current
      const generation = store.flowGeneration()
      try {
        const text = await store.flowSource(root, next)
        if (mine !== sequence.current || generation !== store.flowGeneration()) return
        setSource(text)
        // A first, throwaway preview with no variables filled — only to learn
        // what this flow asks for, so their defaults can be previewed for
        // real: the token binds exact variables, and defaults are not "no
        // variables".
        const learn = await store.previewFlow(root, text, {})
        if (mine !== sequence.current || generation !== store.flowGeneration()) return
        const inputs = learn.compiled.document.format === 'agents' ? learn.compiled.document.flow.inputs : []
        const defaults = Object.fromEntries(inputs.map((input) => [input.id, input.default ?? '']))
        setVars(defaults)
        if (inputs.length === 0) {
          setPreview(learn)
          const errors = learn.problems.filter((one) => one.level === 'error')
          if (learn.token && errors.length === 0) onChange({ source: text, token: learn.token, vars: {} })
        } else {
          await runPreview(text, defaults)
        }
      } catch (error) {
        if (mine !== sequence.current) return
        setProblem(error instanceof Error ? error.message : 'That flow could not be read.')
      }
    },
    [onChange, root, runPreview, store],
  )

  const setVar = useCallback(
    (varId: string, value: string): void => {
      const next = { ...vars, [varId]: value }
      setVars(next)
      void runPreview(source, next)
    },
    [runPreview, source, vars],
  )

  if (unlisted !== null) {
    return (
      <Banner tone="danger" title="The flows in this project could not be read">
        {unlisted}
      </Banner>
    )
  }

  if (entries !== null && entries.length === 0) {
    return (
      <Note>
        No flows of its own. A flow is a file in <code>.harnessdesk/flows</code>, versioned with the code it
        governs — start from one that ships, or one of yours, with Customize…
      </Note>
    )
  }

  const errors = (preview?.problems ?? []).filter((one) => one.level === 'error')
  const warnings = (preview?.problems ?? []).filter((one) => one.level === 'warning')
  const document = preview?.compiled.document ?? null
  const legacy = document?.format === 'legacy'
  const flow = document?.format === 'agents' ? document.flow : null

  return (
    <div className={styles.flow}>
      <Field
        label="Run a flow in it"
        hint="A flow declares who does what and what moves work between them, so a loop of agents runs without you routing every card."
      >
        {(control) => (
          <NativeSelect
            {...control}
            aria-label="Flow"
            value={id}
            disabled={disabled || entries === null}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value={NONE}>{entries === null ? 'Looking…' : 'No flow — an ordinary Goal'}</option>
            {(entries ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.problem ? `${entry.name} — will not run` : entry.name}</option>
            ))}
          </NativeSelect>
        )}
      </Field>

      {problem && <ActionError>That flow could not be read. {problem}</ActionError>}

      {legacy && (
        <Banner tone="warning" title="This flow uses the old format">
          It runs with its original answer routing and permissions. Update it from the project’s Flows list to
          see its Agents and commands here.
        </Banner>
      )}

      {errors.length > 0 && (
        <Banner tone="danger" title="This flow will not run yet">
          <NoteList>
            {errors.map((one) => (
              <li key={`${one.at}-${one.text}`}>
                <code>{one.at}</code> — {one.text}
              </li>
            ))}
          </NoteList>
        </Banner>
      )}

      {flow && flow.inputs.map((input) => (
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

      {preview && !legacy && <FlowPreviewReport preview={preview} flow={flow} warnings={warnings} roster={roster} />}
    </div>
  )
}

/**
 * The dry run's own report — every seat, every command verbatim, every
 * round and guard, the messaging disclosure and the cost note — shared by
 * `FlowStart` and `RaceStart` so a race's dry run reads exactly like every
 * other flow's rather than a second, narrower rendering of the same data.
 */
export const FlowPreviewReport = ({
  preview, flow, warnings, roster,
}: {
  readonly preview: FlowPreview
  readonly flow: FlowPolicy | null
  readonly warnings: readonly FlowProblem[]
  readonly roster: ReadonlyMap<string, AgentEntry>
}) => (
  <>
    <section aria-label="Seats this would open">
      <SectionHead name={preview.seats.length === 0 ? 'It opens no Agents' : `It opens ${preview.seats.length} ${preview.seats.length === 1 ? 'seat' : 'seats'}`} />
      <Rows>
        {preview.seats.length === 0 && <Row title="This flow names no Agent role" />}
        {preview.seats.map((seat) => <SeatPreviewRows key={`${seat.role}-${seat.index}`} seat={seat} roster={roster} />)}
      </Rows>
    </section>

    {preview.commands.length > 0 && (
      <section aria-label="Commands it runs">
        <SectionHead name="It runs these commands" />
        <Rows>
          {preview.commands.map((command) => (
            <Row
              key={`${command.role}-${command.run}`}
              title={command.role}
              wrapDesc
              desc={<CodeText as="code">{`${command.run} — in ${command.cwd}, ${command.timeout}s`}</CodeText>}
            />
          ))}
        </Rows>
      </section>
    )}

    {flow && flow.rules.length > 0 && (
      <section aria-label="Rounds and rules">
        <SectionHead name="Its rounds" />
        <Rows>
          <Row title={flow.seed.role} desc={`Seed round — ${flow.seed.title}`} />
          {flow.rules.map((rule) => {
            const guard = preview.guards.find((one) => one.rule === rule.id)
            return (
              <Row
                key={rule.id}
                title={`${rule.on} → ${rule.then.role}`}
                wrapDesc
                desc={rule.then.title}
                control={guard?.requires.length
                  ? <RowValue>{evidenceGuardsWords(guard.requires)}</RowValue>
                  : guard?.unevidenced
                    ? <Chip tone="warning">Unevidenced</Chip>
                    : undefined}
              />
            )
          })}
        </Rows>
      </section>
    )}

    <Note>{messagingWords(preview.messaging)}</Note>

    {preview.seats.length > 0 && (
      <Note tone="warn">
        That is what opening them costs. Each seat then keeps working inside its one turn — one round trip
        per step, for as long as the flow runs — so on usage-based pricing the run costs more than the
        seating.
      </Note>
    )}

    {warnings.length > 0 && (
      <Banner tone="warning" title="Worth reading first">
        <NoteList>
          {warnings.map((one) => (
            <li key={`${one.at}-${one.text}`}>
              <code>{one.at}</code> — {one.text}
            </li>
          ))}
        </NoteList>
      </Banner>
    )}
  </>
)

/** One role's slot: the Agent it names, its effective ceiling, and every candidate this machine tried. */
const SeatPreviewRows = ({ seat, roster }: { readonly seat: FlowPreviewSeat; readonly roster: ReadonlyMap<string, AgentEntry> }) => {
  const snapshot = useSnapshot()
  const agent = seat.agent ? roster.get(seat.agent) : undefined
  const name = agent ? agentName(agent) : seat.agent ?? 'No Agent'
  const winner = seatTaken(seat.plan)
  const reason = !winner ? firstReason(seat.plan) : null
  return (
    <>
      <Row
        mark={winner ? <RuntimeMark runtime={markFor(winner, snapshot.runtimes)} size={16} /> : <BriefIcon size={16} />}
        title={`${name} — ${seat.role}${seat.isolate ? ', isolated' : ''}`}
        wrapDesc
        desc={reason ?? undefined}
        control={seat.plan.ceiling ? <CeilingChip ceiling={seat.plan.ceiling} /> : <Text role="meta">Unavailable</Text>}
      />
      {seat.plan.candidates.map((candidate, index) => {
        const words = candidate.state === 'passed' && candidate.reason
          ? [reasonWords(candidate.reason, candidate.runtimeName), candidate.fix ? fixWords(candidate.fix, candidate.runtimeName) : null]
            .filter((part): part is string => part !== null)
            .join(' — ')
          : candidate.state === 'taken'
            ? 'Picked'
            : null
        return (
          <Row
            key={`${index}-${candidate.label}`}
            mark={<RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={14} />}
            title={candidate.label}
            wrapDesc
            desc={words ?? undefined}
          />
        )
      })}
    </>
  )
}
