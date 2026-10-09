import { useEffect, useState } from 'react'

import type { GoalView } from '@harnessdesk/protocol'

import { Button, Checkbox, Chip, Dialog, Field, Fieldset, FormStack, IconTile, Input, Note, Row, Rows, Text, Textarea } from '../design'
import { TeamIcon } from './Icons'
import { agentName, inForce } from '../lib/agents'
import { useSnapshot, useStore } from '../state/context'

export interface GoalCreateProps {
  readonly root: string
  readonly onClose: () => void
  readonly task?: string
  readonly done?: string
  readonly onTaskChange?: (value: string) => void
  readonly onDoneChange?: (value: string) => void
  readonly onChangeShape?: () => void
}

export const GoalCreate = ({ root, onClose, task, done, onTaskChange, onDoneChange, onChangeShape }: GoalCreateProps) => {
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
  const words = done?.trim() || task?.trim() || sentence.trim()
  const valid = words.length > 0 && words.length <= 2000

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
          sentence: words,
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
      setProblem(error instanceof Error ? error.message : 'The desk did not create this Team.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Just a Team"
      icon={<IconTile tone="neutral"><TeamIcon /></IconTile>}
      titleAside={<><Chip tone="neutral">{root.split('/').filter(Boolean).at(-1)}</Chip>{onChangeShape && <Button variant="quiet" disabled={busy || !!created} onClick={onChangeShape}>Change</Button>}</>}
      size="xl"
      onClose={onClose}
      footerAside={<Text role="meta">The Team opens under {root.split('/').filter(Boolean).at(-1)} in the sidebar.</Text>}
      footer={
        <>
          <Button variant="default" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Working…' : created ? 'Retry unfinished' : 'Start'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <FormStack>
        {task !== undefined && <Field label="What should they do?">{control => <Textarea {...control} aria-label="What should they do?" value={task} disabled={busy || !!created} onChange={event => onTaskChange?.(event.target.value)} />}</Field>}
        <Field
          label={task !== undefined ? 'Done when · optional' : 'What should they do?'}
          error={words.length > 2000 ? 'Keep it to 2,000 characters.' : undefined}
        >
          {(control) => (
            <Input
              {...control}
              aria-label={task !== undefined ? 'Done when · optional' : 'What should they do?'}
              autoFocus={task === undefined}
              value={done ?? sentence}
              disabled={busy || !!created}
              onChange={(event) => onDoneChange ? onDoneChange(event.target.value) : setSentence(event.target.value)}
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
          <Fieldset legend="Who does what">
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
        ) : <Note>Add work or seat an Agent after this Team is created.</Note>}
        {problem ? <Note tone="bad">{problem}</Note> : null}
      </FormStack>
    </Dialog>
  )
}
