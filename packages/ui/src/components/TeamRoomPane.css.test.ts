import { describe, expect, it } from 'vitest'
import css from './TeamRoomPane.module.css?raw'
import source from './TeamRoomPane.tsx?raw'
import barCss from '../design/patterns/TopBar.module.css?raw'
import barSource from '../design/patterns/TopBar.tsx?raw'
import seats from '../design/patterns/SeatList.tsx?raw'

// jsdom cannot measure flex or container layout. These source contracts keep
// the migrated owners honest; native and browser tests exercise their behavior.
const body = (selector: string): string => {
  const at = css.indexOf(`${selector} {`)
  return css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('a conversation opened from the Team', () => {
  it('carries its identity through the one Team bar and preserves scoped member actions', () => {
    expect(source).toContain('header={false}')
    expect(source).toContain('teamMenuOwner={mainOwner}')
    expect(source).not.toContain('className={styles.columnHead}')
  })
})
describe('the canonical Team row', () => {
  it('lets the name shrink without spending the fixed verbs', () => {
    expect(barCss).toMatch(/\.place\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0/s)
    expect(barCss).toMatch(/\.fixed\s*\{[^}]*flex:\s*none/s)
    expect(source).toContain('useTopBar(mainOwner')
  })
  it('measures the shared title floor rather than using a private header container', () => {
    expect(barSource).toContain("getPropertyValue('--hd-bar-title-min')")
    expect(barSource).toContain('observer?.observe(node)')
    expect(css).not.toContain('hd-header')
  })
  it('folds state before worded destinations while retaining destination markers', () => {
    expect(barSource).toContain('fold === 0')
    expect(barSource).toContain('fold < 2')
    expect(barSource).toContain('data-team-page={tab.value}')
    expect(barSource).toContain('teamPage={one.value}')
  })
})
describe('watched conversation layout', () => {
  it('gives watched columns a definite full height for their embedded conversations', () => {
    expect(body('.columns')).toMatch(/height:\s*100%/)
  })
})
describe('appearance ownership', () => {
  it('composes shared frame, tool and Seat roles while its stylesheet keeps geometry', () => {
    for (const part of ['<PaneSurface', '<WorkTools', '<ToolBody>', '<ToolSection label="Run">', '<ToolSection label="Seats"', '<SeatList', '<ComposerDock>']) expect(source, part).toContain(part)
    const code=css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/^\s*(?:color|background[\w-]*|border[\w-]*|box-shadow|font[\w-]*|padding[\w-]*|line-height)\s*:/m)
  })
  it('has no Team rail beside content or local tabs at any width', () => {
    expect(source).not.toContain('<aside')
    expect(source).not.toContain('className={styles.railEdge}')
    expect(source).not.toContain('<TabsList')
    expect(css).not.toContain('hd-room-rail')
  })
})
describe('Seats and responsive tools', () => {
  it('keeps membership in persistent Details instead of a clipped popup', () => {
    expect(source).toContain('useWorkDetails(mainOwner')
    expect(source).not.toContain('data-slot="team-members"')
    expect(seats).toContain('title={`Actions for ${one.name}`}')
  })
  it('keeps complete member work sentences in wrapping shared subtitles', () => {
    expect(seats).toContain('wrapSubtitle')
    expect(seats).toContain('{one.detail}')
    expect(seats).not.toContain('truncate')
  })
  it('uses the shared measured fold and leaves the four fixed tool doors standing', () => {
    expect(source).not.toContain('useNarrowLayout<HTMLElement>(608)')
    expect(barSource).toContain('new ResizeObserver(measure)')
    expect(barSource).toContain('fold === 2')
    expect(barSource).toContain('data-topbar="tools"')
  })
})
it('keeps member face tiles in Seats rather than collapsing a header roster', () => {
  expect(source).toContain('mark: <MemberCard')
  expect(source).toContain('<IconTile shape="face"')
  expect(css).not.toContain('.barFacts')
})
it('updates a destination once through the canonical click handler', () => {
  expect(barSource).toContain('if (!tab.disabled) tab.run()')
  expect(barSource).not.toContain('<Tabs onValueChange=')
})
