import { useMemo, useState } from 'react'

import type { GoalView } from '@harnessdesk/protocol'

import { Banner, Button, CodeText, Dialog, NativeSelect, Note, Switch, Text } from '../design'
import { useSnapshot, useStore } from '../state/context'

/**
 * Carrying a wrapped Goal's unresolved findings into an open Goal of the
 * same project: a reference hand-off, never copied work. The same finding
 * ids, their original Seat and revision, and the wrapped Goal becomes a
 * dependency of the target. The source receipt is never reopened; the host
 * refuses anything already carried, resolved, or from another project.
 */

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export const FindingCarry = ({ source }: { readonly source: GoalView }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const receipt = source.receipt
  const unresolved = useMemo(
    () => (receipt?.findings?.findings ?? []).filter((one) => !one.lifecycle.confirmed && !one.restored && one.problem === null),
    [receipt],
  )
  const targets = [...snapshot.goals.values()].filter((one) =>
    one.goal.id !== source.goal.id && one.goal.state === 'open' && one.goal.root === source.goal.root && !one.problem)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<string>('')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // One token per opening of the dialog: a retry of the same carry is the same carry.
  const [request, setRequest] = useState('')

  if (!receipt || unresolved.length === 0) return null
  const refusal = targets.length === 0 ? 'Open a Goal in this project to carry these findings into.' : null

  const begin = (): void => {
    setTarget(targets[0]?.goal.id ?? '')
    setChosen(new Set(unresolved.map((one) => one.id)))
    setRequest(globalThis.crypto.randomUUID())
    setError(null)
    setOpen(true)
  }

  const carry = async (): Promise<void> => {
    const into = snapshot.goals.get(target)
    if (!into || pending || chosen.size === 0) return
    setPending(true)
    setError(null)
    try {
      const carried = await store.carryFindings({
        goal: into.goal.id, revision: into.goal.revision, source: source.goal.id, receipt: receipt.id,
        findings: unresolved.filter((one) => chosen.has(one.id)).map((one) => one.id), request,
      })
      setDone(`Carried ${plural(carried.length, 'finding', 'findings')} into ${into.goal.sentence}.`)
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }

  const toggle = (id: string): void => setChosen((was) => {
    const next = new Set(was)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={refusal !== null} title={refusal ?? undefined} onClick={begin}>
          Carry unresolved findings…
        </Button>
        {refusal && <Text role="meta">{refusal}</Text>}
      </span>
      {done && <Note>{done}</Note>}
      {open && (
        <Dialog
          title="Carry unresolved findings"
          size="md"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="default" disabled={pending || chosen.size === 0 || target === ''} onClick={() => void carry()}>
                {pending ? 'Carrying…' : `Carry ${plural(chosen.size, 'finding', 'findings')}`}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>Keep them here</Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Text as="p" role="prose">
              The same findings, with the Seat and revision that raised them, move to the Goal you choose, and that Goal waits on this one. This receipt stays as it was wrapped.
            </Text>
            <label className="flex flex-col gap-1.5">
              <Text role="meta">Into</Text>
              <NativeSelect aria-label="Into" value={target} disabled={pending} onChange={(event) => setTarget(event.target.value)}>
                {targets.map((one) => <option key={one.goal.id} value={one.goal.id}>{one.goal.sentence}</option>)}
              </NativeSelect>
            </label>
            <div className="flex flex-col gap-1.5">
              {unresolved.map((one) => (
                <label key={one.id} className="flex items-center gap-2">
                  <Switch checked={chosen.has(one.id)} disabled={pending} aria-label={`Carry ${one.id}`} onCheckedChange={() => toggle(one.id)} />
                  <Text as="span" role="value" truncate>{one.title || 'Untitled finding'}</Text>
                  <CodeText className="shrink-0">{one.id}</CodeText>
                </label>
              ))}
            </div>
            {error && <Banner tone="danger" title="These findings could not be carried">{error}</Banner>}
          </div>
        </Dialog>
      )}
    </div>
  )
}
