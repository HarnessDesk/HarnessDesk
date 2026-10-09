import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { runtimeId, DEFAULT_FLOW_BUDGET, type AgentEntry, type FlowAgentRole, type FlowEntry, type FlowPolicy, type FlowPreview, type FlowPreviewSeat, type FlowProblem, type FlowRunOptions, type FlowSeat, type ModelInfo, type SeatCandidate } from '@harnessdesk/protocol'

import { ActionError, Banner, Button, Chip, CodeText, Field, Input, NativeSelect, Note, NoteList, Rows, Row, SectionHead, Segmented, Switch, Text, Textarea } from '../design'
import { agentName, firstReason, fixWords, markFor, reasonWords, seatTaken } from '../lib/agents'
import { boundInputValues } from '../lib/shapes'
import { evidenceGuardsWords, messagingWords } from '../lib/flows'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon } from './Icons'
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

/**
 * Whether a dry run may light Start: a token, no error, and the Agent
 * format — the only one that starts a new Goal. An old-format flow is never
 * startable here, whatever token a host hands it.
 */
const startable = (preview: FlowPreview): boolean =>
  preview.token !== null && preview.compiled.document.format === 'agents' &&
  !preview.problems.some((one) => one.level === 'error')

/** What the parent needs to start the flow, once it holds a live token. */
export interface FlowChoice extends FlowRunOptions {
  readonly source: string
  readonly token: string
  readonly vars: Readonly<Record<string, string>>
}

export interface FlowStartProps {
  readonly root: string
  readonly continues?: string
  readonly disabled?: boolean
  readonly onChange: (choice: FlowChoice | null) => void
  /** A Run's exact saved text and inputs, rather than the current catalogue file. */
  readonly initial?: { readonly source: string; readonly vars: Readonly<Record<string, string>> } & FlowRunOptions
  readonly team?: TeamFormProps
}

export const FlowStart = (props: FlowStartProps) => props.team ? <TeamForm {...props.team} /> : <FlowStartContents {...props} />

const FlowStartContents = ({ root, disabled, onChange, initial, continues }: FlowStartProps) => {
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
  const [seats, setSeats] = useState(initial?.seats)
  const defaultSeats = useRef(new Map<string, readonly (FlowSeat | undefined)[]>())
  const seatCandidates = useRef(new Map<string, readonly SeatCandidate[]>())
  const [preview, setPreview] = useState<FlowPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /* Bumped on every choice or edit, so a preview that lands after a newer one
     was already asked for is a stale reply rather than a late correction. */
  const sequence = useRef(0)
  // A pending import withholds even a valid preview for the previous text.
  // Keep the latest checked choice so a refused file can leave it intact.
  const briefReading = useRef(false)
  const checkedChoice = useRef<FlowChoice | null>(null)
  const reportChoice = useCallback((choice: FlowChoice | null): void => {
    checkedChoice.current = choice
    onChange(briefReading.current ? null : choice)
  }, [onChange])
  const readingBrief = useCallback((reading: boolean): void => {
    briefReading.current = reading
    onChange(reading ? null : checkedChoice.current)
  }, [onChange])

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
    async (text: string, nextVars: Readonly<Record<string, string>>, nextSeats = seats): Promise<void> => {
      const mine = ++sequence.current
      const generation = store.flowGeneration()
      reportChoice(null)
      setProblem(null)
      try {
        const options = initial ? { seats: nextSeats, attended: initial.attended, ...(continues ? { continues } : {}) } : undefined
        const dry = options ? await store.previewFlow(root, text, nextVars, options) : await store.previewFlow(root, text, nextVars)
        if (mine !== sequence.current || generation !== store.flowGeneration()) return
        if (initial) {
          for (const seat of dry.seats) {
            const key = JSON.stringify([seat.role, seat.index])
            const candidates = seatCandidates.current.get(key) ?? []
            // An explicit preference narrows the next plan to that candidate.
            // Keep the choices this form offered so the person can edit again.
            seatCandidates.current.set(key, [...candidates, ...seat.plan.candidates.filter(one => !candidates.some(previous => JSON.stringify(previous.seat) === JSON.stringify(one.seat)))])
            if (!defaultSeats.current.has(seat.role)) {
              const role = dry.compiled.document.format === 'agents' ? dry.compiled.document.flow.roles.find(one => one.id === seat.role) : undefined
              const slots = dry.seats.filter(one => one.role === seat.role).sort((a, b) => a.index - b.index)
              defaultSeats.current.set(seat.role, slots.map(one => {
                const declared = role?.kind === 'agent' ? role.seats[one.index] ?? role.seats[0] : undefined
                return declared ?? (one.plan.winner === null ? undefined : one.plan.candidates[one.plan.winner]?.seat)
              }))
            }
          }
        }
        setPreview(dry)
        if (startable(dry)) reportChoice({ source: text, token: dry.token!, vars: nextVars, ...options })
      } catch (error) {
        if (mine !== sequence.current) return
        setProblem(error instanceof Error ? error.message : 'That flow could not be checked.')
      }
    },
    [reportChoice, root, store, seats, initial, continues],
  )

  useEffect(() => {
    if (!initial) return
    defaultSeats.current.clear()
    seatCandidates.current.clear()
    setSeats(initial.seats)
    setPreview(null)
    setSource(initial.source)
    setVars(initial.vars)
    void runPreview(initial.source, initial.vars, initial.seats)
    return () => { sequence.current += 1; reportChoice(null) }
    // Only the saved Run's identity seeds the form; edits preview themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, root, store, continues])

  const choose = useCallback(
    async (next: string): Promise<void> => {
      sequence.current += 1
      briefReading.current = false
      setId(next)
      setPreview(null)
      setProblem(null)
      setVars({})
      reportChoice(null)
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
          if (startable(learn)) reportChoice({ source: text, token: learn.token!, vars: {} })
        } else {
          await runPreview(text, defaults)
        }
      } catch (error) {
        if (mine !== sequence.current) return
        setProblem(error instanceof Error ? error.message : 'That flow could not be read.')
      }
    },
    [reportChoice, root, runPreview, store],
  )

  const setVar = useCallback(
    (varId: string, value: string): void => {
      const next = { ...vars, [varId]: value }
      setVars(next)
      void runPreview(source, next)
    },
    [runPreview, source, vars],
  )

  if (!initial && unlisted !== null) {
    return (
      <Banner tone="danger" title="The flows in this project could not be read">
        {unlisted}
      </Banner>
    )
  }

  if (!initial && entries !== null && entries.length === 0) {
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
  // An early host refusal carries an empty legacy document, not a parsed old-format Flow.
  const legacy = document?.format === 'legacy' && document.flow.name !== ''
  const flow = document?.format === 'agents' ? document.flow : null

  return (
    <div className={styles.flow}>
      {!initial && <Field
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
            <option value={NONE}>{entries === null ? 'Looking…' : 'No fixed steps — just a Team'}</option>
            {(entries ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.problem ? `${entry.name} — will not run` : entry.name}</option>
            ))}
          </NativeSelect>
        )}
      </Field>}
      {initial && (document?.flow.name || !preview) && <Text role="subject">{document?.flow.name || 'Reading the earlier Run’s Flow…'}</Text>}

      {problem && <ActionError>That flow could not be read. {problem}</ActionError>}

      {legacy && (
        <Banner tone="warning" title="This flow uses the old format">
          Update it from the project’s Flows list before it can start a Team here. The update shows every file
          it would write before it writes any.
        </Banner>
      )}

      {errors.length > 0 && !legacy && (
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

      <FlowInputFields flow={flow} scope={`${root}:${id}`} vars={vars} disabled={disabled} onChange={setVar} onReadingChange={readingBrief} />

      {initial && preview?.seats.map(seat => {
        const slots = preview.seats.filter(one => one.role === seat.role).sort((a, b) => a.index - b.index)
        const defaults = defaultSeats.current.get(seat.role) ?? []
        const candidates = seatCandidates.current.get(JSON.stringify([seat.role, seat.index])) ?? seat.plan.candidates
        const selected = seats?.[seat.role]?.[seat.index] ?? seats?.[seat.role]?.[0]
        return <Field key={`${seat.role}-${seat.index}`} label={`${seat.role}${slots.length > 1 ? ` · Seat ${seat.index + 1}` : ''} · Seat preference`}>
        {control => <NativeSelect {...control} disabled={disabled} value={selected ? JSON.stringify(selected) : ''}
          onChange={event => {
            const candidate = candidates.find(one => JSON.stringify(one.seat) === event.target.value)
            const next = { ...seats }
            const choices = slots.map(one => seats?.[seat.role]?.[one.index] ?? seats?.[seat.role]?.[0] ?? defaults[one.index])
            choices[seat.index] = candidate?.seat ?? defaults[seat.index]
            if (!choices.every((one): one is FlowSeat => one !== undefined)) return
            if (JSON.stringify(choices) === JSON.stringify(defaults)) delete next[seat.role]
            else next[seat.role] = choices
            setSeats(next)
            void runPreview(source, vars, next)
          }}>
          <option value="">Flow’s seat choices</option>
          {candidates.map((candidate, index) => <option key={index} value={JSON.stringify(candidate.seat)}>{candidate.label}</option>)}
        </NativeSelect>}
      </Field>})}

      {preview && flow && !legacy && <FlowPreviewReport preview={preview} flow={flow} warnings={warnings} roster={roster} vars={vars} />}
    </div>
  )
}

/** The declared inputs, shared by the full start form and its compact excerpt. */
export const FlowInputFields = ({ flow, scope, vars, disabled, onChange, onReadingChange }: {
  readonly flow: FlowPolicy | null
  readonly scope: string
  readonly vars: Readonly<Record<string, string>>
  readonly disabled?: boolean
  readonly onChange: (id: string, value: string) => void
  readonly onReadingChange: (reading: boolean) => void
}) => <>{flow?.inputs.map(input => input.id === 'brief' ? (
  <BriefInput key={`${scope}:brief`} value={vars.brief ?? ''} disabled={disabled} onChange={value => onChange('brief', value)} onReadingChange={onReadingChange} />
) : (
  <Field key={input.id} label={input.label}>
    {control => <Input {...control} disabled={disabled} value={vars[input.id] ?? ''} onChange={event => onChange(input.id, event.target.value)} />}
  </Field>
))}</>

/** Files are imported into the variable, never attached to the Run. */
const BRIEF_FILE_CAP = 64 * 1024
const BriefInput = ({ value, disabled, onChange, onReadingChange }: {
  readonly value: string
  readonly disabled?: boolean
  readonly onChange: (value: string) => void
  readonly onReadingChange: (reading: boolean) => void
}) => {
  const picker = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)
  // Other inputs can change while a file is read; use their latest vars.
  const change = useRef(onChange)
  change.current = onChange
  const readingChange = useRef(onReadingChange)
  readingChange.current = onReadingChange
  const [reading, setReading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    sequence.current += 1
    setReading(false)
    readingChange.current(false)
    return () => { sequence.current += 1 }
  }, [disabled])

  const read = async (file: File): Promise<void> => {
    const mine = ++sequence.current
    setProblem(null)
    if (file.size > BRIEF_FILE_CAP) {
      setProblem('Choose a text file no larger than 64 KiB (65,536 bytes).')
      return
    }
    if (!file.type.startsWith('text/') && !/\.(txt|md|markdown)$/i.test(file.name)) {
      setProblem('Choose a text file (.txt or .md).')
      return
    }
    setReading(true)
    onReadingChange(true)
    try {
      const text = await file.text()
      if (mine !== sequence.current) return
      if (text.includes('\0')) {
        setProblem('Choose a text file (.txt or .md).')
        return
      }
      change.current(text)
    } catch {
      if (mine === sequence.current) setProblem('That text file could not be read. Try another file.')
    } finally {
      if (mine === sequence.current) {
        setReading(false)
        onReadingChange(false)
      }
    }
  }

  return (
    <Field label="Brief" error={problem ?? undefined}>
      {(control) => (
        <>
          <Textarea
            {...control}
            rows={4}
            controlSize="paragraphs"
            value={value}
            disabled={disabled}
            onChange={(event) => {
              sequence.current += 1
              setReading(false)
              setProblem(null)
              onChange(event.target.value)
              onReadingChange(false)
            }}
          />
          <div>
            <Button variant="secondary" size="sm" disabled={disabled || reading} onClick={() => picker.current?.click()}>
              {reading ? 'Reading…' : 'Attach a file…'}
            </Button>
            <Input ref={picker} type="file" accept="text/*,.txt,.md,.markdown" hidden disabled={disabled || reading} onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void read(file)
            }} />
          </div>
        </>
      )}
    </Field>
  )
}

/** The report's complete Seat section, including Agent identities and candidates. */
export const FlowPreviewSeats = ({ preview, roster }: {
  readonly preview: FlowPreview
  readonly roster: ReadonlyMap<string, AgentEntry>
}) => (
  <section aria-label="Seats this would open">
    <SectionHead name={preview.seats.length === 0 ? 'It opens no Agents' : `It opens ${preview.seats.length} ${preview.seats.length === 1 ? 'seat' : 'seats'}`} />
    <Rows>
      {preview.seats.length === 0 && <Row title="This flow names no Agent role" />}
      {preview.seats.map(seat => <SeatPreviewRows key={`${seat.role}-${seat.index}`} seat={seat} roster={roster} />)}
    </Rows>
  </section>
)

/**
 * The dry run's own report — every seat, every command verbatim, every
 * round and guard, the messaging disclosure and the cost note — shared by
 * `FlowStart` and `RaceStart` so a race's dry run reads exactly like every
 * other flow's rather than a second, narrower rendering of the same data.
 */
const seedTitleOf = (flow: FlowPolicy, vars: Readonly<Record<string, string>>): string =>
  // Like a Run's card title, substitute once: input text may itself contain braces.
  flow.seed.title.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_slot, name: string) =>
    vars[name]?.trim() ? vars[name]! : flow.inputs.find(input => input.id === name)?.label ?? name)

export const FlowPreviewReport = ({
  preview, flow, warnings, roster, vars = {},
}: {
  readonly preview: FlowPreview
  readonly flow: FlowPolicy | null
  readonly warnings: readonly FlowProblem[]
  readonly vars?: Readonly<Record<string, string>>
  readonly roster: ReadonlyMap<string, AgentEntry>
}) => (
  <>
    <FlowPreviewSeats preview={preview} roster={roster} />

    {preview.commands.length > 0 && (
      <section aria-label="Commands it runs">
        <SectionHead name="It runs these commands" />
        <Rows>
          {preview.commands.map((command) => (
            <Row
              key={`${command.role}-${command.run}`}
              title={command.role}
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
          <Row title={flow.seed.role} desc={`Seed round — ${seedTitleOf(flow, vars)}`} />
          {flow.rules.map((rule) => {
            const guard = preview.guards.find((one) => one.rule === rule.id)
            // A guard's requirement is a sentence, not a value — it belongs
            // beside the round's own title, in the wrapped description, never
            // squeezed into the fixed value column next to it.
            const requires = guard?.requires.length ? evidenceGuardsWords(guard.requires) : null
            return (
              <Row
                key={rule.id}
                title={`${rule.on} → ${rule.then.role}`}
                desc={requires ? `${rule.then.title} — ${requires}` : rule.then.title}
                control={guard?.unevidenced ? <Chip tone="warning">Unevidenced</Chip> : undefined}
              />
            )
          })}
        </Rows>
      </section>
    )}

    <Note>{messagingWords(preview.messaging)}</Note>

    {preview.seats.some((one) => one.reviews) && (() => {
      const budget = flow?.budget ?? DEFAULT_FLOW_BUDGET
      return (
        <Note>
          {`Reviews stop for a person after ${budget.rounds} round${budget.rounds === 1 ? '' : 's'}, or ${budget.withoutProgress} in a row with no new evidence. While a review round is open, its reviewers cannot message or post — not each other, not the board, not the pull request — until every reviewer has finished and the round closes together.`}
        </Note>
      )
    })()}

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
        mark={winner ? <RuntimeMark runtime={markFor(winner, snapshot.runtimes)} size={16} /> : <AgentIcon size={16} />}
        title={
          <>
            {`${name} — ${seat.role}${seat.isolate ? ', isolated' : ''}`}
            {/* A worktree the file never asked for (#1053): a state, so a chip on the label's own line; the sentence is its hover. */}
            {seat.atPredecessor && !seat.isolate && (
              <>
                {' '}
                <Chip
                  tone="neutral"
                  size="sm"
                  title={seat.atPredecessor === 'may'
                    ? "May open in a worktree of its own, at the commit it is handed, depending on which rule opens it"
                    : "Opens in a worktree of its own, at the commit it is handed"}
                >{seat.atPredecessor === 'may' ? 'Sometimes own worktree' : 'Own worktree'}</Chip>
              </>
            )}
          </>
        }
        desc={reason ?? undefined}
        control={seat.plan.ceiling ? <CeilingChip ceiling={seat.plan.ceiling} /> : <Text role="meta">Unavailable</Text>}
      />
      {seat.plan.candidates.map((candidate, index) => {
        const words = candidate.state === 'passed' && candidate.reason
          ? [
              reasonWords(candidate.reason, candidate.runtimeName),
              ...(candidate.alsoPassed ?? []).map((reason) => reasonWords(reason, candidate.runtimeName)),
              candidate.fix ? fixWords(candidate.fix, candidate.runtimeName) : null,
            ]
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
            desc={words ?? undefined}
          />
        )
      })}
    </>
  )
}

interface TeamFormProps {
  readonly flow: FlowPolicy
  readonly template: FlowPolicy
  readonly preview: FlowPreview
  readonly roster: ReadonlyMap<string, AgentEntry>
  readonly vars: Readonly<Record<string, string>>
  readonly primary?: string
  readonly disabled?: boolean
  readonly editingDisabled?: boolean
  readonly done?: ReactNode
  readonly details?: ReactNode
  readonly onVar: (id: string, value: string) => void
  readonly onReadingChange: (reading: boolean) => void
  readonly onPolicy: (flow: FlowPolicy) => void
}

/** The compact start form composes the same input and dry-run contracts as a saved Run. */
const TeamForm = ({ flow, template, preview, roster, vars, primary, disabled, editingDisabled, done, details, onVar, onReadingChange, onPolicy }: TeamFormProps) => {
  const snapshot = useSnapshot()
  const hasReviewLoop = flow.rules.some(rule => rule.on === 'reviewer' && rule.then.role === flow.seed.role)
  const mergeRules = template.rules.filter(rule => rule.then.role === 'referee')
  const hasReviewOptions = hasReviewLoop && !template.roles.some(role => role.kind === 'check') && mergeRules.length > 0 && mergeRules.every(rule => rule.on === 'reviewer')
  const hasJudge = template.roles.some(role => role.id === 'judge') && template.roles.some(role => role.id === 'competitor')
  const judgeOn = flow.roles.some(role => role.id === 'judge')
  const editRole = (role: FlowAgentRole): void => onPolicy({ ...flow, roles: flow.roles.map(one => one.id === role.id ? role : one) })
  return <div className={styles.flow}>
    <section aria-label="Who does what">
      <SectionHead name="Who does what" />
      <Rows>{preview.seats.map(seat => {
        const role = flow.roles.find(one => one.id === seat.role)
        if (role?.kind !== 'agent') return null
        const slots = preview.seats.filter(one => one.role === role.id).sort((a, b) => a.index - b.index)
        const picked = role.seats[seat.index] ?? role.seats[0] ?? seatTaken(seat.plan)?.seat
        const label = role.id === flow.seed.role && hasReviewLoop ? 'Writes' : role.id === 'reviewer' ? 'Reviews' : role.id === 'competitor' ? `Attempt ${String.fromCharCode(65 + seat.index)}` : role.id === 'judge' ? 'Judge' : role.id
        const repeatsInReviewLoop = seat.reviews && flow.rules.some(rule => rule.on === seat.role && rule.then.role === flow.seed.role)
        return <Row key={`${role.id}-${seat.index}`} title={<span className={styles.roleTitle}>{label}{repeatsInReviewLoop && <Chip tone="neutral" size="sm">Fresh each round</Chip>}</span>} desc={!seatTaken(seat.plan) ? firstReason(seat.plan) ?? undefined : undefined}
          mark={picked ? <RuntimeMark runtime={snapshot.runtimes.find(one => one.id === picked.runtime) ?? { id: picked.runtime, presentation: { name: 'Selected agent' } }} size={16} /> : <AgentIcon size={16} />}
          control={<div className={styles.roleControls}>
            <TeamSeatControls label={label} seat={picked} disabled={disabled} onChange={next => {
              const seats = slots.map(one => one.index === seat.index ? next : role.seats[one.index] ?? role.seats[0] ?? seatTaken(one.plan)?.seat)
              if (seats.every((one): one is FlowSeat => one !== undefined)) editRole({ ...role, seats })
            }} />
          </div>} />
      })}</Rows>
    </section>
    {hasReviewOptions && <div className={styles.options}>
      <Field label="Review rounds, at most">{() => <Segmented label="Review rounds, at most" value={String(Math.max(1, Math.min(3, Math.floor(((flow.budget?.rounds ?? 7) - 1) / 2))))} options={['1', '2', '3'].map(value => ({ value, label: value, disabled }))} onChange={value => onPolicy({ ...flow, budget: { rounds: Number(value) * 2 + 1, withoutProgress: flow.budget?.withoutProgress ?? 2 } })} />}</Field>
      <Field label="When the review approves">{() => <Segmented label="When the review approves" value={flow.roles.find(one => one.id === 'referee')?.kind === 'agent' ? 'merge' : 'wait'} options={[{ value: 'merge', label: 'Merge it', disabled }, { value: 'wait', label: 'Wait for me', disabled }]} onChange={value => onPolicy({ ...flow,
        roles: flow.roles.map(one => one.id !== 'referee' ? one : value === 'merge'
          ? { id: 'referee', kind: 'agent', uses: ['merger'], seats: [], isolate: false, grant: 'merge', independentOf: [] }
          : { id: 'referee', kind: 'person', outcomes: ['merged', 'dropped'] }),
        rules: flow.rules.map(rule => rule.then.role !== 'referee' ? rule : { ...rule, when: value === 'merge' ? { evidence: [{ review: 'approve' }, { pr: 'open' }] } : { every: ['approve'], evidence: [{ review: 'approve' }] }, then: { ...rule.then, title: value === 'merge' ? 'Merge the reviewed pull request' : 'Merge it — the reviewer approved', detail: value === 'merge' ? 'Merge only the approved revision after its required checks pass.' : 'Merging is yours; no agent in this Team may do it.' } }),
      })} />}</Field>
    </div>}
    {hasJudge && <Rows><Row title="A judge picks the better one" control={<Switch aria-label="A judge picks the better one" checked={judgeOn} disabled={disabled} onCheckedChange={on => onPolicy({ ...flow,
      roles: on ? [...flow.roles, ...template.roles.filter(role => role.id === 'judge')] : flow.roles.filter(role => role.id !== 'judge'),
      rules: on ? [...flow.rules.filter(rule => rule.id !== 'to-person'), ...template.rules.filter(rule => rule.on === 'judge' || rule.then.role === 'judge')]
        : [...flow.rules.filter(rule => rule.on !== 'judge' && rule.then.role !== 'judge'), { id: 'to-person', on: 'verify', when: { any: ['pass'] }, then: { role: 'referee', title: 'Choose and merge an attempt' } }],
    })} />} /></Rows>}
    {flow.roles.filter(role => role.kind === 'check').map(role => role.kind === 'check' && <Field key={role.id} label={hasJudge ? 'Check each attempt with' : `Check · ${role.id}`}>{control => <Input {...control} disabled={editingDisabled} value={role.check.run} onChange={event => onPolicy({ ...flow, roles: flow.roles.map(one => one.id === role.id ? { ...role, check: { ...role.check, run: event.target.value } } : one) })} />}</Field>)}
    {done}
    <details className={styles.details}><summary><Text as="span" role="muted">Details</Text></summary><div className={styles.flow}>
      {details}
      <Rows>{preview.seats.map(seat => {
        const role = flow.roles.find(one => one.id === seat.role)
        if (role?.kind !== 'agent') return null
        const slots = preview.seats.filter(one => one.role === role.id).sort((a, b) => a.index - b.index)
        return <Row key={`${role.id}-${seat.index}`} title={`Instructions · ${role.id}${slots.length > 1 ? ` ${seat.index + 1}` : ''}`} control={<NativeSelect aria-label={`Instructions for ${role.id} ${seat.index + 1}`} disabled={disabled} value={seat.agent ?? ''} onChange={event => {
          editRole({ ...role, uses: slots.map(one => one.index === seat.index ? event.target.value : one.agent ?? role.uses[0] ?? ''), count: undefined })
        }}>
          {seat.agent && !roster.has(seat.agent) && <option value={seat.agent}>{seat.agent}</option>}
          {[...roster.values()].filter(one => one.definition).map(one => <option key={one.id} value={one.id}>{agentName(one)}</option>)}
        </NativeSelect>} />
      })}</Rows>
      <FlowInputFields flow={{ ...flow, inputs: flow.inputs.filter(input => input.id !== primary && !boundInputValues(flow).has(input.id)) }} scope="team-start" vars={vars} disabled={disabled} onChange={onVar} onReadingChange={onReadingChange} />
      <FlowPreviewReport preview={preview} flow={flow} warnings={preview.problems.filter(one => one.level === 'warning')} roster={roster} vars={vars} />
    </div></details>
  </div>
}

const TeamSeatControls = ({ label, seat, disabled, onChange }: { readonly label: string; readonly seat?: FlowSeat; readonly disabled?: boolean; readonly onChange: (seat: FlowSeat) => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [models, setModels] = useState<readonly ModelInfo[]>([])
  useEffect(() => {
    let live = true
    setModels([])
    if (seat) void store.modelsFor(runtimeId(seat.runtime)).then(found => { if (live) setModels(found) }, () => { if (live) setModels([]) })
    return () => { live = false }
  }, [seat?.runtime, store])
  const model = models.find(one => one.id === seat?.model) ?? models.find(one => one.isDefault)
  const selectedRuntime = snapshot.runtimes.find(one => one.id === seat?.runtime)
  return <>
    <NativeSelect className={styles.agentSelect} aria-label={`Agent for ${label}`} title={selectedRuntime?.presentation.name} disabled={disabled} value={seat?.runtime ?? ''} onChange={event => onChange({ runtime: event.target.value })}>
      {!seat && <option value="">Automatic</option>}
      {seat && !snapshot.runtimes.some(one => one.id === seat.runtime) && <option value={seat.runtime}>Selected agent</option>}
      {snapshot.runtimes.map(one => <option key={one.id} value={one.id}>{one.presentation.name}</option>)}
    </NativeSelect>
    <NativeSelect aria-label={`Model for ${label}`} disabled={disabled || !seat} value={seat?.model ?? ''} onChange={event => seat && onChange({ ...seat, model: event.target.value || undefined, effort: undefined })}>
      <option value="">Default model</option>
      {seat?.model && !models.some(one => one.id === seat.model) && <option value={seat.model}>{seat.model}</option>}
      {models.filter(one => !one.hidden).map(one => <option key={one.id} value={one.id}>{one.displayName}</option>)}
    </NativeSelect>
    <NativeSelect aria-label={`Effort for ${label}`} disabled={disabled || !seat || !model?.reasoningLevels.length} value={seat?.effort ?? ''} onChange={event => seat && onChange({ ...seat, effort: event.target.value || undefined })}>
      <option value="">Default effort</option>
      {seat?.effort && !model?.reasoningLevels.some(one => one.id === seat.effort) && <option value={seat.effort}>{seat.effort}</option>}
      {model?.reasoningLevels.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
    </NativeSelect>
  </>
}
