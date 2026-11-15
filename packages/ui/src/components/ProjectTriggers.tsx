import { useDestinationActive } from '../panels/destination-page'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { FlowEntry, TriggerFiring, TriggerHistoryPage, TriggerDecisionsPage, TriggerProjectView, TriggerView } from '@harnessdesk/protocol'

import { Button, Chip, Dialog, EmptyState, Field, ListRow, ListRows, NativeSelect, Note, Row, Rows, Section, Switch, ToolBodyControls } from '../design'
import { triggerProblemPlace, triggerRowWords, triggerSkipWords } from '../lib/intake'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { ClockIcon } from './Icons'
import { MentionDecisionRows, MentionStopAttention, useMentionTriage } from './MentionDecisions'
import { TriggerArm } from './TriggerArm'
import { TriggerCreate } from './TriggerCreate'
import { useLeadLabel } from './use-lead-name'

export interface ProjectTriggersProps {
  readonly root: string
  readonly flow?: string
  readonly embedded?: boolean
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
export const ProjectTriggers = ({ root, flow, embedded = false }: ProjectTriggersProps) => {
  const destinationActive = useDestinationActive()

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

  const [stopRead, setStopRead] = useState<{ root: string; view: Pick<TriggerProjectView, 'retainedStopTriggers' | 'stopHistoryFull'> } | { root: string; problem: string } | null>(null)
  const [mentionPages, setMentionPages] = useState<ReadonlyMap<string, TriggerDecisionsPage>>(new Map())
  const rememberMention = useCallback((key: string, page: TriggerDecisionsPage | null): void => {
    setMentionPages(current => {
      if ((current.get(key) ?? null) === page) return current
      const next = new Map(current)
      if (page) next.set(key, page); else next.delete(key)
      return next
    })
  }, [])
  const stopGeneration = useRef(0)
  const generation = useRef(0)
  const activeRead = useRef(destinationActive)
  activeRead.current = destinationActive
  const lifetime=useRef(0),wasActive=useRef(destinationActive)
  if(wasActive.current!==destinationActive){wasActive.current=destinationActive;lifetime.current++}
  const activation=lifetime.current
  useEffect(()=>{activeRead.current=destinationActive;return()=>{activeRead.current=false;lifetime.current++}},[])
  const load = useCallback((owner?:number): void => {
    if (!activeRead.current || (owner!==undefined && owner!==lifetime.current)) return
    const epoch = ++generation.current
    store.projectTriggers(root).then(
      view => { if (activeRead.current && generation.current === epoch) setRead({ root, view }) },
      (error: unknown) => { if (activeRead.current && generation.current === epoch) setRead({ root, problem: error instanceof Error ? error.message : String(error) }) },
    )
  }, [store, root])

  const loadStopHistory = useCallback((): void => {
    if (!activeRead.current) return
    const epoch = ++stopGeneration.current
    store.triggerStopHistory(root).then(
      view => { if (activeRead.current && stopGeneration.current === epoch) setStopRead({ root, view }) },
      () => { if (activeRead.current && stopGeneration.current === epoch) setStopRead({ root, problem: 'Stop history could not be read.' }) },
    )
  }, [store, root])
  useEffect(() => {
    if (!destinationActive) return
    loadStopHistory()
    return () => { stopGeneration.current++ }
  }, [destinationActive, loadStopHistory, revision])

  useEffect(() => { if (!destinationActive) { setDialog(null); setChoosingFlow(false); setCreating(null) } }, [destinationActive])

  useEffect(() => {
    if (!destinationActive) return

    load()
    return () => { generation.current++ }
    // A push notification only bumps `revision`; this effect is what turns
    // that into a fresh read, whichever project raised it or none did.
  }, [destinationActive, load, revision])

  const restoreFocus = (id: string): void => {
    document.getElementById(switchId(id))?.focus()
  }

  const disarm = async (id: string): Promise<void> => {
    setPending((current) => new Set(current).add(id))
    setRowProblem(null)
    try {
      await store.disarmTrigger(root, id)
      load(activation)
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
      load(activation)
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
    if (flow) {
      setCreating({ flow })
      return
    }
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

  const listedMentions = new Set<string>()
  if (stopRead?.root === root && 'view' in stopRead && read?.root === root && 'view' in read && read.view.exists) {
    for (const item of stopRead.view.retainedStopTriggers ?? []) {
      const trigger = read.view.triggers.find(one => one.id === item.id && one.definition?.on.kind === 'mention' && (!flow || ('flow' in one.definition.opens && one.definition.opens.flow === flow)))
      const page = mentionPages.get(`${root}\u0000${item.id}`)
      if (trigger && page && (!item.stopHistoryFull || page.stopHistoryFull) && item.unconfirmedStops.every(stop => page.unconfirmedStops?.some(current => current.id === stop.id && current.state === stop.state))) listedMentions.add(item.id)
    }
  }
  const retained = stopRead?.root === root && 'view' in stopRead
    ? <RetainedStops root={root} view={stopRead.view} excluded={listedMentions} onReviewed={loadStopHistory} />
    : stopRead?.root === root && 'problem' in stopRead
      ? <ListRows><ListRow density="compact" title={stopRead.problem} wrapTitle /></ListRows>
      : null

  if (!read || read.root !== root) return retained ? <TriggerSection embedded={embedded}>{retained}</TriggerSection> : null

  if ('problem' in read) {
    return (
      <TriggerSection embedded={embedded}>
        {retained}
        <Rows>
          <Row title="Its triggers could not be read" desc={read.problem} />
        </Rows>
      </TriggerSection>
    )
  }

  const { view } = read



  if (!view.exists) {
    return (
      <TriggerSection embedded={embedded} action={<Button size="sm" variant="outline" onClick={openChooser}>New trigger…</Button>}>
        {retained}
        <Rows>
          <EmptyState
            variant="row"
            title="No triggers"
            description={`Declare one in ${shortPath(view.path, snapshot.home)} to let this project open bounded work on its own.`}
          />
        </Rows>
        <FlowChooser
          open={destinationActive && choosingFlow}
          flows={flows}
          chosen={chosenFlow}
          onChoose={setChosenFlow}
          onClose={() => setChoosingFlow(false)}
          onContinue={() => {
            setChoosingFlow(false)
            setCreating({ flow: chosenFlow })
          }}
        />
        {destinationActive && creating && (
          <TriggerCreate
            root={root}
            opens={{ flow: creating.flow }}
            onClose={() => setCreating(null)}
            onSaved={() => {
              setCreating(null)
              load(activation)
            }}
          />
        )}
      </TriggerSection>
    )
  }

  return (
    <TriggerSection embedded={embedded} action={<Button size="sm" variant="outline" onClick={openChooser}>New trigger…</Button>}>
      <Note>
        {`Read from ${shortPath(view.path, snapshot.home)}, as committed. Nothing here runs until you arm it on this machine.`}
      </Note>
      {view.workingCopyChanged && (
        <Note tone="warn">
          Your working copy of this file is not what is committed. Only the committed file can be armed.
        </Note>
      )}
      {retained}
      <ListRows>
        {view.problems.map((problem) => (
          <ListRow
            density="compact"
            key={`${problem.at}:${problem.text}`}
            title={<span title={problem.at}>{triggerProblemPlace(problem.at)}</span>}
            subtitle={`${problem.text} ${problem.fix}`}
            wrapSubtitle
            trail={<Chip tone="danger">Will not run</Chip>}
          />
        ))}
        {view.triggers.filter(trigger => !flow || (trigger.definition && 'flow' in trigger.definition.opens && trigger.definition.opens.flow === flow)).map((trigger) => (
          <TriggerRowGroup
            key={trigger.id}
            trigger={trigger}
            root={root}
            onStopReviewed={loadStopHistory}
            onMentionPage={rememberMention}
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
      </ListRows>
      <Button variant="secondary" onClick={() => store.openFile(view.path)}>Open file</Button>
      {destinationActive && dialog && (
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
            load(activation)
            restoreFocus(id)
          }}
        />
      )}
      <FlowChooser
        open={destinationActive && choosingFlow}
        flows={flows}
        chosen={chosenFlow}
        onChoose={setChosenFlow}
        onClose={() => setChoosingFlow(false)}
        onContinue={() => {
          setChoosingFlow(false)
          setCreating({ flow: chosenFlow })
        }}
      />
      {destinationActive && creating && (
        <TriggerCreate
          root={root}
          opens={{ flow: creating.flow }}
          onClose={() => setCreating(null)}
          onSaved={() => {
            // Save writes the working tree only; a fresh read shows the new
            // trigger and, per decision, the Intake refusal until it is
            // committed — the existing Commit/Arm path handles that.
            setCreating(null)
            load(activation)
          }}
        />
      )}
    </TriggerSection>
  )
}

const TriggerSection = ({ embedded, action, children }: { readonly embedded: boolean; readonly action?: ReactNode; readonly children: ReactNode }) => embedded
  ? <>{action && <ToolBodyControls>{action}</ToolBodyControls>}{children}</>
  : <Section title="Triggers">{action}{children}</Section>

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

/** Stop records remain reviewable when their source definition no longer exists. */
const RetainedStops = ({ root, view, excluded, onReviewed }: { readonly root: string; readonly view: Pick<TriggerProjectView, 'retainedStopTriggers' | 'stopHistoryFull'>; readonly excluded: ReadonlySet<string>; readonly onReviewed: () => void }) => {
  if (!view.stopHistoryFull && !view.retainedStopTriggers?.length) return null
  return <ListRows>
    {view.stopHistoryFull && <ListRow density="compact" title="Stop history cannot safely hold this request. Stop the work directly before taking further action." wrapTitle />}
    {view.retainedStopTriggers?.filter(item => !excluded.has(item.id)).map(item => <RetainedStopGroup key={item.id} root={root} item={item} projectFull={view.stopHistoryFull === true} onReviewed={onReviewed} />)}
  </ListRows>
}

const RetainedStopGroup = ({ root, item, projectFull, onReviewed }: { readonly root: string; readonly item: NonNullable<TriggerProjectView['retainedStopTriggers']>[number]; readonly projectFull: boolean; readonly onReviewed: () => void }) => {
  const [expanded, setExpanded] = useState(false)
  const revision = useSnapshot().triggerRevisions[root]
  const triage = useMentionTriage(root, item.id, true, revision, { mode: 'observe', decisions: [], threads: [], unconfirmedStops: item.unconfirmedStops, stopHistoryFull: !projectFull && item.stopHistoryFull }, onReviewed)
  return <>
    <ListRow density="compact" title={`${item.id} · Retained stop history`} trail={<Button variant="ghost" size="icon-sm" onClick={() => setExpanded(value => !value)} aria-label="History" title="History" aria-expanded={expanded}><ClockIcon size={14} /></Button>} />
    <MentionStopAttention triage={triage} expanded={expanded} />
    {expanded && <MentionDecisionRows triage={triage} stopsOnly />}
  </>
}

const TriggerRowGroup = ({
  trigger, root, busy, rowProblem, expanded, onToggleHistory, onStopReviewed, onMentionPage, onSwitch, onRearm, onWatchFromNow,
}: {
  readonly trigger: TriggerView
  readonly root: string
  readonly busy: boolean
  readonly rowProblem: string | null
  readonly expanded: boolean
  readonly onToggleHistory: () => void
  readonly onStopReviewed: () => void
  readonly onMentionPage: (key: string, page: TriggerDecisionsPage | null) => void
  readonly onSwitch: (checked: boolean) => void
  readonly onRearm: () => void
  readonly onWatchFromNow: () => void
}) => {
  const leadName = useLeadLabel()
  const words = trigger.definition ? triggerRowWords(trigger.definition, leadName) : null
  const title = words?.title ?? trigger.id
  const desc = [
    words?.facts,
    rowProblem ?? (trigger.reason ? `${trigger.reason}${trigger.fix ? ` ${trigger.fix}` : ''}` : null),
    trigger.last ? triggerSkipWords(trigger.last) : null,
  ].filter(Boolean).join(' · ')
  // On is anything this machine has not switched off: a changed or refused arm is switched off here too.
  const on = trigger.state !== 'off'
  const stale = trigger.state === 'changed' || trigger.state === 'refused'
  const gap = trigger.source?.state === 'gap' ? trigger.source : null
  // A mention trigger records what it would do until this machine switches it to act.
  const isMention = trigger.definition?.on.kind === 'mention'
  const mention = isMention && trigger.armed
  const revision = useSnapshot().triggerRevisions[root]
  const triage = useMentionTriage(root, trigger.id, isMention, revision, undefined, onStopReviewed)
  const mentionKey = `${root}\u0000${trigger.id}`
  useEffect(() => { onMentionPage(mentionKey, isMention ? triage.page : null) }, [onMentionPage, mentionKey, isMention, triage.page])
  useEffect(() => () => onMentionPage(mentionKey, null), [onMentionPage, mentionKey])
  const observing = mention && triage.page?.mode === 'observe'
  const stateChip = trigger.state === 'changed' ? <Chip tone="warning">Changed</Chip>
    : trigger.state === 'refused' ? <Chip tone="danger">Refused</Chip>
      : trigger.state === 'paused' ? <Chip tone="info">Paused</Chip>
        : observing ? <Chip tone="info">Observing</Chip>
          : null
  return (
    <>
      <ListRow
        density="compact"
        title={<>{title} {stateChip}</>}
        wrapTitle
        {...(desc ? { subtitle: desc, wrapSubtitle: true } : {})}
        trail={(
          <span className="inline-flex items-center gap-(--hd-space-2)">
            {observing && (
              <Button variant="secondary" size="sm" disabled={busy || triage.busy} onClick={() => void triage.setMode('act')} title="Open work for what it accepts, from now on">
                Switch to act
              </Button>
            )}
            {mention && triage.page?.mode === 'act' && (
              <Button variant="ghost" size="sm" disabled={busy || triage.busy} onClick={() => void triage.setMode('observe')} title="Record what it would accept, and act on nothing">
                Observe only
              </Button>
            )}
            {stale && trigger.definition && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onRearm} title="Review what it runs now, and arm it again">
                Review
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={onToggleHistory} aria-label="History" title="History" aria-expanded={expanded}>
              <ClockIcon size={14} />
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
        <ListRow
          density="compact"
          title="Its source stopped at a gap"
          subtitle={`${gap.reason ?? ''} ${gap.fix ?? ''}`.trim()}
          wrapSubtitle
          trail={(
            <Button variant="secondary" size="sm" disabled={busy} onClick={onWatchFromNow}>
              Watch from now
            </Button>
          )}
        />
      )}
      {isMention && <MentionStopAttention triage={triage} expanded={expanded} />}
      {expanded && isMention && <MentionDecisionRows triage={triage} stopsOnly={!mention} />}
      {expanded && <TriggerHistory root={root} id={trigger.id} />}
    </>
  )
}

const TriggerHistory = ({ root, id }: { readonly root: string; readonly id: string }) => {
  const destinationActive = useDestinationActive()

  const store = useStore()
  const [page, setPage] = useState<TriggerHistoryPage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    if (!destinationActive) return

    let live = true
    store.triggerHistory(root, id).then(
      (next) => { if (live) setPage(next) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [destinationActive, store, root, id])

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

  if (problem) return <ListRow density="compact" title="Its history could not be read" subtitle={problem} wrapSubtitle />
  if (!page) return <ListRow density="compact" title="Reading its history…" />
  if (page.items.length === 0) return <EmptyState variant="row" title="No firings yet" />

  return (
    <>
      {page.items.map((firing) => <FiringRow key={firing.id} firing={firing} onOpen={() => store.openGoal(firing.goal!)} />)}
      {page.next && (
        <ListRow
          density="compact"
          as="button"
          interactive
          title={loadingMore ? 'Reading more firings…' : 'Show more firings'}
          {...(loadingMore ? { 'aria-disabled': true } : {})}
          onClick={() => void more()}
        />
      )}
    </>
  )
}

const FiringRow = ({ firing, onOpen }: { readonly firing: TriggerFiring; readonly onOpen: () => void }) => {
  const words = triggerSkipWords(firing)
  return firing.goal ? (
    <ListRow density="compact" as="button" interactive title={`#${firing.subject}`} subtitle={words} wrapSubtitle onClick={onOpen} />
  ) : (
    <ListRow density="compact" title={`#${firing.subject}`} subtitle={words} wrapSubtitle />
  )
}
