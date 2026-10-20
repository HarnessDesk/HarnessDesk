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
  it('contains its absolute approval overlay below the Team destinations', () => {
    expect(body('.columnBody')).toMatch(/position:\s*relative/)
    expect(body('.columnBody')).toMatch(/overflow:\s*hidden/)
  })
  it('carries its identity through the one Team bar and preserves scoped member actions', () => {
    expect(source).toContain('header={false}')
    expect(source).toContain('teamMenuOwner={mainOwner}')
    expect(source).not.toContain('className={styles.columnHead}')
  })
})
describe('the canonical Team row', () => {
  it('lets the name shrink without spending the fixed verbs', () => {
    expect(barCss).toMatch(/\.place\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0/s)
    expect(barCss).toMatch(/\.spacer\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0/s)
    expect(barCss).toMatch(/\.fixed\s*\{[^}]*flex:\s*none/s)
    expect(source).toContain('useTopBar(mainOwner')
  })
  it('keeps the title intrinsic and places state before it', () => {
    expect(barCss).toContain('width: max-content')
    expect(barCss).toContain('max-width: var(--hd-bar-title-max)')
    expect(barCss).toContain('min-width: var(--topbar-title-floor, var(--hd-space-0))')
    const renderedBar = barSource.slice(barSource.indexOf('return <Bar as="header"'))
    expect(renderedBar).toMatch(/<div data-topbar="state"[\s\S]*<div data-topbar-title/)
  })
  it('moves Team destinations into the body and keeps their markers', () => {
    expect(barSource).not.toContain('<TabsList')
    expect(source).toContain('data-team-page={tab.value}')
  })
})
describe('watched conversation layout', () => {
  it('gives watched columns a definite full height for their embedded conversations', () => {
    expect(body('.columns')).toMatch(/height:\s*100%/)
  })
})
describe('appearance ownership', () => {
  it('composes shared frame, tool and Seat roles while its stylesheet keeps geometry', () => {
    for (const part of ['<PaneSurface', '<WorkTools', '<ToolBody>', '<ToolSection label="Run" fold', '<ToolSection label="Seats" fold', '<SeatList', '<ComposerDock>']) expect(source, part).toContain(part)
    const code=css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/^\s*(?:color|background[\w-]*|border[\w-]*|box-shadow|font[\w-]*|padding[\w-]*|line-height)\s*:/m)
  })
  it('has no Team rail beside content or local tabs at any width', () => {
    expect(source).not.toContain('<aside')
    expect(source).not.toContain('className={styles.railEdge}')
    expect(source).toContain('<TabsList aria-label="Team views"')
    expect(css).not.toContain('hd-room-rail')
  })
})
describe('Seats and responsive tools', () => {
  it('keeps membership in persistent Details instead of a clipped popup', () => {
    expect(source).toContain('useWorkDetails(mainOwner')
    expect(source).not.toContain('data-slot="team-members"')
    expect(seats).toContain('title={`Actions for ${one.name}`}')
  })
  it('wraps only refusal sentences while compact Seat facts keep their line', () => {
    expect(seats).toContain('wrapSubtitle={Boolean(one.refusal)}')
    expect(seats).toContain('{one.detail}')
    expect(seats).not.toContain('truncate')
  })
  it('lets the shared bar measure its fold and preserve navigation and tool actions in More', () => {
    expect(source).not.toContain('useNarrowLayout<HTMLElement>(608)')
    expect(source).not.toContain('--topbar-title-floor')
    expect(source).not.toContain('--hd-bar-title-min')
    expect(barSource).toContain('new ResizeObserver(measure)')
    expect(barSource).toContain("data-fold={folded ? '1' : '0'}")
    expect(barSource).toContain("Math.min(intrinsicWidth(title), metric('--hd-bar-title-min', FRAME.bar.titleMin))")
    expect(barSource).toContain('setFolded(minimum > width)')
    expect(barSource).toContain('data-topbar="tools"')
    expect(barSource).toContain('data-topbar-full-tools hidden={folded}')
    expect(barSource).toContain('folded && props.compact?.more(close)')
    expect(source).toContain('compact: { lead: <WindowControls history={false} />')
    expect(source).toContain('<WindowControls menu close={close} /><WorkTools menu close={close} changesRefusal={teamChangesRefusal} />')
  })
})
it('keeps the selected Agent glyph unframed in Seats with member information on hover', () => {
  expect(source).toContain('mark: <MemberCard')
  expect(source).toContain('side="bottom">{member?.brand ? <BrandMark brand={member.brand} size={20} /> : <AgentIcon size={20} />}</MemberCard>')
  expect(css).not.toContain('.barFacts')
})
it('updates a destination once through the canonical click handler', () => {
  expect(source).toContain('if(!tab.disabled)tab.run()')
  expect(barSource).not.toContain('<Tabs onValueChange=')
})
