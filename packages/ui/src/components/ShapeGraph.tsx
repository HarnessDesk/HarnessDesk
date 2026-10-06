import { useRef, useState } from 'react'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { Button, Card, Field, Input, Note, Row, RowButton, Rows, SectionHead, FlowCanvas, type FlowCanvasNodeChange } from '../design'
import { boundedPosition, defaultGraphPosition, readGraphPositions, ROLE_KIND_WORDS, type GraphPoint } from '../lib/shapes'

/** The ordered editor's roles and rules on the shared canvas. Only position edits leave this view. */
export interface ShapeGraphProps {
  readonly policy: FlowPolicy
  readonly selected: string | null
  readonly onSelect: (role: string | null) => void
  readonly onPositions: (positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>) => void
  readonly onEditRule: (rule: string) => void
}

const roleWord = (policy: FlowPolicy, id: string): string => {
  const role = policy.roles.find((one) => one.id === id)
  if (!role) return id
  if (role.kind === 'agent') return `${role.uses.join(', ') || 'no Agent yet'} — ${role.grant}${role.count && role.count > 1 ? ` ×${role.count}` : ''}`
  if (role.kind === 'check') return role.check.run || 'no command yet'
  return role.outcomes.join(', ') || 'no outcomes yet'
}

export const ShapeGraph = ({ policy, selected, onSelect, onPositions, onEditRule }: ShapeGraphProps) => {
  const { positions: saved, invalid } = readGraphPositions(policy)
  const [draft, setDraft] = useState<Readonly<Record<string, GraphPoint>>>({})
  const cancelled = useRef(false)
  const positionOf = (id: string, index: number): GraphPoint => (
    Object.hasOwn(saved, id) ? saved[id]! : defaultGraphPosition(index)
  )
  const commit = (id: string, point: GraphPoint): void => {
    const bounded = boundedPosition(point.x, point.y)
    if (!bounded) return
    onPositions({ ...saved, [id]: bounded })
  }

  const move = (changes: readonly FlowCanvasNodeChange[]): void => {
    const positions: Record<string, GraphPoint> = { ...saved }
    let complete = false
    const preview: Record<string, GraphPoint> = { ...draft }
    for (const change of changes) {
      if (change.type === 'select') {
        if (change.selected) onSelect(change.id)
      } else if (change.type === 'position') {
        if (cancelled.current) {
          if (!change.dragging) cancelled.current = false
          continue
        }
        const at = boundedPosition(change.position.x, change.position.y)
        if (!at) continue
        if (change.dragging) preview[change.id] = at
        else { positions[change.id] = at; delete preview[change.id]; complete = true }
      }
    }
    setDraft(preview)
    if (complete) onPositions(positions)
  }
  const indexOf = new Map(policy.roles.map((role, index) => [role.id, index]))

  return (
    <div>
      {invalid && <Note tone="warn">Some saved positions could not be read and were ignored; the file itself is unchanged.</Note>}
      <div className="h-96" onKeyDownCapture={event => {
        if (event.key === 'Escape' && Object.keys(draft).length) {
          event.preventDefault(); event.stopPropagation()
          cancelled.current = true
          setDraft({})
        }
      }}>
        <FlowCanvas label="Shape graph" positionOnly
          nodes={policy.roles.map((role, index) => ({ id: role.id, position: Object.hasOwn(draft, role.id) ? draft[role.id]! : positionOf(role.id, index),
            selected: selected === role.id, data: { name: role.id, kind: role.kind, roleLine: roleWord(policy, role.id) } }))}
          edges={policy.rules.filter(rule => indexOf.has(rule.on) && indexOf.has(rule.then.role)).map(rule => ({
            id: rule.id, source: rule.on, target: rule.then.role,
            label: rule.when?.every?.join(' / ') ?? rule.when?.any?.join(' / '),
          }))}
          onNodesChange={move} onEdgesChange={changes => { const rule = changes.find(change => change.type === 'select' && change.selected); if (rule) onEditRule(rule.id) }} />
      </div>

      <section aria-label="Every step, for when a node is off screen">
        {/* No heading here: the Graph tab this view lives behind already says "Steps". */}
        <Rows>
          {policy.roles.map((role) => (
            <RowButton
              key={role.id}
              title={role.id}
              desc={`${ROLE_KIND_WORDS[role.kind]} — ${roleWord(policy, role.id)}`}
              onClick={() => onSelect(role.id)}
            />
          ))}
        </Rows>
      </section>

      <section aria-label="Every rule, including loops">
        <SectionHead name="Rules" />
        <Rows>
          {policy.rules.length === 0 && <Row title="No rules — the seed round runs, then the run ends" />}
          {policy.rules.map((rule, index) => (
            <RowButton
              key={rule.id}
              title={`${index + 1}. ${rule.on} → ${rule.then.role}${rule.then.role === rule.on ? ' (loops back)' : ''}`}
              desc={rule.then.title}
              onClick={() => onEditRule(rule.id)}
            />
          ))}
        </Rows>
      </section>

      {selected && policy.roles.some((role) => role.id === selected) && (
        <section aria-label={`Position of ${selected}`}>
          <SectionHead name={`Position — ${selected}`} />
          <Card spacing="compact">
            <span className="flex gap-3">
              <Field label="Horizontal">
                {(control) => (
                  <Input
                    {...control}
                    type="number"
                    value={Math.round(positionOf(selected, indexOf.get(selected) ?? 0).x)}
                    onChange={(event) => commit(selected, { x: Number(event.target.value) || 0, y: positionOf(selected, indexOf.get(selected) ?? 0).y })}
                  />
                )}
              </Field>
              <Field label="Vertical">
                {(control) => (
                  <Input
                    {...control}
                    type="number"
                    value={Math.round(positionOf(selected, indexOf.get(selected) ?? 0).y)}
                    onChange={(event) => commit(selected, { x: positionOf(selected, indexOf.get(selected) ?? 0).x, y: Number(event.target.value) || 0 })}
                  />
                )}
              </Field>
            </span>
          </Card>
        </section>
      )}
    </div>
  )
}
