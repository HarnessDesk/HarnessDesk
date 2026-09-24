import { useCallback, useEffect, useState } from 'react'

import type { TriggerFiring, TriggerHistoryPage, TriggerView } from '@harnessdesk/protocol'

import { Button, Chip, Note, Row, RowButton, Rows, SectionHead, Switch } from '../design'
import { triggerSentence, triggerSkipWords } from '../lib/intake'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { TriggerArm } from './TriggerArm'

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
        <SectionHead name="Triggers" />
        <Rows>
          <Row
            title="No triggers"
            desc={`Declare one in ${shortPath(view.path, snapshot.home)} to let this project open bounded work on its own.`}
          />
        </Rows>
      </section>
    )
  }

  return (
    <section aria-label="Triggers">
      <SectionHead name="Triggers" />
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
            title={problem.at === '' || problem.at === 'file' ? 'The file' : problem.at}
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
    </section>
  )
}

const TriggerRowGroup = ({
  trigger, root, busy, rowProblem, expanded, onToggleHistory, onSwitch,
}: {
  readonly trigger: TriggerView
  readonly root: string
  readonly busy: boolean
  readonly rowProblem: string | null
  readonly expanded: boolean
  readonly onToggleHistory: () => void
  readonly onSwitch: (checked: boolean) => void
}) => {
  const words = STATE_WORDS[trigger.state]
  const title = trigger.definition ? triggerSentence(trigger.definition) : trigger.id
  const desc = rowProblem
    ?? (trigger.reason ? `${trigger.reason}${trigger.fix ? ` ${trigger.fix}` : ''}` : null)
    ?? (trigger.last ? triggerSkipWords(trigger.last) : null)
  return (
    <>
      <Row
        title={title}
        wrapDesc
        {...(desc ? { desc } : {})}
        control={(
          <span className="inline-flex items-center gap-(--hd-space-2)">
            <Chip tone={words.tone}>{words.label}</Chip>
            <Button variant="ghost" size="sm" onClick={onToggleHistory} aria-expanded={expanded}>
              History
            </Button>
            <Switch
              id={switchId(trigger.id)}
              checked={trigger.armed}
              disabled={busy || !trigger.definition}
              aria-label={`Arm ${trigger.id}`}
              onCheckedChange={onSwitch}
            />
          </span>
        )}
      />
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
