import { useEffect, useRef, useState } from 'react'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { Button, Card, Field, Input, Note, Row, RowButton, Rows, SectionHead } from '../design'
import { boundedPosition, defaultGraphPosition, readGraphPositions, ROLE_KIND_WORDS, type GraphPoint } from '../lib/shapes'
import styles from './ShapeGraph.module.css'

/**
 * The same shape, drawn spatially. Moving a node edits `layout.positions`
 * and nothing else — role order, seed, rules, grants, guards, messaging and
 * budget are exactly what the ordered editor already holds. There is no
 * second routing model here: an edge is a rule's own `on`/`then.role`, drawn
 * for orientation only (`aria-hidden`), and the accessible rule list beside
 * the canvas carries the same information a screen reader can act on,
 * including a loop's back edge.
 */
export interface ShapeGraphProps {
  readonly policy: FlowPolicy
  readonly selected: string | null
  readonly onSelect: (role: string | null) => void
  readonly onPositions: (positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>) => void
  readonly onEditRule: (rule: string) => void
}

const NODE_W = 180
const NODE_H = 64

const roleWord = (policy: FlowPolicy, id: string): string => {
  const role = policy.roles.find((one) => one.id === id)
  if (!role) return id
  if (role.kind === 'agent') return `${role.uses.join(', ') || 'no Agent yet'} — ${role.grant}${role.count && role.count > 1 ? ` ×${role.count}` : ''}`
  if (role.kind === 'check') return role.check.run || 'no command yet'
  return role.outcomes.join(', ') || 'no outcomes yet'
}

export const ShapeGraph = ({ policy, selected, onSelect, onPositions, onEditRule }: ShapeGraphProps) => {
  const { positions: saved, invalid } = readGraphPositions(policy)
  const [dragging, setDragging] = useState<{ readonly id: string; readonly dx: number; readonly dy: number } | null>(null)
  const start = useRef<{ readonly id: string; readonly x: number; readonly y: number; readonly pointerX: number; readonly pointerY: number } | null>(null)

  const positionOf = (id: string, index: number): GraphPoint => saved[id] ?? defaultGraphPosition(index)
  const previewOf = (id: string, index: number): GraphPoint => {
    const base = positionOf(id, index)
    return dragging && dragging.id === id ? { x: base.x + dragging.dx, y: base.y + dragging.dy } : base
  }

  const commit = (id: string, point: GraphPoint): void => {
    const bounded = boundedPosition(point.x, point.y)
    if (!bounded) return
    onPositions({ ...saved, [id]: bounded })
  }

  useEffect(() => {
    if (!dragging) return
    const move = (event: MouseEvent): void => {
      if (!start.current) return
      setDragging({ id: start.current.id, dx: event.clientX - start.current.pointerX, dy: event.clientY - start.current.pointerY })
    }
    const up = (): void => {
      if (start.current && dragging) {
        commit(start.current.id, { x: start.current.x + dragging.dx, y: start.current.y + dragging.dy })
      }
      start.current = null
      setDragging(null)
    }
    const cancel = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      start.current = null
      setDragging(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', cancel)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', cancel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])

  const beginDrag = (id: string, index: number, event: React.MouseEvent): void => {
    const at = positionOf(id, index)
    start.current = { id, x: at.x, y: at.y, pointerX: event.clientX, pointerY: event.clientY }
    setDragging({ id, dx: 0, dy: 0 })
  }

  const width = Math.max(...policy.roles.map((role, index) => previewOf(role.id, index).x), 0) + NODE_W + 40
  const height = Math.max(...policy.roles.map((role, index) => previewOf(role.id, index).y), 0) + NODE_H + 40

  const centerOf = (id: string, index: number): GraphPoint => {
    const at = previewOf(id, index)
    return { x: at.x + NODE_W / 2, y: at.y + NODE_H / 2 }
  }
  const indexOf = new Map(policy.roles.map((role, index) => [role.id, index]))

  return (
    <div>
      {invalid && <Note tone="warn">Some saved positions could not be read and were ignored; the file itself is unchanged.</Note>}
      <div className={styles.canvas} style={{ minWidth: width, minHeight: height }}>
        <svg className={styles.edges} aria-hidden focusable="false" width={width} height={height}>
          {policy.rules.map((rule) => {
            const fromIndex = indexOf.get(rule.on)
            const toIndex = indexOf.get(rule.then.role)
            if (fromIndex === undefined || toIndex === undefined) return null
            const from = centerOf(rule.on, fromIndex)
            const to = centerOf(rule.then.role, toIndex)
            return (
              <line
                key={rule.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={styles.edgeLine}
                stroke="currentColor"
                strokeWidth={1}
              />
            )
          })}
        </svg>
        {policy.roles.map((role, index) => {
          const at = previewOf(role.id, index)
          return (
            <Button
              key={role.id}
              type="button"
              variant="outline"
              className={styles.node}
              style={{ left: at.x, top: at.y, width: NODE_W, minHeight: NODE_H }}
              data-selected={selected === role.id || undefined}
              aria-label={`${role.id} — ${ROLE_KIND_WORDS[role.kind]} step: ${roleWord(policy, role.id)}`}
              onClick={() => onSelect(role.id)}
              onMouseDown={(event) => beginDrag(role.id, index, event)}
            >
              <span className={styles.nodeTitle}>{role.id}</span>
              <span className={styles.nodeMeta}>{ROLE_KIND_WORDS[role.kind]}</span>
            </Button>
          )
        })}
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
            <span className={styles.moveFields}>
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
