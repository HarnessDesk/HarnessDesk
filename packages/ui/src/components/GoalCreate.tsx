import { useEffect, useState } from 'react'

import type { GoalView } from '@harnessdesk/protocol'

import { Button, Checkbox, Dialog, Field, Fieldset, FormStack, Input, Note, Row, Rows } from '../design'
import { agentName, inForce } from '../lib/agents'
import { useSnapshot, useStore } from '../state/context'

export interface GoalCreateProps {
  readonly root: string
  readonly onClose: () => void
}

export const GoalCreate = ({ root, onClose }: GoalCreateProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [sentence, setSentence] = useState('')
  const [isolated, setIsolated] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [created, setCreated] = useState<GoalView | null>(null)
  const [seated, setSeated] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void store.loadAgents()
  }, [store])

  const agents = inForce(snapshot.agents ?? [])
  const valid = sentence.trim().length > 0 && sentence.trim().length <= 2000

  const toggle = (id: string, checked: boolean): void => {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    setSelected(next)
  }

  const submit = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setProblem(null)
    let goal = created
    try {
      if (!goal) {
        goal = await store.createGoal({
          root,
          sentence: sentence.trim(),
          checkout: isolated ? 'isolated' : 'shared',
        })
        setCreated(goal)
      }
      const done = new Set(seated)
      const failures: string[] = []
      for (const agent of selected) {
        if (done.has(agent)) continue
        try {
          await store.seatGoal({ goal: goal.goal.id, agent })
          done.add(agent)
          setSeated(new Set(done))
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      if (failures.length > 0) {
        setProblem(failures.join(' '))
        return
      }
      store.openGoal(goal.goal.id)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The desk did not create this Goal.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Create a Goal"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Working…' : created ? 'Retry unfinished' : 'Create Goal'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <FormStack>
        <Field
          label="What finishes this?"
          error={sentence.trim().length > 2000 ? 'Keep the Goal to 2,000 characters.' : undefined}
        >
          {(control) => (
            <Input
              {...control}
              aria-label="What finishes this?"
              autoFocus
              value={sentence}
              onChange={(event) => setSentence(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
          )}
        </Field>
        <Rows>
          <Row
            title="Use an isolated checkout"
            desc="New Seats get retained worktrees, ports and browser profiles."
            control={<Checkbox checked={isolated} onCheckedChange={(next) => setIsolated(next === true)} aria-label="Use an isolated checkout" />}
          />
        </Rows>
        {isolated && snapshot.lanePreferences?.browserProfile === false ? (
          <Note tone="warn">New lanes share the ordinary browser profile while browser isolation is off.</Note>
        ) : null}
        {agents.length > 0 ? (
          <Fieldset legend="Seat Agents">
            <Rows>
              {agents.map((agent) => (
                <Row
                  key={agent.id}
                  title={agentName(agent)}
                  control={
                    <Checkbox
                      checked={selected.has(agent.id)}
                      disabled={seated.has(agent.id) || busy}
                      onCheckedChange={(next) => toggle(agent.id, next === true)}
                      aria-label={`Seat ${agentName(agent)}`}
                    />
                  }
                />
              ))}
            </Rows>
          </Fieldset>
        ) : <Note>Add work or seat an Agent after this Goal is created.</Note>}
        {problem ? <Note tone="bad">{problem}</Note> : null}
      </FormStack>
    </Dialog>
  )
}
