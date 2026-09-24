import { useState } from 'react'

import type { FindingDecisionAction, FindingRunView } from '@harnessdesk/protocol'

import { Banner, Button, Dialog, Note, Switch, Text, Textarea } from '../design'
import { useStore } from '../state/context'

/**
 * The person's bounded controls on a stopped or stoppable run: one more
 * round, an override to merge anyway, or dropping it. Every action needs a
 * reason and the exact stamp this view was read at; a stale read (the run
 * moved on while this was open) is refused rather than silently retried.
 */

export interface FindingDecisionProps {
  readonly goal: string
  readonly view: FindingRunView
  readonly onClose: () => void
}

const ACTIONS: readonly { readonly kind: 'another-round' | 'merge-anyway' | 'drop'; readonly label: string; readonly tone: 'default' | 'destructive' }[] = [
  { kind: 'another-round', label: 'Authorise another round', tone: 'default' },
  { kind: 'merge-anyway', label: 'Merge anyway', tone: 'destructive' },
  { kind: 'drop', label: 'Drop', tone: 'destructive' },
]

export const FindingDecision = ({ goal, view, onClose }: FindingDecisionProps) => {
  const store = useStore()
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState<FindingDecisionAction['kind'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const localOnly = view.publication === 'local'

  const decide = async (kind: FindingDecisionAction['kind'], action: FindingDecisionAction): Promise<void> => {
    const trimmed = reason.trim()
    if (trimmed === '') { setError('Say why.'); return }
    if (pending) return
    setPending(kind)
    setError(null)
    try {
      await store.decideFindingRun({
        goal, run: view.run, round: view.round, stamp: view.stamp,
        action, reason: trimmed,
      })
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(null)
    }
  }

  const act = (kind: 'another-round' | 'merge-anyway' | 'drop'): Promise<void> => decide(kind, { kind })

  const actOnExceptions = (admit: boolean): Promise<void> => {
    const findings = [...selected]
    if (findings.length === 0) { setError('Choose at least one finding.'); return Promise.resolve() }
    return decide(admit ? 'admit-exceptions' : 'decline-exceptions', { kind: admit ? 'admit-exceptions' : 'decline-exceptions', findings })
  }

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Dialog title="Decide this run" onClose={onClose} size="md">
      <div className="flex flex-col gap-3">
        {view.reason && <Text as="p" role="value">{view.reason}</Text>}
        <label className="flex flex-col gap-1.5">
          <Text role="meta">Reason</Text>
          <Textarea
            aria-label="Reason"
            value={reason}
            disabled={pending !== null}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Say why you are deciding this now."
          />
        </label>
        {error && <Banner tone="danger" title="This decision could not be recorded">{error}</Banner>}
        {localOnly && <Note>Publish a pull request before merging here. You can still continue or Drop.</Note>}
        <div className="flex flex-col gap-1.5">
          <Text role="meta">Pending exceptions</Text>
          {view.pendingExceptions.length > 0 ? (
            view.pendingExceptions.map((id) => (
              <label key={id} className="flex items-center gap-2">
                <Switch
                  checked={selected.has(id)}
                  disabled={pending !== null}
                  aria-label={`Select ${id}`}
                  onCheckedChange={() => toggle(id)}
                />
                <Text as="span" role="value">{id}</Text>
              </label>
            ))
          ) : (
            <Text as="p" role="meta">No exceptions are pending.</Text>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="default"
              disabled={pending !== null || view.pendingExceptions.length === 0 || selected.size === 0}
              title={view.pendingExceptions.length === 0 ? 'No exceptions are pending.' : undefined}
              onClick={() => void actOnExceptions(true)}
            >
              {pending === 'admit-exceptions' ? 'Working…' : 'Admit selected'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending !== null || view.pendingExceptions.length === 0 || selected.size === 0}
              title={view.pendingExceptions.length === 0 ? 'No exceptions are pending.' : undefined}
              onClick={() => void actOnExceptions(false)}
            >
              {pending === 'decline-exceptions' ? 'Working…' : 'Decline selected'}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {ACTIONS.map((action) => (
            <Button
              key={action.kind}
              type="button"
              variant={action.tone === 'destructive' ? 'destructive' : 'default'}
              disabled={pending !== null || (action.kind === 'merge-anyway' && localOnly)}
              title={action.kind === 'merge-anyway' && localOnly ? 'Publish a pull request before merging here.' : undefined}
              onClick={() => void act(action.kind)}
            >
              {pending === action.kind ? 'Working…' : action.label}
            </Button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
