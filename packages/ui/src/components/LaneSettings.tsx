import { useEffect, useState } from 'react'

import { DEFAULT_LANE_PREFERENCES, lanePreferences, type LanePreferences } from '@harnessdesk/protocol'

import { Button, Note, Row, RowInput, Rows, Switch } from '../design'
import { useSnapshot, useStore } from '../state/context'

/**
 * Workspaces › Lanes: the machine's port range for lanes, and whether each
 * retained lane keeps a browser profile of its own.
 *
 * Every value applies as it is changed, like every other Settings control —
 * a port when its field is left or Enter is pressed, the switch as it is
 * flipped. A value the host would refuse stays in its field, marked, with the
 * reason under the card, so it can be mended rather than retyped.
 */
export const LaneSettings = ({ root }: { readonly root?: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const stored = snapshot.lanePreferences ?? DEFAULT_LANE_PREFERENCES
  const [problem, setProblem] = useState<{ field: keyof LanePreferences; text: string } | null>(null)

  useEffect(() => { void store.loadLanePreferences() }, [store])

  const apply = async (field: keyof LanePreferences, next: Partial<Record<keyof LanePreferences, unknown>>): Promise<void> => {
    let preferences: LanePreferences
    try {
      preferences = lanePreferences({ ...stored, ...next })
    } catch (error) {
      setProblem({ field, text: error instanceof Error ? error.message : 'That lane default is not valid.' })
      return
    }
    setProblem(null)
    try { await store.saveLanePreferences(preferences) }
    catch (error) { setProblem({ field, text: error instanceof Error ? error.message : 'The desk did not save lane defaults.' }) }
  }
  const retained = snapshot.lanes.filter((lane) => {
    if (lane.state !== 'retained') return false
    const goal = snapshot.goals.get(lane.goal)
    return root === undefined || goal === undefined || goal.goal.root === root
  })

  return (
    <>
      <Rows>
        <Row
          title="Starting port"
          desc="The first port the first lane takes."
          control={(
            <RowInput
              type="number"
              min={1024}
              max={65535}
              inputMode="numeric"
              aria-label="Starting port"
              value={String(stored.start)}
              invalid={problem?.field === 'start'}
              onCommit={(next) => void apply('start', { start: Number(next) })}
            />
          )}
        />
        <Row
          title="Ports per lane"
          desc="Each lane reserves this many, one after another."
          control={(
            <RowInput
              type="number"
              min={1}
              max={1000}
              inputMode="numeric"
              aria-label="Ports per lane"
              value={String(stored.width)}
              invalid={problem?.field === 'width'}
              onCommit={(next) => void apply('width', { width: Number(next) })}
            />
          )}
        />
        <Row
          title="Isolated browser profiles"
          desc="Keep cookies and local storage separate for each retained lane."
          control={(
            <Switch
              checked={stored.browserProfile}
              onCheckedChange={(checked) => void apply('browserProfile', { browserProfile: checked })}
              aria-label="Isolated browser profiles"
            />
          )}
        />
      </Rows>
      {problem ? <Note tone="bad">{problem.text}</Note> : null}
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
    </>
  )
}
