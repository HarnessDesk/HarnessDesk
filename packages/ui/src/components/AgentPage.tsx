import { useState } from 'react'

import type { AgentEntry, SeatCandidate, SeatFix } from '@harnessdesk/protocol'

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
  shadowWords,
  stateWords,
  wordList,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { BriefIcon } from './Icons'
import {
  BackLink,
  Button,
  Checkbox,
  CodeText,
  ConfirmDialog,
  DetailHead,
  DetailMark,
  Dialog,
  Note,
  Row,
  RowChoice,
  RowValue,
  Rows,
  SectionHead,
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

          <OwnSeats entry={entry} />

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
