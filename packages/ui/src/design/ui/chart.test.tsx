import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChartKey, ChartKeys, ChartTip, DayColumns, PaceBadge, SegmentMeter, SeriesDot } from './chart'
import { TINTS, tintFor, tintsFor } from './tone'

/**
 * The claims a chart makes that a screenshot cannot check.
 *
 * Everything here is a rule the kit exists to enforce rather than a rendering
 * detail: which way a meter fills, what "not reported" looks like next to
 * "nothing left", whether a chart can be read without a mouse, and whether
 * two series in one legend can end up wearing the same colour. Each of them
 * is a bug this app has actually had, in a hand-rolled chart, on some screen.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mount = (node: ReactNode): void => {
  act(() => root.render(node))
}

const meter = (): HTMLElement => container.querySelector('[data-slot="segment-meter"]') as HTMLElement
const tip = (): HTMLElement | null => container.querySelector('[data-slot="chart-tip"]')
const plot = (): HTMLElement => container.querySelector('[role="group"]') as HTMLElement

const press = (key: string): void => {
  act(() => {
    plot().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

/**
 * Segments drawn in a tone's fill, which is what "lit" means here.
 *
 * Counted by exclusion: the spent track and the unreported track are the two
 * other states, and everything else is a lit segment whatever tone it wears.
 */
const lit = (element: HTMLElement): number =>
  [...element.children].filter(
    (child) =>
      !child.className.includes('bg-(--hd-border)') && !child.className.includes('border-dashed'),
  ).length

describe('SegmentMeter', () => {
  it('fills with what is LEFT, so a full meter always means plenty', () => {
    mount(<SegmentMeter percent={25} label="Weekly" segments={40} />)
    expect(meter().getAttribute('aria-valuenow')).toBe('25')
    expect(meter().getAttribute('aria-label')).toBe('Weekly')
    expect(lit(meter())).toBe(10)
  })

  it('lights at least one segment while anything is left', () => {
    // 1% of a 40-segment meter rounds to 0.4. An account that can still run a
    // turn must not read as empty.
    mount(<SegmentMeter percent={1} label="Weekly" segments={40} />)
    expect(lit(meter())).toBe(1)
  })

  it('lights nothing at all when nothing is left', () => {
    mount(<SegmentMeter percent={0} label="Weekly" segments={40} />)
    expect(lit(meter())).toBe(0)
  })

  it('draws an unreported figure as hollow, never as zero', () => {
    mount(<SegmentMeter percent={null} label="Code review" segments={12} />)
    // No number is claimed…
    expect(meter().hasAttribute('aria-valuenow')).toBe(false)
    expect(meter().getAttribute('aria-valuetext')).toBe('not reported')
    // …and the track is visibly a different thing from a spent one.
    expect([...meter().children].every((child) => child.className.includes('border-dashed'))).toBe(
      true,
    )
  })

  it('wears the tone the caller judged, not one of its own', () => {
    mount(<SegmentMeter percent={8} tone="danger" label="Weekly" segments={10} />)
    expect(meter().children[0]?.className).toContain('bg-(--hd-danger)')
  })

  it('draws a distribution — one continuous bar split by share — when given parts', () => {
    mount(
      <SegmentMeter
        label="Where it went"
        parts={[
          { key: 'a', tint: 'blue', value: 30 },
          { key: 'b', tint: 'teal', value: 70 },
        ]}
      />,
    )
    const bar = meter()
    expect(bar.getAttribute('role')).toBe('img')
    expect(bar.children).toHaveLength(2)
    expect((bar.children[0] as HTMLElement).style.width).toBe('30%')
    expect((bar.children[1] as HTMLElement).style.width).toBe('70%')
  })

  it('draws nothing filled for a distribution with no total', () => {
    mount(<SegmentMeter label="Where it went" parts={[{ key: 'a', tint: 'blue', value: 0 }]} />)
    expect(meter().children).toHaveLength(0)
  })
})

describe('DayColumns', () => {
  const SERIES = [
    { key: 'a', label: 'Alpha', tint: 'blue' as const },
    { key: 'b', label: 'Beta', tint: 'green' as const },
  ]
  const BUCKETS = [
    { label: 'Mon', total: 0, parts: [0, 0] },
    { label: 'Tue', total: 30, parts: [20, 10] },
    { label: 'Wed', total: 12, parts: [12, 0] },
  ]

  const columns = (): void =>
    mount(
      <DayColumns
        buckets={BUCKETS}
        series={SERIES}
        format={(value) => `$${value.toFixed(2)}`}
        label="Spend per day"
      />,
    )

  const announced = (): string =>
    (container.querySelector('[aria-live]') as HTMLElement).textContent ?? ''

  it('is readable without a mouse, and announces where the cursor lands', () => {
    columns()
    press('ArrowRight')
    press('ArrowRight')
    expect(announced()).toBe('Tue: $30.00')
  })

  it('walks to the ends and stops there rather than wrapping', () => {
    columns()
    press('End')
    expect(announced()).toBe('Wed: $12.00')
    press('ArrowRight')
    expect(announced()).toBe('Wed: $12.00')
    press('Home')
    expect(announced()).toBe('Mon: Nothing spent')
  })

  it('names a quiet day rather than showing an empty breakdown', () => {
    columns()
    press('Home')
    expect(tip()?.textContent).toContain('Nothing spent')
    expect(tip()?.textContent).not.toContain('Alpha')
  })

  it('leaves a series out of the tip on a day it spent nothing', () => {
    columns()
    press('End')
    expect(tip()?.textContent).toContain('Alpha')
    // Beta spent nothing on Wednesday: a `$0.00` row would be a fact nobody
    // needs in a tip that has to be read at a glance.
    expect(tip()?.textContent).not.toContain('Beta')
  })

  it('totals the day only where there is more than one series to total', () => {
    columns()
    press('ArrowRight')
    press('ArrowRight')
    expect(tip()?.textContent).toContain('Total')
    expect(tip()?.textContent).toContain('$30.00')
  })

  it('escape puts the cursor away', () => {
    columns()
    press('ArrowRight')
    expect(tip()).not.toBeNull()
    press('Escape')
    expect(tip()).toBeNull()
  })

  /**
   * The Dashboard closes itself on a document-level Escape, so the key that
   * dismisses this cursor used to shut the whole window behind it. The
   * containment has to be narrow: only the Escape that actually dismissed
   * something is swallowed, and every other key still reaches the screen.
   */
  const withDocumentKeys = (run: (heard: string[]) => void): void => {
    const heard: string[] = []
    const listener = (event: Event): void => void heard.push((event as KeyboardEvent).key)
    document.addEventListener('keydown', listener)
    try {
      run(heard)
    } finally {
      document.removeEventListener('keydown', listener)
    }
  }

  it('keeps a dismissing Escape to itself, and lets every other key past', () => {
    withDocumentKeys((heard) => {
      columns()
      press('ArrowRight')
      press('Escape')
      expect(tip()).toBeNull()
      // The walk reaches the screen; the dismissal does not.
      expect(heard).toEqual(['ArrowRight'])
    })
  })

  it('lets an Escape through when there is no cursor to dismiss', () => {
    // An Escape on a chart nobody is pointing at belongs to the screen.
    withDocumentKeys((heard) => {
      columns()
      press('Escape')
      expect(heard).toEqual(['Escape'])
    })
  })

  it('carries the whole series as text, so the chart is not its only copy', () => {
    columns()
    const list = container.querySelector('ul.sr-only') as HTMLElement
    expect(list.textContent).toContain('Mon: Nothing spent')
    expect(list.textContent).toContain('Tue: $30.00')
    expect(list.textContent).toContain('Wed: $12.00')
  })

  it('draws no column at all on a day nothing was spent', () => {
    columns()
    const stacks = [...plot().children].map(
      (column) => (column.firstElementChild as HTMLElement).style.height,
    )
    expect(stacks[0]).toBe('0%')
    expect(stacks[1]).toBe('100%')
  })

  it('draws a day before coverage hatched, and its tip says so rather than $0', () => {
    mount(
      <DayColumns
        buckets={[{ label: 'Mon', total: 0, parts: [0, 0], unknown: true }, ...BUCKETS.slice(1)]}
        series={SERIES}
        format={(value) => `$${value.toFixed(2)}`}
        label="Spend per day"
      />,
    )
    press('Home')
    expect(tip()?.textContent).toContain('No record yet')
    expect(tip()?.textContent).not.toContain('$0.00')
    const column = plot().children[0] as HTMLElement
    expect((column.firstElementChild as HTMLElement).style.background).toContain('--hd-chart-heat-not-scanned')
  })

  it('marks today with a dashed outline in bars mode', () => {
    mount(
      <DayColumns
        buckets={BUCKETS}
        series={SERIES}
        format={(value) => `$${value.toFixed(2)}`}
        label="Spend per day"
        today={2}
      />,
    )
    const column = plot().children[2] as HTMLElement
    expect((column.firstElementChild as HTMLElement).className).toContain('outline-dashed')
  })

  it('draws a dashed ghost line for the previous period and reads it in the tip', () => {
    mount(
      <DayColumns
        buckets={BUCKETS}
        series={SERIES}
        format={(value) => `$${value.toFixed(2)}`}
        label="Spend per day"
        ghost={[5, 40, 8]}
      />,
    )
    press('ArrowRight')
    press('ArrowRight')
    expect(tip()?.textContent).toContain('Previous')
    expect(tip()?.textContent).toContain('$40.00')
    const ghostPath = container.querySelector('svg path[stroke-dasharray]')
    expect(ghostPath).not.toBeNull()
  })

  it('draws an area line rather than columns in line mode', () => {
    mount(
      <DayColumns
        buckets={BUCKETS}
        series={SERIES}
        format={(value) => `$${value.toFixed(2)}`}
        label="Spend per day"
        mode="line"
      />,
    )
    expect(container.querySelector('svg path[stroke="var(--hd-accent)"]')).not.toBeNull()
    // No stacked bar column in line mode.
    expect(container.querySelector('.flex-col-reverse')).toBeNull()
  })

  it('draws a y-axis of three round ticks when given one', () => {
    mount(
      <DayColumns
        buckets={BUCKETS}
        series={SERIES}
        format={(value) => `$${value.toFixed(0)}`}
        label="Spend per day"
        axisTicks={[0, 25, 50]}
      />,
    )
    const gutter = container.querySelector('[aria-hidden].flex.flex-col') as HTMLElement
    expect(gutter?.textContent).toBe('$50$25$0')
  })
})

describe('PaceBadge', () => {
  const badge = (): HTMLElement =>
    container.querySelector('[data-slot="pace-badge"]') as HTMLElement

  it('signs the margin and says the word beside it', () => {
    mount(<PaceBadge status="overPace" margin={-33} word="over pace" tone="warning" />)
    expect(badge().textContent).toContain('−33%')
    expect(badge().textContent).toContain('over pace')
  })

  it('drops the number on a window that is full or spent', () => {
    mount(<PaceBadge status="spent" word="spent" tone="danger" />)
    expect(badge().textContent).toContain('spent')
    expect(badge().textContent).not.toMatch(/\d/)
  })
})

describe('tintsFor', () => {
  it('gives a set of series colours nobody in it shares', () => {
    // The three agents this shipped against: two of them hash to the same
    // hue, which drew a doughnut with two wedges the same colour.
    const keys = ['claude', 'codex', 'cursor']
    expect(new Set(tintsFor(keys)).size).toBe(keys.length)
  })

  it('is stable for the same set, so a chart does not re-colour on a refresh', () => {
    const keys = ['claude', 'codex', 'cursor']
    // Two calls compared to each other. This reads like a tautology and is not
    // one: `tintsFor` is only pure by construction, and the assignment walks a
    // shared `taken` set. Hoist that set out of the function and this line
    // fails — which is the whole class of bug "does not re-colour" is about.
    expect(tintsFor(keys)).toEqual(tintsFor(keys))

    // What two adjacent calls cannot see: state that survives *other* sets
    // being drawn between them, which is what a refresh actually looks like
    // when several charts share the module.
    const first = tintsFor(keys)
    tintsFor(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
    tintsFor(['claude'])
    expect(tintsFor(keys)).toEqual(first)
  })

  it('gives a member the same hue however the caller sorted the set', () => {
    // Both callers order by spend, and the range control re-sorts them. When
    // the assignment walked the array as given, two agents swapped colours in
    // the legend the moment one overtook the other.
    const keys = ['claude', 'codex', 'cursor']
    const byName = new Map(keys.map((key, index) => [key, tintsFor(keys)[index]]))
    const reversed = [...keys].reverse()
    for (const [index, key] of reversed.entries()) {
      expect(tintsFor(reversed)[index]).toBe(byName.get(key))
    }
  })

  it('ignores a repeated key rather than spending a second hue on it', () => {
    expect(tintsFor(['codex', 'codex'])).toEqual([tintFor('codex'), tintFor('codex')])
  })

  it('agrees with tintFor wherever there is nothing to collide with', () => {
    expect(tintsFor(['codex'])[0]).toBe(tintFor('codex'))
  })

  it('keeps answering past the end of the palette', () => {
    const keys = Array.from({ length: TINTS.length + 3 }, (_, index) => `series-${index}`)
    expect(tintsFor(keys)).toHaveLength(keys.length)
    expect(tintsFor(keys).every((tint) => TINTS.includes(tint))).toBe(true)
  })
})

describe('series marks', () => {
  it('names a kind by tone or by tint, with one dot for both', () => {
    mount(
      <>
        <SeriesDot tint="violet" />
        <SeriesDot tone="success" />
        <ChartKeys>
          <ChartKey tone="brand" label="Response" />
          <ChartKey tint="orange" label="Command" />
        </ChartKeys>
      </>,
    )
    const dots = [...container.querySelectorAll<HTMLElement>('[data-slot="series-dot"]')]
    expect(dots).toHaveLength(4)
    expect(dots[0]?.dataset['tint']).toBe('violet')
    expect(dots[0]?.className).toContain('bg-(--hd-tint-violet-ink)')
    expect(dots[1]?.dataset['tone']).toBe('success')
    expect(dots[1]?.className).toContain('bg-(--hd-success)')
    expect(dots[2]?.dataset['tone']).toBe('brand')
    expect(dots[3]?.dataset['tint']).toBe('orange')
    /* One size and one shape, whichever vocabulary coloured it. */
    for (const dot of dots) expect(dot.className).toContain('size-2')
  })
})

describe('ChartTip', () => {
  it('places itself along a plot, or leaves the placing to its owner', () => {
    mount(
      <>
        <ChartTip at={0.5}>On the plot</ChartTip>
        <ChartTip>Beside a rail</ChartTip>
      </>,
    )
    const [plotted, owned] = [...container.querySelectorAll<HTMLElement>('[data-slot="chart-tip"]')]
    expect(plotted?.style.left).toBe('50%')
    expect(plotted?.className).toContain('bottom-full')
    expect(owned?.dataset['placement']).toBe('owner')
    expect(owned?.getAttribute('style')).toBeNull()
    expect(owned?.className).not.toContain('bottom-full')
    expect(plotted?.tagName).toBe('DIV')
    /* The plate is the same either way. */
    expect(owned?.className).toContain('bg-(--hd-popover)')
    expect(owned?.className).toContain('shadow-(--hd-shadow)')
  })
})

describe('ChartTip inside a control', () => {
  it('is a span, so a button around it holds only phrasing content', () => {
    mount(<button type="button"><ChartTip as="span">First words</ChartTip></button>)
    const tip = container.querySelector('[data-slot="chart-tip"]')
    expect(tip?.tagName).toBe('SPAN')
    expect(container.querySelector('button div')).toBeNull()
  })
})
