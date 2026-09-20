import { useEffect, useState } from 'react'

import { DEFAULT_LANE_PREFERENCES, lanePreferences } from '@harnessdesk/protocol'

import { Button, Field, FormStack, Input, Note, Row, Rows, Switch } from '../design'
import { useSnapshot, useStore } from '../state/context'

export const LaneSettings = ({ root }: { readonly root?: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const initial = snapshot.lanePreferences ?? DEFAULT_LANE_PREFERENCES
  const [start, setStart] = useState(String(initial.start))
  const [width, setWidth] = useState(String(initial.width))
  const [browserProfile, setBrowserProfile] = useState(initial.browserProfile)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => { void store.loadLanePreferences() }, [store])
  useEffect(() => {
    if (!snapshot.lanePreferences) return
    setStart(String(snapshot.lanePreferences.start))
    setWidth(String(snapshot.lanePreferences.width))
    setBrowserProfile(snapshot.lanePreferences.browserProfile)
  }, [snapshot.lanePreferences])

  const parse = () => {
    try {
      return lanePreferences({ start: Number(start), width: Number(width), browserProfile })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Those lane defaults are not valid.')
      return null
    }
  }
  const save = async (): Promise<void> => {
    const preferences = parse()
    if (!preferences) return
    setProblem(null)
    try { await store.saveLanePreferences(preferences) }
    catch (error) { setProblem(error instanceof Error ? error.message : 'The desk did not save lane defaults.') }
  }
  const retained = snapshot.lanes.filter((lane) => {
    if (lane.state !== 'retained') return false
    const goal = snapshot.goals.get(lane.goal)
    return root === undefined || goal === undefined || goal.goal.root === root
  })

  return (
    <FormStack>
      <Field label="Starting port">
        {(control) => <Input {...control} type="number" value={start} onChange={(event) => setStart(event.target.value)} />}
      </Field>
      <Field label="Ports per lane">
        {(control) => <Input {...control} type="number" value={width} onChange={(event) => setWidth(event.target.value)} />}
      </Field>
      <Rows>
        <Row
          title="Isolated browser profiles"
          desc="Keep cookies and local storage separate for each retained lane."
          control={<Switch checked={browserProfile} onCheckedChange={setBrowserProfile} aria-label="Isolated browser profiles" />}
        />
      </Rows>
      <Button onClick={() => void save()}>Save</Button>
      {problem ? <Note tone="bad">{problem}</Note> : null}
      {retained.length > 0 ? (
        <Rows aria-label="Retained lanes">
          {retained.map((lane) => (
            <Row
              key={lane.id}
              title={lane.branch}
              desc={lane.cwd}
              control={<Button variant="secondary" onClick={() => void store.releaseLane(lane.id)}>Release ports</Button>}
            />
          ))}
        </Rows>
      ) : null}
    </FormStack>
  )
}
