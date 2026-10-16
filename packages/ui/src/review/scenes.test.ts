import { describe, expect, it } from 'vitest'

import { FRAME_WALL_DESTINATIONS } from '../preview/frame-wall-kinds'
import { SCENES } from './scenes'

/**
 * A window the preview can render is a window the board shows. A page added
 * to the frame wall without a scene here would be built, rendered and never
 * reviewed or held to the guides standard, so this fails until it has one.
 */

// Destinations that are another route's spelling, not a page of their own:
// the wall rewrites them to this query before it renders.
const SPELLED_AS: Partial<Record<(typeof FRAME_WALL_DESTINATIONS)[number], string>> = {
  agent: 'frame-wall=agents&frame-detail=agent',
  'settings-general': 'frame-wall=settings&frame-section=general',
  'settings-runtimes': 'frame-wall=settings&frame-section=runtimes',
  'settings-navigation': 'frame-wall=settings&frame-section=general',
  'settings-search': 'frame-wall=settings&frame-section=general',
}

const reaches = (scene: (typeof SCENES)[number], query: string) => {
  const have = new URLSearchParams(scene.query)
  return [...new URLSearchParams(query)].every(([key, value]) => have.get(key) === value)
}

describe('review scenes', () => {
  it('show every window the frame wall can render', () => {
    const unseen = FRAME_WALL_DESTINATIONS.filter((one) => !SCENES.some((scene) => reaches(scene, SPELLED_AS[one] ?? `frame-wall=${one}`)))
    expect(unseen, 'add a scene to review/scenes.ts for each').toEqual([])
  })

  it('name only windows the frame wall can render', () => {
    const unknown = SCENES.filter((scene) => !(FRAME_WALL_DESTINATIONS as readonly string[]).includes(new URLSearchParams(scene.query).get('frame-wall') ?? ''))
    expect(unknown.map((scene) => scene.id)).toEqual([])
  })

  it('give every scene its own id', () => {
    const ids = SCENES.map((scene) => scene.id)
    expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([])
  })
})
