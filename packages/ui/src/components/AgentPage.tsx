import { useEffect, useMemo, useRef, useState } from 'react'

import {
  SEAT_PREFERENCE_LIMIT,
  type AgentEntry,
  type AgentFieldEdit,
  type AuthoringDocument,
  type AuthoringTarget,
  type FlowSeat,
  type ModelInfo,
  type RuntimeId,
  type SeatCandidate,
  type SeatFix,
  type WritableAuthoringTarget,
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
import { relativeTo, shortPath } from '../lib/paths'
import { flagWords } from '../lib/ceilings'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { AgentSeatCosts } from './AgentSeatCosts'
import { BriefIcon, PlusIcon, TrashIcon } from './Icons'
import {
  BackLink,
  Banner,
  BoardMenuButton,
  Button,
  Checkbox,
  ConfirmDialog,
  DetailHead,
  DetailMark,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  NativeSelect,
  Note,
  Row,
  RowChoice,
  RowValue,
  Rows,
  Section,
  SectionHead,
  SortableAnnouncer,
  SortableHandle,
  SummaryItem,
  SummaryList,
  Switch,
  Text,
  sortableItemClass,
  useSortable,
} from '../design'
import styles from './AgentPage.module.css'
import { AgentAttachments } from './AgentAttachments'
import { AgentFields, AgentPageSections, FieldEditDialog, PreferFieldDialog } from './AgentFields'
import { AgentNotes } from './AgentNotes'
import { CeilingUpdate } from './CeilingUpdate'
import { TriggerCreate } from './TriggerCreate'

/** The one file `AgentFields` reads and saves through — a project's own Agent needs the project that owns it. */
const authoringTarget = (entry: AgentEntry, project: string | null): AuthoringTarget => ({
  kind: 'agent',
  origin: entry.origin,
  id: entry.id,
  ...(entry.origin === 'project' && project ? { root: project } : {}),
})

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
  const [updatingCeiling, setUpdatingCeiling] = useState(false)
  const [editingCeiling, setEditingCeiling] = useState(false)
  const [editingPrefer, setEditingPrefer] = useState(false)
  const [seatingBusy, setSeatingBusy] = useState(false)
  const [seatingProblem, setSeatingProblem] = useState<string | null>(null)
  const seatingInFlight = useRef(false)
  const [agentDocument, setAgentDocument] = useState<AuthoringDocument | null>(null)
  const [documentProblem, setDocumentProblem] = useState<string | null>(null)
  const [fieldsBusy, setFieldsBusy] = useState(false)
  const [everyTime, setEveryTime] = useState(false)
  const [attachmentsProblem, setAttachmentsProblem] = useState<string | null>(null)
  const definition = entry.definition
  const name = agentName(entry)
  const project = projectName(snapshot.workspace)
  const folder = isAgentFolder(entry)
  const targets = definition && folder ? copyTargets(entry.origin, snapshot.workspace !== null) : []
  const errors = entry.problems.filter((one) => one.level === 'error')
  const warnings = entry.problems.filter((one) => one.level === 'warning')
  const shadows = shadowWords(entry)
  const plan = snapshot.agentPlans.get(entry.id)
  const ceilingFlag = definition ? flagWords(definition) : null
  // Relative to the project's own root when there is one to be relative to —
  // the header above already says "In storefront", so a project Agent's file
  // repeats nothing by starting from `.harnessdesk/agents/...` rather than
  // the whole checkout path. The absolute path still rides along in `title`.
  const fileLabel =
    entry.origin === 'project' && snapshot.agentsProject ? relativeTo(entry.path, snapshot.agentsProject) : fileWords(entry, snapshot.home)
  const canUpdateCeiling = ceilingFlag !== null && (entry.origin === 'user' || entry.origin === 'project')
  /** Builtins are read-only until Customize copies them, exactly like the fields below. */
  const editable = entry.origin !== 'builtin'
  useEffect(() => {
    setUpdatingCeiling(false)
    setEditingCeiling(false)
    setEditingPrefer(false)
  }, [entry.id, entry.origin, entry.path, snapshot.agentsProject])

  useEffect(() => {
    if (!definition) return
    let live = true
    setAgentDocument(null)
    setDocumentProblem(null)
    store.readAuthoring(authoringTarget(entry, snapshot.agentsProject)).then(
      (next) => {
        if (live) setAgentDocument(next)
      },
      (error: unknown) => {
        if (live) setDocumentProblem(error instanceof Error ? error.message : String(error))
      },
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.origin, snapshot.agentsProject, store])

  const openFile = (): void => {
    store.openFile(entry.path)
    onLeave()
  }

  /**
   * A field just landed. The digest `AgentFields` was editing against is now
   * stale for the next one, so both the roster (for `entry`) and the document
   * (for its digest) are read again before another edit is allowed —
   * `fieldsBusy` is what disables its rows meanwhile.
   */
  const onFieldEdited = (_edit: AgentFieldEdit): void => {
    setFieldsBusy(true)
    void Promise.all([
      store.loadAgents(),
      store.readAuthoring(authoringTarget(entry, snapshot.agentsProject)).then(
        (next) => setAgentDocument(next),
        () => {
          // A read that fails after a save that landed leaves the last good document on screen.
        },
      ),
    ]).finally(() => setFieldsBusy(false))
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
       * Customize… lives below the head, not inside its own `actions` slot:
       * that slot's own layout gives its text column no room once a second
       * action sits beside a label this long — a shape every other
       * `DetailHead` caller avoids by keeping to one short control (a toggle,
       * an icon). Flagged for the UI-system session (`design/patterns/Settings.tsx`'s
       * `.detailCtl`/`.detailText`): it needs either a wrap or a second line
       * for more than one wide action, not a second composition here working
       * around it. Remove… moved out entirely — a destructive action never
       * sits alone under the title (review item 7) — into its own Danger
       * section at the foot of the page, below.
       */}
      {(targets.length > 0 || (definition && snapshot.agentsProject)) && (
        <span className={styles.actions}>
          {targets.length > 0 && (
            <Button variant="outline" onClick={() => setCustomizing(true)}>
              Customize…
            </Button>
          )}
          {definition && snapshot.agentsProject && (
            <Button variant="outline" onClick={() => setEveryTime(true)}>
              Every time…
            </Button>
          )}
        </span>
      )}

      {(folder || definition) && (
        <Section title="Agent">
          <SummaryList>
            {folder && (
              <SummaryItem
                label="File"
                kind="path"
                title={entry.path}
                {...(shadows ? { note: shadows } : {})}
                action={
                  <span className={styles.actions}>
                    <Button size="sm" variant="outline" onClick={openFile}>
                      Open file
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void store.revealAgent(entry.id, entry.origin)}>
                      Reveal
                    </Button>
                  </span>
                }
              >
                {fileLabel}
              </SummaryItem>
            )}
            {definition && (
              <SummaryItem
                label="Ceiling"
                note={[ceilingMeaning(definition.ceiling), ceilingFlag].filter(Boolean).join(' ')}
                {...(editable ? {
                  action: canUpdateCeiling ? (
                    // A legacy `permission:` Agent needs Update first — Edit…
                    // would only reach the same preview and be told, every
                    // time, to come back here. One action, not a second that
                    // always refuses.
                    <Button size="sm" variant="outline" onClick={() => setUpdatingCeiling(true)}>Update…</Button>
                  ) : (
                    // Same `authoring/*` preview/save path as name, description, answers and
                    // produces below — disabled until that document is read, since it needs
                    // the digest to preview against.
                    <Button size="sm" variant="outline" disabled={!agentDocument} onClick={() => setEditingCeiling(true)}>Edit…</Button>
                  ),
                } : {})}
              >
                {ceilingWords(definition.ceiling)}
              </SummaryItem>
            )}
            {definition && <AgentAttachments entry={entry} onProblem={setAttachmentsProblem} />}
            {definition && (
              <SummaryItem
                label="Brief"
                action={
                  <Button size="sm" variant="outline" onClick={openFile}>
                    Open in editor
                  </Button>
                }
              >
                {firstParagraph(definition.brief) || 'It has no brief yet.'}
              </SummaryItem>
            )}
          </SummaryList>
        </Section>
      )}
      {/* The Skills/Servers read-failure: a `<dl>`'s subgrid has no room for a
          Banner among its rows, so `AgentAttachments` hands it up here rather
          than drawing it in place of the row it would otherwise be. */}
      {attachmentsProblem && <Banner tone="danger" title="Attachments could not be read">{attachmentsProblem}</Banner>}

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
          <OwnSeats
            entry={entry}
            onEditSeats={() => setAdding(true)}
            {...(agentDocument ? { onEditPrefer: () => setEditingPrefer(true) } : {})}
          />
          <MachineSeats
            entry={entry}
            busy={seatingBusy}
            problem={seatingProblem}
            onSet={setMachineSeats}
            onAdd={() => setAdding(true)}
          />
          <AgentSeatCosts entry={entry} />

          {agentDocument ? (
            <AgentFields
              document={agentDocument}
              entry={entry}
              busy={fieldsBusy}
              onEdit={onFieldEdited}
              onOpenFile={openFile}
            />
          ) : documentProblem ? (
            <Banner tone="danger" title="This Agent’s file could not be read">{documentProblem}</Banner>
          ) : (
            <>
              <SectionHead name="What it hands back" />
              <Rows>
                <Row title="Answers" control={<RowValue>{wordList(definition.answers)}</RowValue>} />
                <Row title="Produces" control={<RowValue>{wordList(definition.produces)}</RowValue>} />
              </Rows>
            </>
          )}

          <AgentNotes entry={entry} />

          <AgentPageSections entry={entry}>{null}</AgentPageSections>
        </>
      )}

      {/* A destructive action never sits alone under the title (review item 7) — reachable for a broken entry too, since removing one is how its folder is cleaned up. */}
      {folder && entry.origin !== 'builtin' && (
        <section aria-label="Danger">
          <SectionHead name="Danger" />
          <Rows>
            <Row
              title="Remove"
              desc="Moves its folder to the Trash. It can be put back."
              control={
                <Button variant="destructive" onClick={() => setRemoving(true)}>
                  Remove…
                </Button>
              }
            />
          </Rows>
        </section>
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

      {updatingCeiling && definition && canUpdateCeiling && (
        <CeilingUpdate entry={entry} onClose={() => setUpdatingCeiling(false)} />
      )}

      {editingCeiling && definition && agentDocument && (
        <FieldEditDialog
          fieldKey="ceiling"
          target={agentDocument.target as Extract<WritableAuthoringTarget, { readonly kind: 'agent' }>}
          digest={agentDocument.digest}
          initial={definition.ceiling}
          onOpenFile={openFile}
          onClose={() => setEditingCeiling(false)}
          onSaved={(edit) => {
            setEditingCeiling(false)
            onFieldEdited(edit)
          }}
        />
      )}

      {editingPrefer && definition && agentDocument && (
        <PreferFieldDialog
          entry={entry}
          target={agentDocument.target as Extract<WritableAuthoringTarget, { readonly kind: 'agent' }>}
          digest={agentDocument.digest}
          initial={definition.prefer}
          onOpenFile={openFile}
          onClose={() => setEditingPrefer(false)}
          onSaved={(edit) => {
            setEditingPrefer(false)
            onFieldEdited(edit)
          }}
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

      {everyTime && snapshot.agentsProject && (
        <TriggerCreate
          root={snapshot.agentsProject}
          opens={{ agent: entry.id }}
          onClose={() => setEveryTime(false)}
          onSaved={() => setEveryTime(false)}
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
  onEditPrefer,
}: {
  readonly entry: AgentEntry
  /** Where a seat the Agent asks for that this Mac cannot give is fixed — this Mac's own seats. */
  readonly onEditSeats?: () => void
  /** Edits the list itself, through the same `authoring/*` path as the rest of this page — absent while it is not yet known which file to save. */
  readonly onEditPrefer?: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const plan = snapshot.agentPlans.get(entry.id)
  const replaced = plan?.from === 'machine'
  const seats = replaced ? (plan.own ?? []) : (plan?.candidates ?? [])
  const editable = entry.origin !== 'builtin'
  return (
    <section aria-label="Seats">
      <SectionHead
        name="Seats"
        {...(editable && onEditPrefer ? { action: <Button size="sm" variant="outline" onClick={onEditPrefer}>Edit…</Button> } : {})}
      />
      <Note>
        {replaced
          ? 'Not used on this Mac: its seats here replace this list. Every other machine seats it in this order.'
          : 'In the order it asks for them. The first this Mac can offer is the one it takes.'}
      </Note>
      <Rows>
        {!plan && <Row title="Checking seats…" />}
        {plan && !replaced && plan.blocked && <Row title={plan.blocked} />}
        {plan && seats.length === 0 && !plan.blocked && <Row title="It names no seat" />}
        {seats.map((candidate, index) => (
          <SeatRow
            key={`${index}-${candidate.label}`}
            candidate={candidate}
            moot={replaced}
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
  moot = false,
  editsSeats = false,
  onFix,
}: {
  readonly candidate: SeatCandidate
  readonly words: string
  /** A seat of a list this Mac does not use: named in the muted ink, never withdrawn. */
  readonly moot?: boolean
  /** Whether this surface can take *Edit seats for this Mac* itself; a button that goes nowhere is not drawn. */
  readonly editsSeats?: boolean
  readonly onFix: (fix: SeatFix) => void
}) => {
  const snapshot = useSnapshot()
  const fix = candidate.fix
  return (
    <Row
      mark={<RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} />}
      title={<Text role="row" ink={moot ? 'muted' : 'primary'}>{candidate.label}</Text>}
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
  /*
   * The list is a sortable order: a drag from a seat's handle, ⌥↑/⌥↓ from its
   * row, or Space on its handle to pick it up. Each move is the same write,
   * and it is announced once the list on disk says so. A seat has no id of its
   * own, so it is named by what it is, and by which of its twins it is.
   */
  const seatIds = useMemo(() => {
    const seen = new Map<string, number>()
    return (mine?.seats ?? []).map((seat) => {
      const base = JSON.stringify([seat.runtime, seat.model ?? null, seat.effort ?? null, seat.thinking ?? null])
      const twin = seen.get(base) ?? 0
      seen.set(base, twin + 1)
      return `${base}#${twin}`
    })
  }, [mine?.seats])
  const sortable = useSortable({
    ids: seatIds,
    onMove: (id, to) => move(seatIds.indexOf(id), to),
    /* Named from the seat itself — its runtime, model and effort — never from
       the dry run, which lags a move and would name the seat that used to be
       in its place. */
    name: (id) => {
      const seat = mine?.seats[seatIds.indexOf(id)]
      if (!seat) return 'the seat'
      const runtime = snapshot.runtimes.find((one) => one.id === seat.runtime)?.presentation.name ?? seat.runtime
      return [runtime, seat.model, seat.effort].filter(Boolean).join(' · ')
    },
    movable: () => !unreadable,
    // A write in flight: keys and drags wait, but focus stays on the handle.
    busy,
  })
  /* The seat whose ⋯ menu is open. Controlled so that a write in flight can
     refuse to open it while the button keeps its focus (`aria-disabled`),
     rather than a disabled button dropping focus to the page. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
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
        {mine?.seats.map((_seat, index) => {
          const candidate = weighed?.[index]
          const id = seatIds[index]!
          return (
            <Row
              key={id}
              {...sortable.row(id, index)}
              className={sortableItemClass()}
              {...(candidate ? { mark: <RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} /> } : {})}
              title={candidate?.label ?? 'Checking…'}
              {...(candidate ? { desc: stateWords(candidate) } : {})}
              control={(
                <>
                  <SortableHandle {...sortable.handle(id)} />
                  <DropdownMenu
                    open={menuFor === id && !busy}
                    onOpenChange={(open) => setMenuFor(open && !busy ? id : null)}
                  >
                    <DropdownMenuTrigger render={<BoardMenuButton aria-label={`Seat ${index + 1} actions`} {...(busy ? { 'aria-disabled': true } : {})} />} />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onClick={() => remove(index)}>
                        <TrashIcon size={14} />
                        Remove seat
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            />
          )
        })}
      </Rows>
      <SortableAnnouncer message={sortable.announcement} />
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
      tone="destructive"
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
        <Checkbox
          className={styles.clearSeats}
          checked={clearSeats}
          onCheckedChange={(next) => setClearSeats(next === true)}
          label={`Also clear this Mac’s seats for “${name}”`}
        />
      )}
      {problem && <Note tone="bad">{problem}</Note>}
    </ConfirmDialog>
  )
}
