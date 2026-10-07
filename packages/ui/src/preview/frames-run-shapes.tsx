import { useMemo, useState } from 'react'
import { RunView } from '../components/RunView'
import { RunFlow } from '../components/RunFlow'
import { RunWorkspace } from '../components/RunWorkspace'
import { runTimeline } from '../lib/run-timeline'
import { StoreProvider } from '../state/context'
import { runTeamStore } from './run-view-fixture'
import { DOCUMENT_DIFF, shapeFixture, type ShapeScene } from './run-shapes-fixture'
import { IconTile, Text } from '../design'
import { AgentIcon } from '../components/Icons'

/** Uses the real Run workspace with only synthetic records and document reads. */
export const RunShapesFrame = ({ scene, count = 3, standalone = false }: { scene: ShapeScene; count?: number; standalone?: boolean }) => {
  const input = useMemo(() => shapeFixture(scene, count), [scene, count])
  const [selected, select] = useState<string | null>(null)
  const store = useMemo(() => {
    const base = runTeamStore()
    return new Proxy(base, { get(target, key) {
      if (key === 'transport') return { request: async (method: string) => {
        if (method === 'git/fileAtRevision') return { text: '# Investigation answer\n\nKeep the session store behind a flag and measure the change.\n', bytes: 89 }
        if (method !== 'git/diffRange') throw new Error('Preview has no such read')
        return { diff: DOCUMENT_DIFF }
      } }
      return Reflect.get(target, key)
    } })
  }, [])
  const seats = [...new Set(input.execution.rounds.flatMap(round => round.seats))].map(id => ({ id, name: id === 'seat-5' ? 'Judge' : `Agent ${id.split('-').at(-1)}`, override: 'Balanced · High' }))
  const seatNames = new Map(seats.map(seat => [seat.id, { name: seat.name, detail: seat.override }]))
  const props = { model: runTimeline(input), execution: input.execution, number: 1, selectedRow: selected, onSelect: select, seatNames }
  return <StoreProvider store={store}><section id="run-shapes-frame" data-scene={scene} className={scene === 'comparison' ? 'flex h-320 min-w-0 flex-col' : 'flex h-224 min-w-0 flex-col'}>
    <div className="flex items-center gap-2 px-4 py-3"><IconTile size="sm"><AgentIcon /></IconTile><Text role="section">Session store · {scene}</Text></div>
    {standalone ? <RunView {...props} /> : <RunWorkspace {...props} flow={<RunFlow execution={input.execution} root="/repo" seats={[]} cards={input.cards} />}
      inspector={{ input, seats }} />}
  </section></StoreProvider>
}
