import { useCallback, useEffect, useState } from 'react'

import type { FlowEntry, TriggerFiring, TriggerHistoryPage, TriggerView } from '@harnessdesk/protocol'

import { Button, Chip, Dialog, Field, NativeSelect, Note, Row, RowButton, Rows, SectionHead, Switch } from '../design'
import { triggerProblemPlace, triggerSentence, triggerSkipWords } from '../lib/intake'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { TriggerArm } from './TriggerArm'
import { TriggerCreate } from './TriggerCreate'

export interface ProjectTriggersProps {
  readonly root: string
}

type StateWords = { readonly label: string; readonly tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' }

const STATE_WORDS: Readonly<Record<TriggerView['state'], StateWords>> = {
  off: { label: 'Off', tone: 'neutral' },
  armed: { label: 'Armed', tone: 'success' },
  changed: { label: 'Changed', tone: 'warning' },
  refused: { label: 'Refused', tone: 'danger' },
  paused: { label: 'Paused', tone: 'info' },
}

const switchId = (id: string): string => `trigger-arm-${id}`

/**
 * Workspaces › a project › its triggers: what `.harnessdesk/triggers.yml`
 * declares, whether this machine has armed each one, and what last happened.
 *
 * Reading here creates nothing — an unopened or plain project is read exactly
 * as it is, matching `ProjectChecks` and `ProjectFlows` beside it. Only the
 * explicit arm review in `TriggerArm` ever consents to unattended work.
 */
export const ProjectTriggers = ({ root }: ProjectTriggersProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const revision = snapshot.triggerRevisions[root]
  const [read, setRead] = useState<
    | { readonly root: string; readonly view: import('@harnessdesk/protocol').TriggerProjectView }
    | { readonly root: string; readonly problem: string }
    | null
  >(null)
  const [dialog, setDialog] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [rowProblem, setRowProblem] = useState<{ readonly id: string; readonly message: string } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [choosingFlow, setChoosingFlow] = useState(false)
  const [flows, setFlows] = useState<readonly FlowEntry[] | null>(null)
  const [chosenFlow, setChosenFlow] = useState<string>('')
  const [creating, setCreating] = useState<{ readonly flow: string } | null>(null)

  const load = useCallback((): void => {
    store.projectTriggers(root).then(
      (view) => setRead({ root, view }),
      (error: unknown) => setRead({ root, problem: error instanceof Error ? error.message : String(error) }),
    )
  }, [store, root])

  useEffect(() => {
    load()
    // A push notification only bumps `revision`; this effect is what turns
    // that into a fresh read, whichever project raised it or none did.
  }, [load, revision])

  const restoreFocus = (id: string): void => {
    document.getElementById(switchId(id))?.focus()
  }

  const disarm = async (id: string): Promise<void> => {
    setPending((current) => new Set(current).add(id))
    setRowProblem(null)
    try {
      await store.disarmTrigger(root, id)
      load()
    } catch (error) {
      setRowProblem({ id, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const toggle = (id: string, checked: boolean): void => {
    if (pending.has(id)) return
    if (checked) setDialog(id)
    else void disarm(id)
  }

  const watchFromNow = async (id: string): Promise<void> => {
    setPending((current) => new Set(current).add(id))
    setRowProblem(null)
    try {
      await store.rebaselineTrigger(root, id)
      load()
    } catch (error) {
      setRowProblem({ id, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const openChooser = (): void => {
    setChoosingFlow(true)
    if (flows === null) {
      void store.flowCatalog(root).then(
        (list) => {
          setFlows(list)
          if (!chosenFlow && list[0]) setChosenFlow(list[0].id)
        },
        () => setFlows([]),
      )
    }
  }

  if (!read || read.root !== root) return null

  if ('problem' in read) {
    return (
      <section aria-label="Triggers">
        <SectionHead name="Triggers" />
        <Rows>
          <Row title="Its triggers could not be read" desc={read.problem} />
        </Rows>
      </section>
    )
  }

  const { view } = read

  if (!view.exists) {
    return (
      <section aria-label="Triggers">
        <SectionHead name="Triggers" action={<Button size="sm" variant="outline" onClick={openChooser}>New trigger…</Button>} />
        <Rows>
          <Row
            title="No triggers"
            desc={`Declare one in ${shortPath(view.path, snapshot.home)} to let this project open bounded work on its own.`}
          />
        </Rows>
        <FlowChooser
          open={choosingFlow}
          flows={flows}
          chosen={chosenFlow}
          onChoose={setChosenFlow}
          onClose={() => setChoosingFlow(false)}
          onContinue={() => {
            setChoosingFlow(false)
            setCreating({ flow: chosenFlow })
          }}
        />
        {creating && (
          <TriggerCreate
            root={root}
            opens={{ flow: creating.flow }}
            onClose={() => setCreating(null)}
            onSaved={() => {
              setCreating(null)
              load()
            }}
          />
        )}
      </section>
    )
  }

  return (
    <section aria-label="Triggers">
      <SectionHead name="Triggers" action={<Button size="sm" variant="outline" onClick={openChooser}>New trigger…</Button>} />
      <Note>
        {`Read from ${shortPath(view.path, snapshot.home)}, as committed. Nothing here runs until you arm it on this machine.`}
      </Note>
      {view.workingCopyChanged && (
        <Note tone="warn">
          Your working copy of this file is not what is committed. Only the committed file can be armed.
        </Note>
      )}
      <Rows>
        {view.problems.map((problem) => (
          <Row
            key={`${problem.at}:${problem.text}`}
            title={<span title={problem.at}>{triggerProblemPlace(problem.at)}</span>}
            wrapDesc
            desc={`${problem.text} ${problem.fix}`}
            control={<Chip tone="danger">Will not run</Chip>}
          />
        ))}
        {view.triggers.map((trigger) => (
          <TriggerRowGroup
            key={trigger.id}
            trigger={trigger}
            root={root}
            busy={pending.has(trigger.id)}
            rowProblem={rowProblem?.id === trigger.id ? rowProblem.message : null}
            expanded={expanded.has(trigger.id)}
            onToggleHistory={() =>
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(trigger.id)) next.delete(trigger.id)
                else next.add(trigger.id)
                return next
              })
            }
            onSwitch={(checked) => toggle(trigger.id, checked)}
            onRearm={() => setDialog(trigger.id)}
            onWatchFromNow={() => void watchFromNow(trigger.id)}
          />
        ))}
      </Rows>
      <Button variant="secondary" onClick={() => store.openFile(view.path)}>Open file</Button>
      {dialog && (
        <TriggerArm
          root={root}
          id={dialog}
          onClose={() => {
            const id = dialog
            setDialog(null)
            restoreFocus(id)
          }}
          onArmed={() => {
            const id = dialog
            setDialog(null)
            load()
            restoreFocus(id)
          }}
        />
      )}
      <FlowChooser
        open={choosingFlow}
        flows={flows}
        chosen={chosenFlow}
        onChoose={setChosenFlow}
        onClose={() => setChoosingFlow(false)}
        onContinue={() => {
          setChoosingFlow(false)
          setCreating({ flow: chosenFlow })
        }}
      />
      {creating && (
        <TriggerCreate
          root={root}
          opens={{ flow: creating.flow }}
          onClose={() => setCreating(null)}
          onSaved={() => {
            // Save writes the working tree only; a fresh read shows the new
            // trigger and, per decision, the Intake refusal until it is
            // committed — the existing Commit/Arm path handles that.
            setCreating(null)
            load()
          }}
        />
      )}
    </section>
  )
}

/** Which shape a new trigger opens — the same catalogue the front door lists, never a hardcoded set. */
const FlowChooser = ({
  open, flows, chosen, onChoose, onClose, onContinue,
}: {
  readonly open: boolean
  readonly flows: readonly FlowEntry[] | null
  readonly chosen: string
  readonly onChoose: (id: string) => void
  readonly onClose: () => void
  readonly onContinue: () => void
}) => {
  if (!open) return null
  return (
    <Dialog
      title="Every time — choose a shape"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={!chosen} onClick={onContinue}>Continue</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      <Field label="Shape">
        {(control) => (
          <NativeSelect {...control} value={chosen} disabled={flows === null} onChange={(event) => onChoose(event.target.value)}>
            {flows === null && <option value="">Reading…</option>}
            {flows?.length === 0 && <option value="">No shapes here yet</option>}
            {flows?.map((entry) => <option key={`${entry.origin}-${entry.id}`} value={entry.id}>{entry.name}</option>)}
          </NativeSelect>
        )}
      </Field>
    </Dialog>
  )
}

const TriggerRowGroup = ({
  trigger, root, busy, rowProblem, expanded, onToggleHistory, onSwitch, onRearm, onWatchFromNow,
}: {
  readonly trigger: TriggerView
  readonly root: string
  readonly busy: boolean
  readonly rowProblem: string | null
  readonly expanded: boolean
  readonly onToggleHistory: () => void
  readonly onSwitch: (checked: boolean) => void
  readonly onRearm: () => void
  readonly onWatchFromNow: () => void
}) => {
  const words = STATE_WORDS[trigger.state]
  const title = trigger.definition ? triggerSentence(trigger.definition) : trigger.id
  const desc = rowProblem
    ?? (trigger.reason ? `${trigger.reason}${trigger.fix ? ` ${trigger.fix}` : ''}` : null)
    ?? (trigger.last ? triggerSkipWords(trigger.last) : null)
  // On is anything this machine has not switched off: a changed or refused arm is switched off here too.
  const on = trigger.state !== 'off'
  const stale = trigger.state === 'changed' || trigger.state === 'refused'
  const gap = trigger.source?.state === 'gap' ? trigger.source : null
  return (
    <>
      <Row
        title={title}
        wrapDesc
        {...(desc ? { desc } : {})}
        control={(
          <span className="inline-flex items-center gap-(--hd-space-2)">
            <Chip tone={words.tone}>{words.label}</Chip>
            {stale && trigger.definition && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onRearm} title="Review what it runs now, and arm it again">
                Review
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onToggleHistory} aria-expanded={expanded}>
              History
            </Button>
            <Switch
              id={switchId(trigger.id)}
              checked={on}
              disabled={busy || (!on && !trigger.definition)}
              aria-label={`Arm ${trigger.id}`}
              onCheckedChange={onSwitch}
            />
          </span>
        )}
      />
      {gap && (
        <Row
          title="Its source stopped at a gap"
          wrapDesc
          desc={`${gap.reason ?? ''} ${gap.fix ?? ''}`.trim()}
          control={(
            <Button variant="secondary" size="sm" disabled={busy} onClick={onWatchFromNow}>
              Watch from now
            </Button>
          )}
        />
      )}
      {expanded && <TriggerHistory root={root} id={trigger.id} />}
    </>
  )
}

const TriggerHistory = ({ root, id }: { readonly root: string; readonly id: string }) => {
  const store = useStore()
  const [page, setPage] = useState<TriggerHistoryPage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let live = true
    store.triggerHistory(root, id).then(
      (next) => { if (live) setPage(next) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [store, root, id])

  const more = async (): Promise<void> => {
    if (!page?.next || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await store.triggerHistory(root, id, page.next)
      setPage({ items: [...page.items, ...next.items], next: next.next })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingMore(false)
    }
  }

  if (problem) return <Row title="Its history could not be read" desc={problem} />
  if (!page) return <Row title="Reading its history…" />
  if (page.items.length === 0) return <Row title="No firings yet" />

  return (
    <>
      {page.items.map((firing) => <FiringRow key={firing.id} firing={firing} onOpen={() => store.openGoal(firing.goal!)} />)}
      {page.next && (
        <RowButton
          title={loadingMore ? 'Reading…' : 'Show more'}
          chevron={false}
          disabled={loadingMore}
          onClick={() => void more()}
        />
      )}
    </>
  )
}

const FiringRow = ({ firing, onOpen }: { readonly firing: TriggerFiring; readonly onOpen: () => void }) => {
  const words = triggerSkipWords(firing)
  return firing.goal ? (
    <RowButton title={`#${firing.subject}`} desc={words} wrapDesc onClick={onOpen} />
  ) : (
    <Row title={`#${firing.subject}`} desc={words} wrapDesc />
  )
}
