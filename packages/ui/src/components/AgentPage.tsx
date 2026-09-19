import { useEffect, useRef, useState } from 'react'

import {
  SEAT_PREFERENCE_LIMIT,
  type AgentEntry,
  type FlowSeat,
  type ModelInfo,
  type RuntimeId,
  type SeatCandidate,
  type SeatFix,
} from '@harnessdesk/protocol'

import {
  agentName,
  ceilingMeaning,
  ceilingWords,
  copyTargets,
  fileWords,
  firstParagraph,
  fixWords,
  isAgentFolder,
  markFor,
  originWords,
  projectName,
  sameSeat,
  shadowWords,
  stateWords,
  wordList,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { BriefIcon, CrossIcon, MoveDownIcon, MoveUpIcon, PlusIcon } from './Icons'
import {
  BackLink,
  Button,
  Checkbox,
  CodeText,
  ConfirmDialog,
  DetailHead,
  DetailMark,
  Dialog,
  Field,
  FormStack,
  NativeSelect,
  Note,
  Row,
  RowChoice,
  RowValue,
  Rows,
  SectionHead,
  Switch,
} from '../design'
import styles from './AgentPage.module.css'

/**
 * An Agent's page — a drill from the roster, not a dialog.
 *
 * Everything the roster row summarises, in full: the file it comes from, its
 * ceiling, the seats it asks for and their state on this Mac, what it answers
 * and produces, and the opening of its brief — with the three things a person
 * does to an Agent: start a conversation as it, copy it somewhere it comes
 * first, and move it to the Trash. Nothing here is edited in place; the file
 * is the truth, and *Open in editor* is where it changes.
 *
 * A page for something that is not really an Agent's own folder — a
 * project's unreadable `.harnessdesk/agents` directory, listed as one entry
 * so the reason is not silence (Task 9's `unreadDirectory`) — offers none of
 * the file actions: there is no folder by that name to open, reveal, copy or
 * remove, and the page must not lean on the host's own refusal to find that
 * out (`isAgentFolder`).
 */
export const AgentPage = ({
  entry,
  onBack,
  onLeave,
}: {
  readonly entry: AgentEntry
  readonly onBack: () => void
  /** Closes the Agents window: what is opened from here — the file, a conversation — is behind it. */
  readonly onLeave: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [customizing, setCustomizing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [seatingBusy, setSeatingBusy] = useState(false)
  const [seatingProblem, setSeatingProblem] = useState<string | null>(null)
  const seatingInFlight = useRef(false)
  const definition = entry.definition
  const name = agentName(entry)
  const project = projectName(snapshot.workspace)
  const folder = isAgentFolder(entry)
  const targets = definition && folder ? copyTargets(entry.origin, snapshot.workspace !== null) : []
  const errors = entry.problems.filter((one) => one.level === 'error')
  const warnings = entry.problems.filter((one) => one.level === 'warning')
  const shadows = shadowWords(entry)
  const plan = snapshot.agentPlans.get(entry.id)

  const openFile = (): void => {
    store.openFile(entry.path)
    onLeave()
  }

  const setMachineSeats = async (
    seats: readonly FlowSeat[] | null,
    expected: readonly FlowSeat[] | null,
  ): Promise<void> => {
    if (seatingInFlight.current) return
    seatingInFlight.current = true
    setSeatingBusy(true)
    setSeatingProblem(null)
    try {
      await store.setSeating(entry.id, seats, expected)
    } catch (error) {
      await store.loadSeating()
      setSeatingProblem(error instanceof Error ? error.message : 'This Mac’s seats were not saved.')
      throw error
    } finally {
      seatingInFlight.current = false
      setSeatingBusy(false)
    }
  }

  return (
    <>
      <BackLink to="Agents" onClick={onBack} />
      <DetailHead
        mark={
          <DetailMark>
            <BriefIcon size={22} />
          </DetailMark>
        }
        name={name}
        owner={originWords(entry.origin, project)}
        {...(definition?.description ? { blurb: definition.description } : {})}
        {...(definition
          ? {
              actions: (
                <Button
                  variant="default"
                  onClick={() => {
                    // Never disabled: one that cannot be seated here raises the refusal sheet, with its fixes.
                    void store.startAsAgent(entry.id).then((key) => {
                      if (key) onLeave()
                    })
                  }}
                >
                  Start a conversation as {definition.name}
                </Button>
              ),
            }
          : {})}
      />

      {/*
       * Customize… and Remove… live below the head, not inside its own
       * `actions` slot: that slot's own layout gives its text column no room
       * once a second and third action sit beside a label this long — a shape
       * every other `DetailHead` caller avoids by keeping to one short
       * control (a toggle, an icon). Flagged for the UI-system session
       * (`design/patterns/Settings.tsx`'s `.detailCtl`/`.detailText`): it
       * needs either a wrap or a second line for more than one wide action,
       * not a second composition here working around it.
       */}
      {(targets.length > 0 || (folder && entry.origin !== 'builtin')) && (
        <span className={styles.actions}>
          {targets.length > 0 && (
            <Button variant="outline" onClick={() => setCustomizing(true)}>
              Customize…
            </Button>
          )}
          {folder && entry.origin !== 'builtin' && (
            <Button variant="secondary" onClick={() => setRemoving(true)}>
              Remove…
            </Button>
          )}
        </span>
      )}

      {folder ? (
        <>
          <SectionHead name="File" />
          <Rows>
            <Row
              title={<CodeText>{fileWords(entry, snapshot.home)}</CodeText>}
              {...(shadows ? { desc: shadows } : {})}
              control={
                <span className={styles.actions}>
                  <Button size="sm" variant="outline" onClick={openFile}>
                    Open file
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void store.revealAgent(entry.id, entry.origin)}>
                    Reveal
                  </Button>
                </span>
              }
            />
          </Rows>
        </>
      ) : null}

      {errors.length > 0 && (
        <>
          <SectionHead name="Why it will not parse" />
          <Rows>
            {errors.map((one) => (
              <Row key={`${one.at}-${one.text}`} title={one.text} {...(one.at ? { desc: `At ${one.at}` } : {})} />
            ))}
          </Rows>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <SectionHead name="Warnings" />
          <Rows>
            {warnings.map((one) => (
              <Row key={`${one.at}-${one.text}`} title={one.text} {...(one.at ? { desc: `At ${one.at}` } : {})} />
            ))}
          </Rows>
        </>
      )}

      {definition && (
        <>
          <SectionHead name="Ceiling" />
          <Rows>
            <Row title={ceilingWords(definition.permission)} desc={ceilingMeaning(definition.permission)} />
          </Rows>

          <OwnSeats entry={entry} onEditSeats={() => setAdding(true)} />
          <MachineSeats
            entry={entry}
            busy={seatingBusy}
            problem={seatingProblem}
            onSet={setMachineSeats}
            onAdd={() => setAdding(true)}
          />

          <SectionHead name="What it hands back" />
          <Rows>
            <Row title="Answers" control={<RowValue>{wordList(definition.answers)}</RowValue>} />
            <Row title="Produces" control={<RowValue>{wordList(definition.produces)}</RowValue>} />
            <Row
              title="Skills"
              control={
                definition.skills.length === 0 ? (
                  <RowValue>None</RowValue>
                ) : (
                  <span className={styles.actions}>
                    {definition.skills.map((skill) => (
                      <Button key={skill} size="sm" variant="link" title="Open the Library" onClick={() => store.askSettings('library')}>
                        {skill}
                      </Button>
                    ))}
                  </span>
                )
              }
            />
          </Rows>

          <SectionHead name="Brief" />
          <Rows>
            <Row
              title={firstParagraph(definition.brief) || 'It has no brief yet.'}
              control={
                <Button size="sm" variant="outline" onClick={openFile}>
                  Open in editor
                </Button>
              }
            />
          </Rows>
        </>
      )}

      {customizing && definition && (
        <CustomizeDialog
          entry={entry}
          targets={targets}
          onClose={() => setCustomizing(false)}
          onCopied={(copy) => {
            store.openFile(copy.path)
            onLeave()
          }}
        />
      )}

      {adding && definition && (
        <AddSeatDialog
          entry={entry}
          expected={snapshot.seating?.entries.find((one) => one.id === entry.id)?.seats ?? null}
          onSet={setMachineSeats}
          onClose={() => setAdding(false)}
        />
      )}

      {removing && folder && entry.origin !== 'builtin' && (
        <RemoveDialog
          entry={entry}
          name={name}
          hasMachineSeat={plan?.from === 'machine'}
          onClose={() => setRemoving(false)}
          onRemoved={onBack}
        />
      )}
    </>
  )
}

/**
 * The seats the Agent asks for — its own `prefer` — each with its state on
 * this Mac. Where this Mac's seats replace the list here, it is still listed,
 * muted and saying so: it is what the Agent carries to every other machine.
 */
const OwnSeats = ({
  entry,
  onEditSeats,
}: {
  readonly entry: AgentEntry
  /** Where a seat the Agent asks for that this Mac cannot give is fixed — this Mac's own seats. */
  readonly onEditSeats?: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const plan = snapshot.agentPlans.get(entry.id)
  const replaced = plan?.from === 'machine'
  const seats = replaced ? (plan.own ?? []) : (plan?.candidates ?? [])
  return (
    <section aria-label="Seats">
      <SectionHead name="Seats" />
      <Note>
        {replaced
          ? 'Not used on this Mac: its seats here replace this list. Every other machine seats it in this order.'
          : 'In the order it asks for them. The first this Mac can offer is the one it takes.'}
      </Note>
      <Rows className={replaced ? 'text-(--hd-muted-foreground)' : undefined}>
        {!plan && <Row title="Checking seats…" />}
        {plan && !replaced && plan.blocked && <Row title={plan.blocked} />}
        {plan && seats.length === 0 && !plan.blocked && <Row title="It names no seat" />}
        {seats.map((candidate, index) => (
          <SeatRow
            key={`${index}-${candidate.label}`}
            candidate={candidate}
            words={replaced && candidate.state === 'taken' ? 'Free here' : stateWords(candidate)}
            editsSeats={onEditSeats !== undefined}
            onFix={(fix) => (fix.kind === 'seats' ? onEditSeats?.() : store.askSeatFix(fix, entry.id))}
          />
        ))}
      </Rows>
    </section>
  )
}

/** One seat, its state here, and the one fix that removes what stands in its way. */
export const SeatRow = ({
  candidate,
  words,
  editsSeats = false,
  onFix,
}: {
  readonly candidate: SeatCandidate
  readonly words: string
  /** Whether this surface can take *Edit seats for this Mac* itself; a button that goes nowhere is not drawn. */
  readonly editsSeats?: boolean
  readonly onFix: (fix: SeatFix) => void
}) => {
  const snapshot = useSnapshot()
  const fix = candidate.fix
  return (
    <Row
      mark={<RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} />}
      title={candidate.label}
      desc={words}
      {...(fix && (fix.kind !== 'seats' || editsSeats)
        ? {
            control: (
              <Button size="sm" variant="outline" onClick={() => onFix(fix)}>
                {fixWords(fix, candidate.runtimeName)}
              </Button>
            ),
          }
        : {})}
    />
  )
}

/**
 * On this Mac: the seats this machine gives the Agent, which replace its own
 * list here and are never committed. Added to, reordered or cleared here, and
 * footnoted with the file they live in. An entry this Mac cannot read is shown
 * where it is, with why — never dropped, and never quietly replaced by the
 * list it replaced.
 */
const MachineSeats = ({
  entry,
  busy,
  problem,
  onSet,
  onAdd,
}: {
  readonly entry: AgentEntry
  readonly busy: boolean
  readonly problem: string | null
  readonly onSet: (seats: readonly FlowSeat[] | null, expected: readonly FlowSeat[] | null) => Promise<void>
  readonly onAdd: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  useEffect(() => {
    void store.loadSeating()
  }, [store])

  const seating = snapshot.seating
  const mine = seating?.entries.find((one) => one.id === entry.id)
  const troubles = seating?.problems.filter((one) => one.id === entry.id || one.id === null) ?? []
  const unreadable = troubles.some((one) => one.id === null)
  const full = (mine?.seats.length ?? 0) >= SEAT_PREFERENCE_LIMIT
  const plan = snapshot.agentPlans.get(entry.id)
  /* The words and the states are the dry run's of this very list. Until it
     has caught up — the moment after a reorder — a row reads "Checking…"
     rather than borrow the words of the seat that used to be there. */
  const weighed =
    plan?.from === 'machine' &&
    mine &&
    plan.candidates.length === mine.seats.length &&
    plan.candidates.every((one, index) => sameSeat(one.seat, mine.seats[index]!))
      ? plan.candidates
      : null

  const set = (seats: readonly FlowSeat[] | null): void => {
    void onSet(seats, mine?.seats ?? null).catch(() => {})
  }
  const move = (from: number, to: number): void => {
    if (!mine) return
    const next = [...mine.seats]
    const [seat] = next.splice(from, 1)
    if (seat) next.splice(to, 0, seat)
    set(next)
  }
  const remove = (index: number): void => {
    if (!mine) return
    const next = mine.seats.filter((_, at) => at !== index)
    // The last seat gone is no list at all: its own applies again, rather than an empty one refusing every seating.
    set(next.length > 0 ? next : null)
  }

  return (
    <section aria-label="On this Mac">
      <SectionHead
        name="On this Mac"
        action={
          <span className={styles.actions}>
            {mine && (
              <Button size="sm" variant="outline" disabled={busy || unreadable} onClick={() => set(null)}>
                Clear
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || unreadable || full}
              title={
                unreadable
                  ? 'The file cannot be read, so nothing here writes to it — fix it by hand first.'
                  : full
                    ? `An Agent names at most ${SEAT_PREFERENCE_LIMIT} seats.`
                    : undefined
              }
              onClick={onAdd}
            >
              <PlusIcon size={14} />
              Add a seat…
            </Button>
          </span>
        }
      />
      <Rows>
        {troubles.map((one) => (
          <Row
            key={`${one.id ?? 'file'}-${one.at}`}
            title={one.text}
            desc={
              one.id === null
                ? 'The whole file cannot be read: fix it by hand. Nothing here writes over it.'
                : `${one.at ? `At ${one.at} in its entry` : 'Its entry'}: seating it here is refused until it reads.`
            }
          />
        ))}
        {!mine && troubles.length === 0 && (
          <Row
            title="Its own seats apply here"
            desc="Seats added here replace its own list on this Mac. They are not added to it."
          />
        )}
        {mine?.seats.map((seat, index) => {
          const candidate = weighed?.[index]
          return (
            <Row
              key={`${index}-${seat.runtime}-${seat.model ?? ''}-${seat.effort ?? ''}`}
              {...(candidate ? { mark: <RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} /> } : {})}
              title={candidate?.label ?? 'Checking…'}
              {...(candidate ? { desc: stateWords(candidate) } : {})}
              control={
                <span className={styles.actions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={busy || index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <MoveUpIcon size={14} />
                    Move up
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={busy || index === mine.seats.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <MoveDownIcon size={14} />
                    Move down
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove this seat"
                    title="Remove this seat"
                    disabled={busy}
                    onClick={() => remove(index)}
                  >
                    <CrossIcon size={13} />
                  </Button>
                </span>
              }
            />
          )
        })}
      </Rows>
      <Note>
        {`Kept in ${seating ? shortPath(seating.path, snapshot.home) : 'seating.json'}, on this Mac only — never committed.`}
      </Note>
      {problem && <Note tone="bad">{problem}</Note>}
    </section>
  )
}

/**
 * One seat for this Mac, chosen in words: a runtime this desk has added, one
 * of its models or its default, one of that model's efforts or its default,
 * and thinking where the model has the switch. Appended to the list.
 */
const AddSeatDialog = ({
  entry,
  expected,
  onSet,
  onClose,
}: {
  readonly entry: AgentEntry
  readonly expected: readonly FlowSeat[] | null
  readonly onSet: (seats: readonly FlowSeat[] | null, expected: readonly FlowSeat[] | null) => Promise<void>
  readonly onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [runtime, setRuntime] = useState<string>(snapshot.runtimes[0]?.id ?? '')
  const [models, setModels] = useState<readonly ModelInfo[] | null>(null)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!runtime) return
    let live = true
    setModels(null)
    setModel('')
    setEffort('')
    setThinking(false)
    void store.modelsFor(runtime as RuntimeId).then((list) => {
      if (live) setModels(list.filter((one) => !one.hidden))
    })
    return () => {
      live = false
    }
  }, [runtime, store])

  // Its efforts and its switch are the chosen model's — or, for its default, the model it defaults to.
  const shape = models?.find((one) => (model ? one.id === model : one.isDefault)) ?? null

  const add = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    const seat: FlowSeat = {
      runtime,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(thinking ? { thinking: true } : {}),
    }
    try {
      await onSet([...(expected ?? []), seat], expected)
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The seat was not saved.')
    }
  }

  return (
    <Dialog
      title={`A seat for ${agentName(entry)} on this Mac`}
      icon={<BriefIcon size={15} />}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || !runtime || models === null} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add seat'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <FormStack>
        {expected === null && <Note>Seats here replace its own list on this Mac. They are not added to it.</Note>}
        <Field label="Runtime">
          {(control) => (
            <NativeSelect {...control} value={runtime} onChange={(event) => setRuntime(event.target.value)}>
              {snapshot.runtimes.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.presentation.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Model" {...(models === null ? { hint: 'Asking the runtime…' } : {})}>
          {(control) => (
            <NativeSelect
              {...control}
              value={model}
              disabled={models === null}
              onChange={(event) => {
                setModel(event.target.value)
                setEffort('')
                setThinking(false)
              }}
            >
              <option value="">Its default</option>
              {(models ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.displayName}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {shape && shape.reasoningLevels.length > 0 && (
          <Field label="Effort">
            {(control) => (
              <NativeSelect {...control} value={effort} onChange={(event) => setEffort(event.target.value)}>
                <option value="">Its default</option>
                {shape.reasoningLevels.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        {shape?.thinking === 'optional' && (
          <Field label="Thinking">{(control) => <Switch {...control} checked={thinking} onCheckedChange={setThinking} />}</Field>
        )}
        {problem && <Note tone="bad">{problem}</Note>}
      </FormStack>
    </Dialog>
  )
}

/** Whether an Agent's own `prefer` names a model, an effort or thinking — an exact seat, not a runtime alone. */
const namesExactSeat = (entry: AgentEntry): boolean =>
  (entry.definition?.prefer ?? []).some((seat) => Boolean(seat.model || seat.effort || seat.thinking))

/**
 * *Customize…*: where the copy goes, and only places it would come first.
 *
 * *For this project* is greyed, with the reason on screen rather than
 * withdrawn, when the Agent's own seats name a model, an effort or thinking:
 * the host refuses that copy too (the Task 9 fix, H6), because a committed
 * model name breaks the Agent on every machine but its author's.
 */
const CustomizeDialog = ({
  entry,
  targets,
  onClose,
  onCopied,
}: {
  readonly entry: AgentEntry
  readonly targets: readonly ('user' | 'project')[]
  readonly onClose: () => void
  readonly onCopied: (copy: AgentEntry) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const exact = namesExactSeat(entry)
  const greyed = (target: 'user' | 'project'): boolean => target === 'project' && exact
  const [to, setTo] = useState(() => targets.find((one) => !greyed(one)) ?? targets[0] ?? 'user')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const project = projectName(snapshot.workspace)
  const yours = snapshot.stateDir ? shortPath(`${snapshot.stateDir}/agents`, snapshot.home) : 'your Agents'
  const copy = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      onCopied(await store.customizeAgent(entry.id, entry.origin, to))
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not copy it.')
    }
  }
  return (
    <Dialog
      title={`Customize ${agentName(entry)}`}
      icon={<BriefIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || greyed(to)} onClick={() => void copy()}>
            {busy ? 'Copying…' : 'Copy and open'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <Note>
        A copy to edit, which comes first wherever it is put. The one it copies stays as it is, shadowed.
      </Note>
      <Rows role="radiogroup" aria-label="Where the copy goes">
        {targets.map((target) => (
          <RowChoice
            key={target}
            title={target === 'project' ? `For ${project ?? 'this project'}` : 'For you'}
            desc={
              greyed(target)
                ? 'Its seats name models, and a project’s Agent names runtimes only.'
                : target === 'project'
                  ? 'In the project’s .harnessdesk/agents, committed with the code for everyone who clones it'
                  : `In ${yours}, on this Mac only`
            }
            disabled={greyed(target)}
            selected={to === target}
            onClick={() => setTo(target)}
          />
        ))}
      </Rows>
      {problem && <Note tone="bad">{problem}</Note>}
    </Dialog>
  )
}

/**
 * *Remove…*: names the folder, says it goes to the Trash and can be put
 * back, and — only when this Mac's own seats have an entry for this id —
 * offers to clear it too, unchecked by default: the Task 9 fix refuses a
 * later *Save* while such an entry stands, so this is the one place a person
 * clears it together with the Agent it belongs to.
 */
const RemoveDialog = ({
  entry,
  name,
  hasMachineSeat,
  onClose,
  onRemoved,
}: {
  readonly entry: AgentEntry
  readonly name: string
  readonly hasMachineSeat: boolean
  readonly onClose: () => void
  readonly onRemoved: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [clearSeats, setClearSeats] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const origin = entry.origin as 'user' | 'project'
  return (
    <ConfirmDialog
      title={`Remove ${name}?`}
      confirmLabel="Move to Trash"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true)
        setProblem(null)
        void (async () => {
          try {
            await store.trashAgent(entry.id, origin)
            if (clearSeats) await store.clearMachineSeats(entry.id)
            onRemoved()
          } catch (error) {
            setBusy(false)
            setProblem(error instanceof Error ? error.message : 'The host did not remove it.')
          }
        })()
      }}
    >
      {fileWords(entry, snapshot.home)} goes to the Trash, where it can be put back.
      {entry.shadows.length > 0 ? ' The one it came first over takes its place.' : ''}
      {entry.origin === 'project' ? ' The project’s checkout changes; commit it for everyone else.' : ''}
      {hasMachineSeat && (
        <label className={styles.clearSeats}>
          <Checkbox checked={clearSeats} onCheckedChange={(next) => setClearSeats(next === true)} />
          Also clear this Mac’s seats for “{name}”
        </label>
      )}
      {problem && <Note tone="bad">{problem}</Note>}
    </ConfirmDialog>
  )
}
