import type { JSX } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import * as Icons from './Icons'

/**
 * The icon set is one system: every glyph is Lucide, reached through this
 * module. These tests hold that line — a hand-drawn `<svg>` or a `✓` typed
 * into a component would pass the type-checker and quietly fork the set.
 */

const exported = Object.entries(Icons).filter(
  (entry): entry is [string, (props: Icons.IconProps) => JSX.Element] =>
    entry[0].endsWith('Icon') && typeof entry[1] === 'function',
)

describe('Icons', () => {
  it('exports at least the set the renderer was built on', () => {
    expect(exported.length).toBeGreaterThan(60)
  })

  it.each(exported)('%s is a Lucide glyph on currentColor, hidden from readers', (_name, Icon) => {
    const markup = renderToStaticMarkup(<Icon />)
    expect(markup).toMatch(/^<svg /)
    expect(markup).toContain('class="lucide lucide-')
    expect(markup).toContain('stroke="currentColor"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('focusable="false"')
  })

  it('defaults to 16px and takes a size', () => {
    expect(renderToStaticMarkup(<Icons.CheckIcon />)).toContain('width="16" height="16"')
    expect(renderToStaticMarkup(<Icons.CheckIcon size={12} />)).toContain('width="12" height="12"')
  })

  it('passes className and other SVG props through', () => {
    const markup = renderToStaticMarkup(<Icons.ChevronIcon className="chev" data-open="" />)
    expect(markup).toContain('lucide-chevron-right chev')
    expect(markup).toContain('data-open=""')
  })

  it('draws the stop glyph filled', () => {
    expect(renderToStaticMarkup(<Icons.StopIcon />)).toContain('fill="currentColor"')
  })

  it('gives each meaning its own glyph where the UI relies on the difference', () => {
    const glyph = (Icon: (props: Icons.IconProps) => JSX.Element): string =>
      renderToStaticMarkup(<Icon />).match(/lucide-([a-z0-9-]+)/)?.[1] ?? ''
    // Tool calls and plugins, worktrees and diffs, reasoning and sub-agents
    // each used to share a drawing.
    expect(glyph(Icons.ToolIcon)).not.toBe(glyph(Icons.PluginIcon))
    expect(glyph(Icons.BranchIcon)).not.toBe(glyph(Icons.DiffIcon))
    expect(glyph(Icons.BrainIcon)).not.toBe(glyph(Icons.AgentIcon))
    expect(glyph(Icons.FileIcon)).not.toBe(glyph(Icons.ImageIcon))
    // Zooming a page and searching one both want a magnifier; the browser
    // pane's ⋮ menu offers all three in a row, so they must not agree.
    expect(glyph(Icons.ZoomInIcon)).not.toBe(glyph(Icons.SearchIcon))
    expect(glyph(Icons.ZoomInIcon)).not.toBe(glyph(Icons.ZoomOutIcon))
    // Filtering the session list, searching everything, and that list's own
    // options sit within a row of each other in the sidebar's title row.
    expect(glyph(Icons.FilterIcon)).not.toBe(glyph(Icons.SearchIcon))
    expect(glyph(Icons.FilterIcon)).not.toBe(glyph(Icons.SlidersIcon))
    // Where a conversation runs, said by the glyph alone once a narrow toolbar
    // or header drops the words: the main checkout, a worktree, and one still
    // to be made. The last two once differed by colour only, which is no
    // difference at all to some readers.
    expect(glyph(Icons.LocalIcon)).not.toBe(glyph(Icons.BranchIcon))
    expect(glyph(Icons.NewWorktreeIcon)).not.toBe(glyph(Icons.BranchIcon))
    expect(glyph(Icons.NewWorktreeIcon)).not.toBe(glyph(Icons.LocalIcon))
  })
})

describe('the renderer draws icons only through Icons.tsx and BrandIcons.tsx', () => {
  // Every renderer source, read as text at transform time — the renderer has
  // no filesystem, and the layering rule keeps node builtins out of it.
  // BrandIcons.tsx is the one other module allowed an <svg>: it wraps
  // lobe-icons' company marks on the same terms, and has its own tests.
  const sources = import.meta.glob<string>('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })
  // GitPane draws the commit graph, and spark.tsx and chart.tsx draw the
  // charts — per the audit's own carve-out these are drawings, not icons: a
  // path computed from an array of numbers has no place in a glyph set, there
  // is no icon set it could be imported from, and swapping the icon set must
  // not change a chart. All three are excluded here on the terms the design
  // audit records them under. AppearancePreview draws the three theme
  // miniatures — a picture of a window in each face, which no token-driven
  // render can produce inside a window wearing the other face — and is an
  // illustration on the same terms.
  const others = Object.entries(sources).filter(
    ([path]) =>
      !/\/(Brand)?Icons\.tsx$/.test(path) &&
      !/\/GitPane\.tsx$/.test(path) &&
      !/\/AppearancePreview\.tsx$/.test(path) &&
      !/\/design\/ui\/(spark|chart)\.tsx$/.test(path) &&
      !/\.test\.tsx?$/.test(path),
  )
  const offending = (pattern: RegExp): string[] => others.filter(([, text]) => pattern.test(text)).map(([path]) => path)

  it('sees the renderer', () => {
    expect(others.length).toBeGreaterThan(50)
  })

  it('has no hand-drawn <svg> outside them', () => {
    expect(offending(/<svg[\s>]/)).toEqual([])
  })

  it('has no glyph characters standing in for icons', () => {
    // Marks that used to be typed into JSX: check, ring, chevron, bullet dot.
    expect(offending(/['"`{]\s*[✓○◯›▸▾•]\s*['"`}]/)).toEqual([])
  })
})
