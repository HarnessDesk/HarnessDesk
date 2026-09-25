import { useEffect, useId, useRef, useState } from 'react'

import { DEFAULT_LANE_PREFERENCES, lanePreferences, type LanePreferences } from '@harnessdesk/protocol'

import { Button, Note, Row, RowInput, Rows, Switch } from '../design'
import { useSnapshot, useStore } from '../state/context'

type Field = keyof LanePreferences

/**
 * Workspaces › Lanes: the machine's port range for lanes, and whether each
 * retained lane keeps a browser profile of its own.
 *
 * Every value applies as it is changed, like every other Settings control —
 * a port when its field is left or Enter is pressed, the switch as it is
 * flipped. A value the host would refuse stays in its field, marked, with the
 * reason under the card and read with the field, so it can be mended rather
 * than retyped. Each field keeps its own reason: mending one does not clear
 * another's, and Escape in a field clears its own.
 */
export const LaneSettings = ({ root }: { readonly root?: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const stored = snapshot.lanePreferences ?? DEFAULT_LANE_PREFERENCES
  const [problems, setProblems] = useState<Partial<Record<Field, string>>>({})
  const noteId = useId()

  /*
   * What was last asked for, not what was last drawn. Two quick edits — a
   * port, then the switch before the host has answered the port — each send
   * the whole preferences, and built on the drawn value the second would send
   * the first field's old value back. While nothing is in flight this is the
   * stored value; while something is, it is the newest request.
   */
  const requested = useRef<LanePreferences>(stored)
  const inFlight = useRef(0)
  if (inFlight.current === 0) requested.current = stored

  useEffect(() => { void store.loadLanePreferences() }, [store])

  const settle = (field: Field, text: string | null): void =>
    setProblems((was) => {
      if (text === null) {
        if (!(field in was)) return was
        const { [field]: _gone, ...rest } = was
        return rest
      }
      return { ...was, [field]: text }
    })

  const apply = async (field: Field, next: Partial<Record<Field, unknown>>): Promise<void> => {
    let preferences: LanePreferences
    try {
      preferences = lanePreferences({ ...requested.current, ...next })
    } catch (error) {
      settle(field, error instanceof Error ? error.message : 'That lane default is not valid.')
      return
    }
    settle(field, null)
    const before = requested.current
    requested.current = preferences
    inFlight.current += 1
    try { await store.saveLanePreferences(preferences) }
    catch (error) {
      requested.current = before
      settle(field, error instanceof Error ? error.message : 'The desk did not save lane defaults.')
    } finally {
      inFlight.current -= 1
    }
  }
  const described = (field: Field) => (problems[field] ? { 'aria-describedby': `${noteId}-${field}` } : {})
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
              {...described('start')}
              value={String(stored.start)}
              invalid={'start' in problems}
              onCommit={(next) => void apply('start', { start: Number(next) })}
              onRestore={() => settle('start', null)}
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
              {...described('width')}
              value={String(stored.width)}
              invalid={'width' in problems}
              onCommit={(next) => void apply('width', { width: Number(next) })}
              onRestore={() => settle('width', null)}
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
              {...described('browserProfile')}
            />
          )}
        />
      </Rows>
      {(['start', 'width', 'browserProfile'] as const).map((field) =>
        problems[field] ? <Note key={field} id={`${noteId}-${field}`} tone="bad">{problems[field]}</Note> : null,
      )}
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
