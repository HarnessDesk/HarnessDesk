import { useEffect, useMemo, useState } from 'react'
import type { FlowModel } from '../../lib/flow-model'
import { exampleFrame, examplePaths } from '../../lib/flow-example'
import { Button } from '../ui/button'
import { NativeSelect } from '../ui/native-select'
import { Chip, Field, Note, Text } from './Settings'
import { FlowGraph } from './FlowGraph'
import styles from './FlowExample.module.css'

export interface FlowExampleProps {
  readonly model: FlowModel
  readonly rounds?: number
}
/** Explicit local illustration. It never receives a host, admission token or recorded Run. */
export const FlowExample = ({ model, rounds }: FlowExampleProps) => {
  const paths = useMemo(() => examplePaths(model, rounds), [model, rounds])
  const [pathIndex, setPathIndex] = useState(0), [cursor, setCursor] = useState(0), [playing, setPlaying] = useState(false)
  const [selectedRule, setSelectedRule] = useState<string | null>(null)
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => { setPathIndex(0); setCursor(0); setPlaying(false); setSelectedRule(null) }, [model, rounds])
  const path = paths[pathIndex] ?? paths[0]
  const frame = path ? exampleFrame(model, path, cursor) : null
  useEffect(() => {
    if (!playing || !frame || frame.person || frame.complete || reduced) { setPlaying(false); return }
    const timer = window.setTimeout(() => { setCursor(value => value + 1); setSelectedRule(null) }, 1400)
    return () => window.clearTimeout(timer)
  }, [playing, cursor, frame?.person, frame?.complete, reduced, path])
  if (!path || !frame) return <Note>This Flow has no example steps.</Note>
  const rule = model.rules.find(one => one.id === selectedRule) ?? frame.rule
  const inspectedRules = rule ? model.rules.filter(one => one.on === rule.on && one.to === rule.to) : []
  return <section data-slot="flow-example" data-playing={playing && !frame.person && !frame.complete} className={styles.example} aria-label={`${model.name} example`}>
    <div className={styles.controls}>
      <Chip tint="blue">Example</Chip>
      <Button variant="secondary" size="sm" disabled={reduced || frame.person || frame.complete} onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : 'Play'}</Button>
      <Button variant="secondary" size="sm" disabled={frame.complete} onClick={() => { setPlaying(false); setSelectedRule(null); setCursor(value => value + 1) }}>Next</Button>
      <Button variant="quiet" size="sm" onClick={() => { setPlaying(false); setCursor(0); setSelectedRule(null) }}>Reset</Button>
    </div>
    <Note>Local illustration of the declared steps and conditions. No agents or checks run.</Note>
    {paths.length > 1 && <Field label="Example path">{control => <NativeSelect {...control} value={pathIndex} onChange={event => { setPathIndex(Number(event.target.value)); setCursor(0); setPlaying(false); setSelectedRule(null) }}>
      {paths.map((one, index) => <option key={index} value={index}>{one.steps.map(id => model.steps.find(step => step.id === id)?.name ?? id).join(' → ')} · {one.rules.map(id => model.rules.find(rule => rule.id === id)?.when ?? id).join('; ')}</option>)}
    </NativeSelect>}</Field>}
    <Text role="prose" as="p" aria-live="polite">{frame.complete ? path.bounded ? 'Example finished at its illustration limit.' : 'Example finished.' : frame.person ? 'Paused for a person. Next continues the illustration without answering for you.' : reduced ? 'Use Next with reduced motion.' : `Example step: ${model.steps.find(step => step.id === frame.step)?.name ?? frame.step}`}</Text>
    {inspectedRules.map(one => <Note key={one.id}>{`${model.steps.find(step => step.id === one.on)?.name ?? one.on} → ${model.steps.find(step => step.id === one.to)?.name ?? one.to}: ${one.when}.`}</Note>)}
    <FlowGraph model={model} overlay={frame.overlay} selectedStep={frame.complete ? null : frame.step} selectedRule={rule?.id} onSelectRule={setSelectedRule} listPlacement="summary" />
  </section>
}
