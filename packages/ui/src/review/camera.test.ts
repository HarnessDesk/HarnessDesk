import { describe, expect, it } from 'vitest'

import { MAX_SCALE, MIN_SCALE, fit, intersects, pan, visibleRect, zoomAt } from './camera'
import { notesMarkdown, type Note } from './notes'
import { SCENES, sceneUrl } from './scenes'

describe('the review camera', () => {
  it('keeps the board point under the pointer still while zooming', () => {
    const before = { x: 40, y: -20, scale: 0.5 }
    const px = 300
    const py = 200
    const boardX = (px - before.x) / before.scale
    const boardY = (py - before.y) / before.scale
    const after = zoomAt(before, 2, px, py)
    expect(after.scale).toBe(1)
    expect(boardX * after.scale + after.x).toBeCloseTo(px)
    expect(boardY * after.scale + after.y).toBeCloseTo(py)
  })

  it('never zooms past its floor or ceiling', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 1000, 0, 0).scale).toBe(MAX_SCALE)
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0.0001, 0, 0).scale).toBe(MIN_SCALE)
  })

  it('fits a rect inside the viewport, centred, and never above the ceiling', () => {
    const camera = fit({ x: 100, y: 100, width: 1440, height: 900 }, 1000, 800, 50)
    const shown = visibleRect(camera, 1000, 800)
    expect(shown.x).toBeLessThanOrEqual(100)
    expect(shown.x + shown.width).toBeGreaterThanOrEqual(1540)
    expect(fit({ x: 0, y: 0, width: 10, height: 10 }, 1000, 800, 0, 1).scale).toBe(1)
  })

  it('pans by screen pixels and finds what is in view', () => {
    const camera = pan({ x: 0, y: 0, scale: 0.5 }, -100, 0)
    expect(intersects(visibleRect(camera, 100, 100), { x: 200, y: 0, width: 10, height: 10 })).toBe(true)
    expect(intersects(visibleRect(camera, 100, 100), { x: 500, y: 0, width: 10, height: 10 })).toBe(false)
  })
})

describe('review notes', () => {
  it('hand on as Markdown, grouped by scene and numbered across the review', () => {
    const base = { theme: 'light' as const, x: 10, y: 20, path: 'page › row', done: false, at: 0 }
    const notes: Note[] = [
      { ...base, id: 'a', scene: 'agents-roster', element: 'button[row] "Code reviewer"', text: 'Title sits 2px low.' },
      { ...base, id: 'b', scene: 'settings-general', element: null, text: '' },
      { ...base, id: 'c', scene: 'agents-roster', element: null, text: 'Done already.', done: true },
    ]
    const markdown = notesMarkdown(notes, (id) => id.toUpperCase())
    expect(markdown).toContain('## AGENTS-ROSTER (`agents-roster`)')
    expect(markdown).toContain('1. Title sits 2px low.')
    expect(markdown).toContain('`button[row] "Code reviewer"` · in page › row · at 10,20 · light')
    expect(markdown).toContain('2. ~~Done already.~~')
    expect(markdown).toContain('3. (no comment)')
  })
})

describe('review scenes', () => {
  it('are unique and each opens a frame-wall route', () => {
    const ids = SCENES.map((scene) => scene.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const scene of SCENES) expect(scene.query).toMatch(/^frame-wall=/)
  })

  it('carry their theme, guides and steps in the preview address', () => {
    const scene = SCENES.find((one) => one.steps?.length)!
    const url = new URL(sceneUrl(scene, 'dark', 'lines'), 'http://x')
    expect(url.pathname).toBe('/preview.html')
    expect(url.searchParams.get('theme')).toBe('dark')
    expect(url.searchParams.get('guides')).toBe('lines')
    expect(JSON.parse(url.searchParams.get('steps')!)).toEqual(scene.steps)
  })
})
