import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AgentEntry, FlowPreview, FlowSeat, SeatCandidate, SeatPlan } from '@harnessdesk/protocol'

import { ActionError, Banner, Button, Dialog, Field, FormStack, NativeSelect, Note } from '../design'
import { agentName, inForce, seatTaken } from '../lib/agents'
import { raceRoleId, substituteAgentRole } from '../lib/flows'
import { useStore } from '../state/context'
import { FlowPreviewReport } from './FlowStart'

export interface RaceStartProps {
  readonly root: string
  readonly task: string
  readonly onClose: () => void
}

/**
 * `/race`: one Agent, two isolated seats, run as UI input to an ordinary
 * file — the effective `comparison` catalogue entry, substituted and then
 * previewed the same way any other flow is. Never a second execution path:
 * this dialog constructs a start request `FlowStart` would also accept.
 */
export const RaceStart = ({ root, task, onClose }: RaceStartProps) => {
  const store = useStore()
  const [source, setSource] = useState<string | null>(null)
  const [roleId, setRoleId] = useState<string | null>(null)
  const [setupProblem, setSetupProblem] = useState<string | null>(null)
  const [roster, setRoster] = useState<readonly AgentEntry[]>([])
  const [plans, setPlans] = useState<ReadonlyMap<string, SeatPlan>>(new Map())
  const [agentId, setAgentId] = useState<string | null>(null)
  const [seatA, setSeatA] = useState<number>(0)
  const [seatB, setSeatB] = useState<number>(1)
  const [preview, setPreview] = useState<FlowPreview | null>(null)
  const [previewProblem, setPreviewProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [startProblem, setStartProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    store.flowCatalog(root).then(
      async (entries) => {
        if (!live) return
        const entry = entries.find((one) => one.id === 'comparison')
        if (!entry || entry.problem) {
          setSetupProblem(entry?.problem ?? 'This project has no comparison flow to run.')
          return
        }
        try {
          const text = await store.flowSource(root, 'comparison', entry.origin)
          if (!live) return
          const learned = await store.previewFlow(root, text, {})
          if (!live) return
          const flow = learned.compiled.document.format === 'agents' ? learned.compiled.document.flow : null
          const marked = flow ? raceRoleId(flow) : null
          const role = marked ? flow!.roles.find((one) => one.id === marked) : null
          if (!role || role.kind !== 'agent') {
            setSetupProblem('This comparison file needs a two-seat Agent step. Open the file to choose its steps.')
            return
          }
          setSource(text)
          setRoleId(role.id)
        } catch (error) {
          setSetupProblem(error instanceof Error ? error.message : String(error))
        }
      },
      (error: unknown) => {
        if (live) setSetupProblem(error instanceof Error ? error.message : String(error))
      },
    )
    store.agentsIn(root).then((list) => { if (live) setRoster(inForce(list)) }, () => {})
    store.plansIn(root).then(
      (list) => { if (live) setPlans(new Map(list.map((plan) => [plan.id, plan]))) },
      () => {},
    )
    return () => {
      live = false
    }
  }, [root, store])

  // The implementer, only when it exists and can actually be seated here — never an invented default.
  useEffect(() => {
    if (agentId || roster.length === 0) return
    const implementer = roster.find((one) => one.id === 'implementer')
    if (implementer && seatTaken(plans.get(implementer.id))) setAgentId(implementer.id)
  }, [agentId, roster, plans])

  const candidates: readonly SeatCandidate[] = plans.get(agentId ?? '')?.candidates ?? []
  const identical = candidates.length > 0 && seatA === seatB
    && JSON.stringify(candidates[seatA]?.seat) === JSON.stringify(candidates[seatB]?.seat)

  const runPreview = useCallback(
    async (nextSource: string): Promise<void> => {
      setPreview(null)
      setPreviewProblem(null)
      try {
        const dry = await store.previewFlow(root, nextSource, { task })
        setPreview(dry)
        if (dry.problems.some((one) => one.level === 'error')) {
          setPreviewProblem(dry.problems.find((one) => one.level === 'error')!.text)
        }
      } catch (error) {
        setPreviewProblem(error instanceof Error ? error.message : String(error))
      }
    },
    [root, store, task],
  )

  useEffect(() => {
    if (!source || !roleId || !agentId || candidates.length < 2 || identical) {
      setPreview(null)
      return
    }
    const seats: readonly FlowSeat[] = [candidates[seatA]!.seat, candidates[seatB]!.seat]
    const substituted = substituteAgentRole(source, roleId, agentId, seats)
    if (!substituted) {
      setPreviewProblem('The comparison file’s Agent step could not be edited safely. Open it and choose its steps by hand.')
      return
    }
    void runPreview(substituted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, roleId, agentId, seatA, seatB, identical])

  const valid = preview !== null && preview.token !== null && !identical
    && preview.problems.every((one) => one.level !== 'error')

  const start = async (): Promise<void> => {
    if (!valid || !preview?.token || !source || !roleId || !agentId || busy) return
    setBusy(true)
    setStartProblem(null)
    try {
      const seats: readonly FlowSeat[] = [candidates[seatA]!.seat, candidates[seatB]!.seat]
      const substituted = substituteAgentRole(source, roleId, agentId, seats)!
      const execution = await store.startFlowGoal({ root, source: substituted, token: preview.token, sentence: task, vars: { task } })
      store.openGoal(execution.goal)
      onClose()
    } catch (error) {
      setStartProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Race an Agent against itself"
      size="md"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={!valid || busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start'}</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      <FormStack>
        {setupProblem && <Banner tone="danger" title="Racing needs its comparison file">{setupProblem}</Banner>}
        {!setupProblem && source && (
        <>
          <Field label="Agent">
            {(control) => (
              <NativeSelect
                {...control}
                aria-label="Agent"
                value={agentId ?? ''}
                onChange={(event) => setAgentId(event.target.value || null)}
              >
                <option value="">Choose an Agent…</option>
                {roster.map((entry) => (
                  <option key={entry.id} value={entry.id} disabled={!seatTaken(plans.get(entry.id))}>
                    {agentName(entry)}{!seatTaken(plans.get(entry.id)) ? ' — can’t be seated here' : ''}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          {agentId && candidates.length < 2 && (
            <Banner tone="danger" title="This Agent has no two seats to compare">
              It names fewer than two seats on this Mac. Add another seat for it, or choose a different Agent.
            </Banner>
          )}
          {agentId && candidates.length >= 2 && (
            <>
              <Field label="First seat">
                {(control) => (
                  <NativeSelect {...control} aria-label="First seat" value={seatA} onChange={(event) => setSeatA(Number(event.target.value))}>
                    {candidates.map((candidate, index) => <option key={index} value={index}>{candidate.label}</option>)}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Second seat">
                {(control) => (
                  <NativeSelect {...control} aria-label="Second seat" value={seatB} onChange={(event) => setSeatB(Number(event.target.value))}>
                    {candidates.map((candidate, index) => <option key={index} value={index}>{candidate.label}</option>)}
                  </NativeSelect>
                )}
              </Field>
              {identical && <ActionError>Choose two different seats to compare.</ActionError>}
            </>
          )}
          <Note>Both seats run in their own isolated checkout, lane and browser profile, at the same ceiling.</Note>
          {previewProblem && <Banner tone="danger" title="This comparison will not run yet">{previewProblem}</Banner>}
          {preview && !identical && <FlowPreviewReport preview={preview} flow={preview.compiled.document.format === 'agents' ? preview.compiled.document.flow : null} warnings={preview.problems.filter((one) => one.level === 'warning')} roster={new Map(roster.map((entry) => [entry.id, entry]))} />}
          {startProblem && <ActionError>{startProblem}</ActionError>}
        </>
      )}
      </FormStack>
    </Dialog>
  )
}
