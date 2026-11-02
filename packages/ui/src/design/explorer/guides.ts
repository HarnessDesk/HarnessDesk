import { useEffect, useSyncExternalStore } from 'react'

import { colorName, lengthName, offScaleOf, readTokens, type TokenTable } from './guides-tokens'

/**
 * Guides: the lines a designer draws over a screen to see whether anything was
 * placed by eye.
 *
 * A page is one root — a preview `Frame`, or the explorer's current board —
 * and every measurement stays inside it, so two specimens side by side never
 * lend each other a rail. Within a root the guides answer four questions:
 *
 *   boxes     where every component, control and heading actually is;
 *   rails     which edges line up (three or more edges at one coordinate draw
 *             a line through the page) and which edges *nearly* do — an edge
 *             0.5–3px off a rail is the signature of a value typed by hand;
 *   gaps      what space separates neighbours, as a number on the gap;
 *   overflow  what spills past its box, is clipped without an ellipsis,
 *             leaves its page, or sets text flush against the edge of the
 *             card or fill around it (no padding anywhere between, so the
 *             words reach the border whenever they wrap that way);
 *   scale     which values no token names — a padding, gap, radius, type
 *             size or colour the system never decided.
 *
 * Hovering adds the redline: the element's four edges extended across the
 * page, its padding, its size and type — each named by the token behind it —
 * and its distance to its parent. Shift pins the hovered element; hovering
 * another then measures between the two.
 *
 * It is a drawing on one fixed canvas that takes no pointer events, so the
 * screen under it behaves exactly as it does without it. Colours are read from
 * the tokens at draw time, so the guides follow the theme being inspected.
 */

export type GuidesMode = 'off' | 'boxes' | 'lines' | 'all'
export const GUIDES_MODES: readonly GuidesMode[] = ['off', 'boxes', 'lines', 'all']

type Layer = 'grid' | 'boxes' | 'rails' | 'gaps' | 'overflow' | 'scale' | 'inspect'
const LAYERS: Record<GuidesMode, readonly Layer[]> = {
  off: [],
  boxes: ['boxes', 'overflow', 'inspect'],
  lines: ['grid', 'rails', 'overflow', 'scale', 'inspect'],
  all: ['grid', 'boxes', 'rails', 'gaps', 'overflow', 'scale', 'inspect'],
}

/** What counts as a thing placed on the page. */
const PLACED = [
  '[data-slot]', 'h1', 'h2', 'h3', 'h4', 'button', 'a[href]', 'input', 'textarea', 'select',
  '[role="menuitem"]', '[role="tab"]', '[role="img"]', '[data-menu-row]', 'img', 'svg',
].join(',')
const CONTROL = 'button, a[href], input, textarea, select, [role="switch"], [role="checkbox"], [role="tab"], [data-slot$="trigger"], [data-menu-row]'
/**
 * A box that crops what it holds on purpose.
 *
 * A face's plate draws a brand picture larger than the plate so the plate's
 * own corner is the picture's frame. That picture is not content lost past an
 * edge — it is the drawing — so the box says so and the overflow clip/spill
 * findings leave it alone. It is still a box like any other: off the page or
 * on the frame's edge is still reported. Nothing else earns the attribute:
 * text cut off without an ellipsis is still a finding.
 */
const CROP = '[data-crop]'
const TEXT = 'h1, h2, h3, h4, [data-slot="text"], [data-slot="row-title"], [data-slot="label"], [data-slot$="title"], [data-slot$="description"]'

/** Past this many boxes a root is sampled, not drawn whole. */
const PER_ROOT = 1500
/** An edge this close to a rail, and not on it, was placed by eye. */
const NEAR_MISS = 3
const ON_RAIL = 0.5
const RAIL_MIN = 3
const GAP_MAX = 48
const GRID = 4
const GRID_MAJOR = 16

type Box = { el: Element; r: DOMRect; kind: 'container' | 'control' | 'text' | 'glyph' }
type Palette = Record<'accent' | 'control' | 'text' | 'pad' | 'danger' | 'warn' | 'gap' | 'grid' | 'ink' | 'paper', string>

const readPalette = (): Palette => {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden'
  document.body.append(probe)
  const read = (token: string) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  const palette: Palette = {
    accent: read('--hd-accent'),
    control: read('--hd-tint-violet-edge'),
    text: read('--hd-tint-amber-edge'),
    pad: read('--hd-success'),
    danger: read('--hd-danger'),
    warn: read('--hd-warning'),
    gap: read('--hd-tint-rose-edge'),
    grid: read('--hd-border'),
    ink: read('--hd-accent-foreground'),
    paper: read('--hd-foreground'),
  }
  probe.remove()
  return palette
}

/* Past a pixel: a screen-reader-only node is 1×1 and is not placed. */
const visible = (r: DOMRect) => r.width > 1.5 && r.height > 1.5
const meets = (a: DOMRect, b: DOMRect) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
const round = (n: number) => Math.round(n * 2) / 2
const paintedColor = (color: string) => Boolean(color) && color !== 'transparent'
  && !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color) && !/\/\s*0(?:\.0+)?\s*\)$/.test(color)
const paintsBox = (style: CSSStyleDeclaration) => paintedColor(style.backgroundColor)
  || Boolean(style.backgroundImage && style.backgroundImage !== 'none')
  || Boolean(style.boxShadow && style.boxShadow !== 'none')
  || ['left', 'right', 'top', 'bottom'].some(side => (parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0) > 0
    && !['none', 'hidden'].includes(style.getPropertyValue(`border-${side}-style`)) && paintedColor(style.getPropertyValue(`border-${side}-color`)))

const kindOf = (el: Element): Box['kind'] =>
  el.matches('svg, img, [role="img"]') ? 'glyph' : el.matches(CONTROL) ? 'control' : el.matches(TEXT) ? 'text' : 'container'

/** An element is on the page only where every clipping ancestor lets it be. */
const shown = (el: Element, r: DOMRect, root: Element) => {
  if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
  for (let up = el.parentElement; up && up !== root.parentElement; up = up.parentElement) {
    const style = getComputedStyle(up)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    if (!meets(r, up.getBoundingClientRect())) return false
  }
  return true
}

export const collect = (root: Element, view: DOMRect): Box[] => {
  const out: Box[] = []
  for (const el of root.querySelectorAll(PLACED)) {
    const image = el.closest('svg, [role="img"]')
    if (image && image !== el) continue
    // The preview's own caption names the page; it is not on it.
    if (el.closest('[data-preview-caption]')) continue
    const r = el.getBoundingClientRect()
    if (!visible(r) || !meets(r, view) || !shown(el, r, root)) continue
    out.push({ el, r, kind: kindOf(el) })
    if (out.length >= PER_ROOT) break
  }
  return out
}

/**
 * Edges that three or more boxes share, per axis. Starts count for every
 * box; ends only for boxes whose end is placed (a control, a container) —
 * a line of text ends wherever its words do.
 */
export const railsOf = (boxes: Box[]) => {
  const count = (edges: { at: number; el: Element }[]) => {
    const owners = new Map<number, Set<Element>>()
    for (const { at, el } of edges) {
      const coordinate = round(at)
      const peers = owners.get(coordinate) ?? new Set<Element>()
      peers.add(el)
      owners.set(coordinate, peers)
    }
    return [...owners].filter(([, peers]) => {
      // A badge or control may have several nested wrappers at one edge.
      // Only its deepest owner counts; three actual sibling placements
      // still form a rail, even when their common parent shares it too.
      const candidates = [...peers]
      const independent = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)))
      return independent.length >= RAIL_MIN
    }).map(([at]) => at)
  }
  const placed = boxes.filter((one) => one.kind !== 'glyph')
  const ends = placed.filter((one) => one.kind !== 'text')
  return {
    x: count([...placed.map(({ el, r }) => ({ el, at: r.left })), ...ends.map(({ el, r }) => ({ el, at: r.right }))]),
    y: count([...ends.map(({ el, r }) => ({ el, at: r.top })), ...ends.map(({ el, r }) => ({ el, at: r.bottom }))]),
  }
}

const nearest = (value: number, rails: number[]) => {
  let best: number | null = null
  for (const rail of rails) if (best === null || Math.abs(rail - value) < Math.abs(best - value)) best = rail
  return best
}

/**
 * Starts that nearly share a rail. Only the horizontal axis is judged: items
 * of different heights centred in one row differ at the top by design, and
 * that is not a misplacement.
 */
type Miss = { box: Box; at: number; rail: number }
export const missesOf = (boxes: Box[], rails: { x: number[] }): Miss[] => {
  const out: Miss[] = []
  const borders = new Map<Element, Map<'left' | 'right', number>>()
  const styles = new Map<Element, CSSStyleDeclaration>()
  const styleOf = (el: Element) => {
    let style = styles.get(el)
    if (!style) { style = getComputedStyle(el); styles.set(el, style) }
    return style
  }
  const rects = new Map(boxes.map(box => [box.el, box.r]))
  const railOwners = new Map<number, Box[]>()
  const ownersOf = (rail: number) => {
    let owners = railOwners.get(rail)
    if (!owners) {
      owners = boxes.filter(one => one.kind !== 'glyph' && (round(one.r.left) === rail || one.kind !== 'text' && round(one.r.right) === rail))
      railOwners.set(rail, owners)
    }
    return owners
  }
  const independentCount = (owners: Box[]) => owners.filter(one => !owners.some(other => one.el !== other.el && one.el.contains(other.el))).length
  const realms = new Map<Element, Element | null>()
  const realmOf = (el: Element): Element | null => {
    if (realms.has(el)) return realms.get(el)!
    let realm: Element | null = null
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const transform = styleOf(parent).transform
      if (transform && transform !== 'none') realm = parent
    }
    realms.set(el, realm)
    return realm
  }
  const peerCounts = new Map<Element, Map<string, number>>()
  const localCount = (rail: number, scope: Element, ownership: 'contains' | 'realm' = 'contains'): number => {
    let counts = peerCounts.get(scope)
    if (!counts) { counts = new Map(); peerCounts.set(scope, counts) }
    const key = `${ownership}:${rail}`
    const known = counts.get(key)
    if (known !== undefined) return known
    const count = independentCount(ownersOf(rail).filter(owner => ownership === 'realm'
      ? realmOf(owner.el) === scope : scope.contains(owner.el)))
    counts.set(key, count)
    return count
  }
  const anchors = new Map<Element, Element | null>()
  const endAnchorOf = (el: Element): Element | null => {
    if (anchors.has(el)) return anchors.get(el)!
    for (let item: Element | null = el; item?.parentElement; item = item.parentElement) {
      const parent: HTMLElement = item.parentElement
      const style = styleOf(parent)
      if (!style.display.includes('flex') || style.flexDirection.startsWith('column')) continue
      const siblings: Element[] = [...parent.children].filter(child => styleOf(child).display !== 'none' && !['absolute', 'fixed'].includes(styleOf(child).position))
      if (siblings.at(-1) !== item || siblings.length < 2) continue
      const before = siblings.slice(0, -1)
      // Resolved margins may be pixels even when the CSS value is `auto`.
      // Typed OM preserves that keyword; an ordinary positive gap is not
      // evidence that a flex item is anchored at the end.
      const typed = typeof item.computedStyleMap === 'function' ? item.computedStyleMap() : null
      const autoStart = typed?.get('margin-inline-start')?.toString() === 'auto'
        || styleOf(item).marginInlineStart === 'auto'
        || (style.direction !== 'rtl' && styleOf(item).marginLeft === 'auto')
      const pushed = before.some(child => (parseFloat(styleOf(child).flexGrow) || 0) > 0)
        || autoStart
        || ['end', 'flex-end', 'space-between'].includes(style.justifyContent)
      if (pushed && (parseFloat(styleOf(item).flexGrow) || 0) === 0) {
        anchors.set(el, item)
        return item
      }
    }
    anchors.set(el, null)
    return null
  }
  const controlGroups = new Map<Element, Element | null>()
  const controlGroupOf = (el: Element): Element | null => {
    if (controlGroups.has(el)) return controlGroups.get(el)!
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = styleOf(parent)
      if (!style.display.includes('flex')) continue
      const children = [...parent.children].filter(child => {
        const r = rects.get(child) ?? child.getBoundingClientRect()
        const s = styleOf(child)
        return visible(r) && s.display !== 'none' && s.visibility !== 'hidden' && !['absolute', 'fixed'].includes(s.position)
      })
      if (children.length < 2 || children.some(child => !child.matches(CONTROL) || (parseFloat(styleOf(child).flexGrow) || 0) > 0)) continue
      const widths = children.map(child => (rects.get(child) ?? child.getBoundingClientRect()).width)
      const content = style.flexDirection.startsWith('column') ? Math.max(...widths)
        : widths.reduce((sum, width) => sum + width, 0) + (parseFloat(style.columnGap) || 0) * (children.length - 1)
      const expected = content + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
        + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)
      const width = (rects.get(parent) ?? parent.getBoundingClientRect()).width
      if (Math.abs(width - expected) <= ON_RAIL) { controlGroups.set(el, parent); return parent }
    }
    controlGroups.set(el, null)
    return null
  }
  const columnScopes = new Map<number, Element | null>()
  const columnScopeOf = (rail: number) => {
    if (columnScopes.has(rail)) return columnScopes.get(rail)!
    const owners = ownersOf(rail)
    const scope = owners[0]?.el.closest('table, dl, [role="table"], [role="grid"], [role="treegrid"]') ?? null
    const r = scope?.getBoundingClientRect()
    // Column boundaries belong to their table or definition list. Outer edges can
    // still align a toolbar, and an outside owner makes a shared page rail.
    const internal = scope && r && rail > round(r.left) && rail < round(r.right)
      && owners.every(owner => owner.el.closest('table, dl, [role="table"], [role="grid"], [role="treegrid"]') === scope)
    columnScopes.set(rail, internal ? scope : null)
    return internal ? scope : null
  }
  const drawnBorder = (el: Element, side: 'left' | 'right'): number => {
    const known = borders.get(el)?.get(side)
    if (known !== undefined) return known
    const style = styleOf(el)
    const color = style.getPropertyValue(`border-${side}-color`)
    const transparent = color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color)
    const line = style.getPropertyValue(`border-${side}-style`)
    const width = line === 'none' || line === 'hidden' || transparent
      ? 0 : parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0
    const cache = borders.get(el) ?? new Map<'left' | 'right', number>()
    cache.set(side, width)
    borders.set(el, cache)
    return width
  }
  const drawnLeftBorder = (el: Element) => drawnBorder(el, 'left')
  const ownsBorderInset = (box: Box, at: number, rail: number): boolean => {
    if (box.kind !== 'container' || at !== box.r.left) return false
    const border = drawnLeftBorder(box.el)
    if (border === 0 || rail !== round(at + border)) return false
    // A frame's painted border and its content edge are deliberately apart.
    // Identical peer frames share that inset too. Every owner of this rail
    // must live inside one of those frames; an independent sibling keeps it
    // a real alignment diagnostic, and controls are never excused here.
    const frames = boxes.filter(one => one.kind === 'container' && one.r.left === at && drawnLeftBorder(one.el) === border)
    const owners = ownersOf(rail)
    return owners.length >= RAIL_MIN && owners.every(owner => frames.some(frame => frame.el !== owner.el && frame.el.contains(owner.el)))
  }
  const sitsInsideBorder = (box: Box, at: number, rail: number): boolean => {
    if (box.kind !== 'container') return false
    const side = at === box.r.left ? 'left' : at === box.r.right ? 'right' : null
    if (!side) return false
    for (let parent = box.el.parentElement; parent; parent = parent.parentElement) {
      const border = drawnBorder(parent, side)
      if (!border) continue
      const r = rects.get(parent) ?? parent.getBoundingClientRect()
      if (side === 'left' ? rail === round(r.left) && round(at) === round(r.left + border)
        : rail === round(r.right) && round(at) === round(r.right - border)) return true
    }
    return false
  }
  const atContentEdge = (el: Element, at: number, side: 'left' | 'right'): boolean => {
    const r = rects.get(el) ?? el.getBoundingClientRect()
    const style = styleOf(el)
    const layoutWidth = (el as HTMLElement).offsetWidth
    const scale = layoutWidth > 0 ? r.width / layoutWidth : 1
    const inset = side === 'left'
      ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0)
      : (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderRightWidth) || 0)
    return Math.abs(at - (side === 'left' ? r.left + inset * scale : r.right - inset * scale)) <= ON_RAIL
  }
  const insetOwners = new Map<number, { scope: Element; outside: number } | null>()
  const insetOwnerOf = (rail: number) => {
    if (insetOwners.has(rail)) return insetOwners.get(rail)!
    const owners = ownersOf(rail)
    let scope = owners[0]?.el.parentElement ?? null
    while (scope && !owners.every(owner => scope!.contains(owner.el))) scope = scope.parentElement
    const r = scope ? rects.get(scope) ?? scope.getBoundingClientRect() : null
    const internal = scope && r && rail > round(r.left) && rail < round(r.right)
    const owner = scope && r && internal && atContentEdge(scope, rail, 'left') ? { scope, outside: r.left }
      : scope && r && internal && atContentEdge(scope, rail, 'right') ? { scope, outside: r.right } : null
    insetOwners.set(rail, owner)
    return owner
  }
  const borrowedEnds = new Set<Element>()
  for (const box of boxes) {
    if (box.kind === 'glyph') continue
    const anchor = endAnchorOf(box.el)
    if (anchor === box.el && anchor.parentElement && rects.has(anchor.parentElement) && atContentEdge(anchor.parentElement, box.r.right, 'right')) borrowedEnds.add(anchor.parentElement)
  }
  const ownsInsetContent = (box: Box, rail: number): boolean => {
    if (box.kind !== 'container' || paintsBox(styleOf(box.el))) return false
    let at = box.el, inset = 0
    while (at.children.length === 1) {
      const child = at.children[0]!
      if (child.matches(CONTROL)) return false
      const parentRect = rects.get(at) ?? at.getBoundingClientRect()
      const childRect = rects.get(child) ?? child.getBoundingClientRect()
      const layoutWidth = (at as HTMLElement).offsetWidth
      const scale = layoutWidth > 0 ? parentRect.width / layoutWidth : 1
      const style = styleOf(at)
      const padding = ((parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0)) * scale
      if (Math.abs(childRect.left - parentRect.left - padding) > ON_RAIL) return false
      inset += padding
      if (rects.has(child) && kindOf(child) === 'text') return inset > 0 && round(childRect.left) === rail
      at = child
    }
    return false
  }
  for (const box of boxes) {
    if (box.kind === 'glyph') continue
    const header = box.el.closest('header, [role="banner"], [role="radiogroup"], [role="tablist"], [role="toolbar"]')
    const headerRect = header ? rects.get(header) ?? header.getBoundingClientRect() : null
    const columns = box.el.closest('table, dl, [role="table"], [role="grid"], [role="treegrid"]')
    const columnsRect = columns ? rects.get(columns) ?? columns.getBoundingClientRect() : null
    const realm = realmOf(box.el)
    const anchor = endAnchorOf(box.el)
    const controls = controlGroupOf(box.el)
    const controlsRect = controls ? rects.get(controls) ?? controls.getBoundingClientRect() : null
    const edges = anchor === box.el ? [box.r.right] : box.kind === 'control' || borrowedEnds.has(box.el) ? [box.r.left, box.r.right] : [box.r.left]
    for (const at of edges) {
      // A flex-end item is positioned by its parent's content end. The
      // declared padding is not a near miss against an unrelated column;
      // moving it a pixel away still goes through the ordinary rail check.
      if (anchor === box.el && anchor.parentElement && rects.has(anchor.parentElement) && atContentEdge(anchor.parentElement, at, 'right')) continue
      const rail = nearest(at, rails.x.filter(one => {
        const inset = insetOwnerOf(one)
        // A sibling exactly aligned with a frame's outside edge is not
        // misplaced against its declared content inset. Other outsiders,
        // including a control shifted a pixel off that inset, still compare.
        if (inset && (inset.scope === box.el || !inset.scope.contains(box.el))
          && Math.abs(at - inset.outside) <= ON_RAIL) return false
        const scope = columnScopeOf(one)
        if (scope && !scope.contains(box.el)) return false
        const owners = ownersOf(one)
        // A transformed world (a panned/scaled drawing, for example) owns
        // its coordinates. It still diagnoses local peer misalignment, but
        // does not lend its interior rails to the surrounding page.
        if (realm && localCount(one, realm, 'realm') < RAIL_MIN) return false
        const ownerRealm = owners[0] ? realmOf(owners[0].el) : null
        if (!realm && ownerRealm && owners.every(owner => realmOf(owner.el) === ownerRealm)) return false
        if (columns && columns !== box.el && columnsRect && one !== round(columnsRect.left) && one !== round(columnsRect.right)
          && localCount(one, columns) < RAIL_MIN) return false
        // Headers and semantic composite controls have their own internal alignment. Its outer edge
        // remains available to the page, and independent inner peers still
        // diagnose a shifted title or control inside the same header.
        if (header && header !== box.el && headerRect && one !== round(headerRect.left) && one !== round(headerRect.right)
          && localCount(one, header) < RAIL_MIN) return false
        // An intrinsic item pushed after a growing flex sibling is anchored
        // at its end. Its variable text starts belong to that item, rather
        // than lending rails to other end-aligned labels of different widths.
        if (anchor && anchor !== box.el
          && localCount(one, anchor) < RAIL_MIN) return false
        // A shrink-wrapped group made only of controls owns their internal
        // spacing. Its own outer box still participates in page alignment.
        if (controls && controlsRect && one !== round(controlsRect.left) && one !== round(controlsRect.right)
          && localCount(one, controls) < RAIL_MIN) return false
        return true
      }))
      if (rail === null) continue
      // A composite's first/last control occupies its declared content
      // inset, while the composite's outside edge remains a page rail.
      if (box.kind === 'control' && header && header !== box.el && headerRect && (
        at === box.r.left && rail === round(headerRect.left) && atContentEdge(header, at, 'left')
        || at === box.r.right && rail === round(headerRect.right) && atContentEdge(header, at, 'right')
      )) continue
      const off = Math.abs(rail - at)
      if (off > ON_RAIL && off <= NEAR_MISS && !ownsBorderInset(box, at, rail) && !sitsInsideBorder(box, at, rail)
        && !(at === box.r.left && ownsInsetContent(box, rail))) out.push({ box, at, rail })
    }
  }
  return out
}

/**
 * A row's control slot or an explicitly marked unpainted action slot lets
 * `Button edge` put its glyph on the content inset by crossing the slot by
 * its pull. That is the design, not a spill, only within that exact margin;
 * the painted card around the slot is still measured on its own.
 */
export const pulledInSlot = (kid: Element, el: Element, k: Pick<DOMRect, 'left' | 'right' | 'bottom'>, r: Pick<DOMRect, 'left' | 'right' | 'bottom'>) => {
  const pulled = kid.closest('[style*="--edge-pull"]')
  if (!pulled || !el.contains(pulled)) return false
  const slot = pulled.closest('[data-slot="row-ctl"], [data-edge-pull-slot]')
  if (!slot || !el.contains(slot)) return false
  // Each margin's pull is allowed on its own edge only: a control pulled to
  // the end has not earned room past the start.
  const style = getComputedStyle(pulled)
  if (slot !== el && (kid !== pulled || pulled.textContent?.trim() || !pulled.querySelector('svg, img') || paintsBox(style))) return false
  const right = Math.max(0, -parseFloat(style.marginRight) || 0)
  const left = Math.max(0, -parseFloat(style.marginLeft) || 0)
  return right + left > 0 && k.right <= r.right + right + 1 && k.left >= r.left - left - 1 && k.bottom <= r.bottom + 1
}

/**
 * A box spills only when something drawn sticks out of it. Scroll extents
 * alone also count a resize seam's invisible hit area, which is meant to
 * reach past the line it sits on.
 */
const sticksOut = (el: Element, r: DOMRect) => {
  let checked = 0
  for (const kid of el.querySelectorAll('*')) {
    if (++checked > 200) break
    const k = kid.getBoundingClientRect()
    if (!visible(k)) continue
    if (pulledInSlot(kid, el, k, r)) continue
    if (k.right > r.right + 1 || k.left < r.left - 1 || k.bottom > r.bottom + 1) {
      if (kid.checkVisibility && !kid.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      let painted = !['hidden', 'collapse'].includes(getComputedStyle(kid).visibility)
      for (let at: Element | null = kid; at; at = at.parentElement) {
        const style = getComputedStyle(at)
        if (style.display === 'none' || style.opacity !== '' && Number(style.opacity) === 0) { painted = false; break }
      }
      if (painted) return true
    }
  }
  return false
}

type Spill = { el: Element; r: DOMRect; how: 'spills' | 'clipped' | 'ellipsis' | 'leaves page' | 'touches frame' }

/** The nearest box around `el` that draws an edge: a border, or a fill of its own. */
const frameOf = (el: Element, root: Element): Element | null => {
  for (let at = el.parentElement; at && at !== root; at = at.parentElement) {
    const style = getComputedStyle(at)
    if (parseFloat(style.borderLeftWidth) > 0 && style.borderLeftStyle !== 'none') return at
    const fill = style.backgroundColor
    if (fill !== 'rgba(0, 0, 0, 0)' && at.parentElement && getComputedStyle(at.parentElement).backgroundColor !== fill) return at
  }
  return null
}

const ownsText = (el: Element) => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim())

/**
 * Text whose content box meets the inside of its frame on a side: nothing
 * between them keeps the words off the border. A control's own fill is its
 * hover state, not a frame, and is left out.
 */
const frameSides = (el: Element, r: DOMRect, root: Element) => {
  const none = { left: false, right: false }
  if (!ownsText(el)) return none
  const frame = frameOf(el, root)
  if (!frame || frame.matches(CONTROL)) return none
  const f = frame.getBoundingClientRect()
  const fs = getComputedStyle(frame)
  const es = getComputedStyle(el)
  const left = r.left + parseFloat(es.paddingLeft) - (f.left + parseFloat(fs.borderLeftWidth))
  const right = f.right - parseFloat(fs.borderRightWidth) - (r.right - parseFloat(es.paddingRight))
  return { left: Math.abs(left) <= 1, right: Math.abs(right) <= 1 }
}
const touchesFrame = (el: Element, r: DOMRect, root: Element) => {
  const sides = frameSides(el, r, root)
  return sides.left || sides.right
}
export const spillsOf = (boxes: Box[], page: DOMRect, root: Element): Spill[] => {
  const out: Spill[] = []
  for (const { el, r } of boxes) {
    if (!(el instanceof HTMLElement)) continue
    if (r.left < page.left - 0.5 || r.right > page.right + 0.5) { out.push({ el, r, how: 'leaves page' }); continue }
    if (touchesFrame(el, r, root)) out.push({ el, r, how: 'touches frame' })
    if (el.matches(CROP)) continue
    const wide = el.scrollWidth > el.clientWidth + 1
    const tall = el.scrollHeight > el.clientHeight + 1
    if (!wide && !tall) continue
    const style = getComputedStyle(el)
    const scrolls = /auto|scroll/.test(style.overflowX + style.overflowY)
    if (scrolls) continue
    if (style.textOverflow === 'ellipsis' && wide) out.push({ el, r, how: 'ellipsis' })
    else if (/hidden|clip/.test(style.overflowX + style.overflowY)) out.push({ el, r, how: 'clipped' })
    else if (el.clientWidth > 0 && sticksOut(el, r)) out.push({ el, r, how: 'spills' })
  }
  return out
}

type Gap = { x: number; y: number; w: number; h: number; size: number; axis: 'x' | 'y' }
const gapsOf = (boxes: Box[]): Gap[] => {
  const byParent = new Map<Element, DOMRect[]>()
  for (const { el, r, kind } of boxes) {
    if (kind === 'glyph' || !el.parentElement) continue
    const list = byParent.get(el.parentElement) ?? []
    list.push(r)
    byParent.set(el.parentElement, list)
  }
  const out: Gap[] = []
  for (const rects of byParent.values()) {
    if (rects.length < 2) continue
    for (let i = 1; i < rects.length; i++) {
      const a = rects[i - 1]!
      const b = rects[i]!
      if (b.top >= a.bottom && Math.min(a.right, b.right) > Math.max(a.left, b.left)) {
        const size = b.top - a.bottom
        const x = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2
        if (size > 0 && size <= GAP_MAX) out.push({ x: x - 1, y: a.bottom, w: 2, h: size, size, axis: 'y' })
      } else if (b.left >= a.right && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) {
        const size = b.left - a.right
        const y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2
        if (size > 0 && size <= GAP_MAX) out.push({ x: a.right, y: y - 1, w: size, h: 2, size, axis: 'x' })
      }
    }
  }
  return out
}

/**
 * The fix preview: every finding the guides can correct, corrected in place,
 * so a reviewer sees the screen as it would be once the source is fixed —
 * and the guides, measuring again, show what is left.
 *
 *   off-line       moved onto the line it missed (a `translate`);
 *   touches frame  given the card's side edge (`--hd-space-3`), as a card's rows have;
 *   off-scale      set to the nearest token of its kind: a spacing to the
 *                  spacing scale, a radius to a radius, a type size to a size,
 *                  a colour to the nearest colour token.
 *
 * Overflow is not guessed at: whether a line should wrap, truncate or the box
 * grow is a decision, so it stays a finding. Everything is an inline style
 * kept with what it replaced, so switching back restores the page exactly.
 */
type Fix = { el: HTMLElement; what: string }
const fixed = new Map<HTMLElement, string | null>()
const fixedLabels = new Map<HTMLElement, string>()

const rgbOf = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
const nearestNamed = (px: number, entries: [number, string[]][], fits: RegExp) => {
  let best: { px: number; name: string } | null = null
  for (const [value, names] of entries) {
    const name = names.find((one) => fits.test(one))
    if (!name) continue
    if (!best || Math.abs(value - px) < Math.abs(best.px - px)) best = { px: value, name }
  }
  return best
}
const nearestColour = (value: string, table: TokenTable, role: RegExp) => {
  const [r, g, b] = rgbOf(value)
  let best: { d: number; name: string } | null = null
  for (const [rgb, names] of table.colors) {
    const name = names.find((one) => role.test(one)) ?? names[0]!
    const [r2, g2, b2] = rgbOf(rgb)
    const d = (r! - r2!) ** 2 + (g! - g2!) ** 2 + (b! - b2!) ** 2
    if (!best || d < best.d) best = { d, name }
  }
  return best?.name ?? null
}

const PROPERTY: Record<string, string> = { radius: 'border-radius', background: 'background-color' }

type Planned = { el: HTMLElement; set: Record<string, string>; what: string }
const viewport = () => new DOMRect(0, 0, window.innerWidth, window.innerHeight)

/** Values: every off-scale value to its token, every text off its frame to the card's edge. */
const valueFixes = (roots: Element[], table: TokenTable): Planned[] => {
  const out: Planned[] = []
  const lengths = [...table.lengths]
  const sizes = [...table.sizes]
  for (const root of roots) {
    const boxes = collect(root, viewport())
    for (const { el, r, kind } of boxes) {
      if (!(el instanceof HTMLElement) || kind === 'glyph') continue
      const sides = frameSides(el, r, root)
      const inset: Record<string, string> = {}
      if (sides.left) inset['padding-left'] = 'var(--hd-space-3)'
      if (sides.right) inset['padding-right'] = 'var(--hd-space-3)'
      // The inset belongs to the component the text is part of — an empty state's title and its
      // line move in together — so the nearest named box that is flush with it takes it.
      if (Object.keys(inset).length) {
        const frame = frameOf(el, root)
        let target: HTMLElement = el
        for (let up = el.parentElement; up && up !== frame; up = up.parentElement) {
          if (!up.hasAttribute('data-slot') || !(up instanceof HTMLElement)) continue
          const u = up.getBoundingClientRect()
          if ((sides.left && Math.abs(u.left - r.left) <= 1) || (sides.right && Math.abs(u.right - r.right) <= 1)) target = up
          break
        }
        if (!out.some((one) => one.el === target && 'padding-left' in one.set)) out.push({ el: target, set: inset, what: `${describe(target)} off its frame (space-3)` })
      }
      for (const { what, value } of offScaleOf(el, getComputedStyle(el), table)) {
        const property = PROPERTY[what] ?? what
        let name: string | null = null
        if (what === 'background' || what === 'color') name = nearestColour(value, table, what === 'color' ? /foreground|ink|text/ : /background|card|muted|fill|surface/)
        else {
          const px = parseFloat(value)
          const pick = what === 'font-size' ? nearestNamed(px, sizes, /^--hd-text/) : what === 'radius' ? nearestNamed(px, lengths, /^--hd-radius/) : nearestNamed(px, lengths, /^--hd-space-/)
          name = pick?.name ?? null
        }
        if (name) out.push({ el, set: { [property]: `var(${name})` }, what: `${describe(el)} ${what} ${value} → ${name.replace(/^--hd-/, '')}` })
      }
    }
  }
  return out
}

/**
 * Lines, measured after the values are fixed — a padding put on the scale
 * moves what is inside it, so a nudge measured before would overshoot. A box
 * that misses with its start moves by its start; a control that misses only
 * with its end moves by its end.
 */
const lineFixes = (roots: Element[]): Planned[] => {
  const out: Planned[] = []
  for (const root of roots) {
    const boxes = collect(root, viewport())
    const seen = new Set<Element>()
    const misses = missesOf(boxes, railsOf(boxes)).sort((a, b) => Number(b.at === b.box.r.left) - Number(a.at === a.box.r.left))
    for (const { box, at, rail } of misses) {
      if (!(box.el instanceof HTMLElement) || seen.has(box.el)) continue
      seen.add(box.el)
      out.push({ el: box.el, set: { translate: `${fmt(rail - at)}px 0` }, what: `${describe(box.el)} onto the line (${rail > at ? '+' : ''}${fmt(rail - at)}px)` })
    }
  }
  return out
}

/** Apply every correction the guides can make, measured before any is made. */
export const previewFixes = (roots: Element[]): Fix[] => {
  clearFixes()
  const apply = (planned: Planned[]) => {
    for (const { el, set, what } of planned) {
      if (!fixed.has(el)) fixed.set(el, el.getAttribute('style'))
      for (const [property, value] of Object.entries(set)) el.style.setProperty(property, value)
      fixedLabels.set(el, fixedLabels.has(el) ? `${fixedLabels.get(el)}; ${what}` : what)
    }
    return planned
  }
  const values = apply(valueFixes(roots, readTokens()))
  const lines = apply(lineFixes(roots))
  return [...values, ...lines].map(({ el, what }) => ({ el, what }))
}

/** Put every corrected element back as it was. */
export const clearFixes = () => {
  for (const [el, style] of fixed) {
    if (style === null) el.removeAttribute('style')
    else el.setAttribute('style', style)
  }
  fixed.clear()
  fixedLabels.clear()
}

/** What a page's guides found, read by specs and by anyone at the console. */
export type GuidesReport = { page: string; offLine: string[]; overflow: string[]; offScale: string[] }[]
export const guidesReport: { current: GuidesReport } = { current: [] }
if (typeof window !== 'undefined') (window as unknown as { __hdGuides: typeof guidesReport }).__hdGuides = guidesReport

const describe = (el: Element) => {
  const slot = el.getAttribute('data-slot')
  // Rendered text, so a title and the line under it stay two words apart.
  const whole = ((el instanceof HTMLElement ? el.innerText : null) ?? el.textContent ?? '').trim().replace(/\s+/g, ' ')
  const text = whole.length > 28 ? `${whole.slice(0, 27).trimEnd()}…` : whole
  return `${el.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}${text ? ` "${text}"` : ''}`
}

const fmt = (n: number) => (Number.isInteger(round(n)) ? String(round(n)) : round(n).toFixed(1))

const label = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, ink: string) => {
  ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  const w = ctx.measureText(text).width + 6
  const left = Math.min(Math.max(2, x), ctx.canvas.clientWidth - w - 2)
  const top = Math.min(Math.max(2, y), ctx.canvas.clientHeight - 16)
  ctx.fillStyle = fill
  ctx.fillRect(left, top, w, 14)
  ctx.fillStyle = ink
  ctx.fillText(text, left + 3, top + 10.5)
}

const parentBox = (el: Element, root: Element) => {
  for (let up = el.parentElement; up && up !== root.parentElement; up = up.parentElement) {
    if (up === root || up.matches(PLACED)) {
      const r = up.getBoundingClientRect()
      if (visible(r)) return r
    }
  }
  return root.getBoundingClientRect()
}

const placedAt = (target: Element | null, roots: Element[]) => {
  for (let el = target; el; el = el.parentElement) {
    const root = roots.find((one) => one.contains(el!))
    if (!root) return null
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    if (el.matches(PLACED) || el === root) return { el, root }
  }
  return null
}

/**
 * The space between two boxes, as a designer measures it: the gap on each
 * axis where they are apart, or each edge's inset where one holds the other.
 */
const measureBetween = (ctx: CanvasRenderingContext2D, a: DOMRect, b: DOMRect, palette: Palette) => {
  ctx.strokeStyle = palette.danger
  ctx.lineWidth = 1
  const line = (x1: number, y1: number, x2: number, y2: number, d: number) => {
    if (d <= 0.25) return
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    label(ctx, fmt(d), (x1 + x2) / 2 + 3, (y1 + y2) / 2 - 7, palette.danger, palette.ink)
  }
  const inside = (o: DOMRect, i: DOMRect) => i.left >= o.left && i.right <= o.right && i.top >= o.top && i.bottom <= o.bottom
  if (inside(a, b) || inside(b, a)) {
    const [o, i] = inside(a, b) ? [a, b] : [b, a]
    const mx = i.left + i.width / 2
    const my = i.top + i.height / 2
    line(mx, o.top, mx, i.top, i.top - o.top)
    line(mx, i.bottom, mx, o.bottom, o.bottom - i.bottom)
    line(o.left, my, i.left, my, i.left - o.left)
    line(i.right, my, o.right, my, o.right - i.right)
    return
  }
  const y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2
  const x = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2
  if (b.left >= a.right) line(a.right, y, b.left, y, b.left - a.right)
  else if (a.left >= b.right) line(b.right, y, a.left, y, a.left - b.right)
  if (b.top >= a.bottom) line(x, a.bottom, x, b.top, b.top - a.bottom)
  else if (a.top >= b.bottom) line(x, b.bottom, x, a.top, a.top - b.bottom)
}

/**
 * Draw guides over `roots` until the returned function is called. `roots` is
 * read on every frame, so a list that changes — a board switched, a frame
 * mounted — is followed without remounting.
 */
export const mountGuides = (roots: () => Element[], mode: GuidesMode): (() => void) => {
  const layers = new Set(LAYERS[mode])
  if (layers.size === 0) return () => {}
  const canvas = document.createElement('canvas')
  canvas.dataset.guides = mode
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:calc(var(--hd-z-toast) + 1)'
  document.body.append(canvas)
  const ctx = canvas.getContext('2d')!
  let pointer: { x: number; y: number } | null = null
  let frame = 0
  let palette = readPalette()
  let tokens: TokenTable = readTokens()
  let pinned: Element | null = null
  let hovered: Element | null = null

  const draw = () => {
    frame = 0
    const dpr = window.devicePixelRatio || 1
    const width = window.innerWidth
    const height = window.innerHeight
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const view = new DOMRect(0, 0, width, height)
    const pages = roots().filter((root) => meets(root.getBoundingClientRect(), view))
    const report: GuidesReport = []

    for (const root of pages) {
      const page = root.getBoundingClientRect()
      const boxes = collect(root, view)
      const entry: GuidesReport[number] = { page: root.getAttribute('data-frame-id') ?? root.getAttribute('data-alignment-board-id') ?? 'page', offLine: [], overflow: [], offScale: [] }
      report.push(entry)
      ctx.save()
      ctx.beginPath()
      ctx.rect(page.left - 1, page.top - 1, page.width + 2, page.height + 2)
      ctx.clip()

      if (layers.has('grid')) {
        for (let x = page.left; x <= page.right; x += GRID) {
          ctx.globalAlpha = Math.round(x - page.left) % GRID_MAJOR === 0 ? 0.35 : 0.12
          ctx.fillStyle = palette.grid
          ctx.fillRect(Math.round(x), page.top, 1, page.height)
        }
        for (let y = page.top; y <= page.bottom; y += GRID) {
          ctx.globalAlpha = Math.round(y - page.top) % GRID_MAJOR === 0 ? 0.35 : 0.12
          ctx.fillStyle = palette.grid
          ctx.fillRect(page.left, Math.round(y), page.width, 1)
        }
        ctx.globalAlpha = 1
      }

      if (layers.has('boxes')) {
        ctx.lineWidth = 1
        for (const { r, kind } of boxes) {
          ctx.globalAlpha = kind === 'container' ? 0.45 : kind === 'glyph' ? 0.3 : 0.8
          ctx.strokeStyle = kind === 'control' ? palette.control : kind === 'text' ? palette.text : palette.accent
          ctx.strokeRect(Math.round(r.left) + 0.5, Math.round(r.top) + 0.5, Math.max(0, Math.round(r.width) - 1), Math.max(0, Math.round(r.height) - 1))
        }
        ctx.globalAlpha = 1
      }

      let missCount = 0
      if (layers.has('rails')) {
        const rails = railsOf(boxes)
        ctx.strokeStyle = palette.accent
        ctx.globalAlpha = 0.35
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        for (const x of rails.x) { ctx.moveTo(Math.round(x) + 0.5, page.top); ctx.lineTo(Math.round(x) + 0.5, page.bottom) }
        for (const y of rails.y) { ctx.moveTo(page.left, Math.round(y) + 0.5); ctx.lineTo(page.right, Math.round(y) + 0.5) }
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        const misses = missesOf(boxes, rails)
        missCount = misses.length
        entry.offLine = misses.map(({ box, at, rail }) => `${describe(box.el)} Δ${fmt(Math.abs(rail - at))}`)
        ctx.strokeStyle = palette.danger
        ctx.lineWidth = 2
        for (const { box, at, rail } of misses) {
          // A tick on the edge and an arrow to the rail it missed.
          const y = box.r.top + Math.min(box.r.height, 16) / 2
          ctx.beginPath()
          ctx.moveTo(at, box.r.top); ctx.lineTo(at, box.r.top + Math.min(box.r.height, 16))
          ctx.moveTo(at, y); ctx.lineTo(rail, y)
          ctx.stroke()
          label(ctx, `Δ${fmt(Math.abs(rail - at))}`, Math.max(at, rail) + 3, y - 7, palette.danger, palette.ink)
        }
      }

      if (layers.has('gaps')) {
        for (const gap of gapsOf(boxes)) {
          ctx.fillStyle = palette.gap
          ctx.fillRect(gap.x, gap.y, gap.w, gap.h)
          if (gap.size >= 4) label(ctx, fmt(gap.size), gap.axis === 'y' ? gap.x + 4 : gap.x + gap.w / 2 - 8, gap.axis === 'y' ? gap.y + gap.h / 2 - 7 : gap.y - 15, palette.gap, palette.ink)
        }
      }

      let spillCount = 0
      if (layers.has('overflow')) {
        const spills = spillsOf(boxes, page, root)
        spillCount = spills.filter((one) => one.how !== 'ellipsis').length
        entry.overflow = spills.filter((one) => one.how !== 'ellipsis').map(({ el, how }) => `${describe(el)} ${how}`)
        ctx.lineWidth = 2
        for (const { r, how } of spills) {
          ctx.strokeStyle = how === 'ellipsis' ? palette.warn : palette.danger
          ctx.setLineDash(how === 'clipped' ? [3, 2] : [])
          ctx.strokeRect(r.left + 1, r.top + 1, r.width - 2, r.height - 2)
          ctx.setLineDash([])
          if (how !== 'ellipsis') label(ctx, how, r.left, r.bottom + 1, palette.danger, palette.ink)
        }
      }

      let scaleCount = 0
      if (layers.has('scale')) {
        for (const { el, r, kind } of boxes) {
          if (kind === 'glyph') continue
          const found = offScaleOf(el, getComputedStyle(el), tokens)
          if (!found.length) continue
          entry.offScale.push(`${describe(el)} ${found.map(({ what, value }) => `${what} ${value}`).join(', ')}`)
          // A corner flag: off scale is a question for the source, not a box to read.
          ctx.fillStyle = palette.warn
          ctx.beginPath()
          ctx.moveTo(r.right, r.top); ctx.lineTo(r.right - 7, r.top); ctx.lineTo(r.right, r.top + 7)
          ctx.closePath(); ctx.fill()
        }
        scaleCount = entry.offScale.length
      }
      ctx.restore()

      // The page's own edge and its tally, outside the clip.
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(page.left) + 0.5, Math.round(page.top) + 0.5, Math.round(page.width) - 1, Math.round(page.height) - 1)
      const tally = [
        layers.has('rails') ? `${missCount} off-line` : null,
        layers.has('overflow') ? `${spillCount} overflow` : null,
        layers.has('scale') ? `${scaleCount} off-scale` : null,
      ].filter(Boolean).join(' · ')
      if (tally) label(ctx, tally, page.right - 240, page.top + 4, missCount + spillCount ? palette.danger : scaleCount ? palette.warn : palette.accent, palette.ink)
    }

    // What the fix preview changed: a green outline, so "after" says where it differs.
    if (fixed.size) {
      ctx.strokeStyle = palette.pad
      ctx.lineWidth = 2
      ctx.setLineDash([4, 2])
      for (const el of fixed.keys()) {
        const r = el.getBoundingClientRect()
        if (visible(r) && meets(r, view)) ctx.strokeRect(r.left + 1, r.top + 1, r.width - 2, r.height - 2)
      }
      ctx.setLineDash([])
    }

    guidesReport.current = report
    if (window.parent !== window) window.parent.postMessage({ type: 'hd-guides-report', report }, window.location.origin)

    if (layers.has('inspect') && pointer) {
      const hit = placedAt(document.elementFromPoint(pointer.x, pointer.y), pages)
      hovered = hit?.el ?? null
      if (hit) {
        const { el, root } = hit
        const r = el.getBoundingClientRect()
        const page = root.getBoundingClientRect()
        // Its edges, carried across the page.
        ctx.strokeStyle = palette.accent
        ctx.globalAlpha = 0.7
        ctx.lineWidth = 1
        ctx.beginPath()
        for (const x of [r.left, r.right]) { ctx.moveTo(Math.round(x) + 0.5, page.top); ctx.lineTo(Math.round(x) + 0.5, page.bottom) }
        for (const y of [r.top, r.bottom]) { ctx.moveTo(page.left, Math.round(y) + 0.5); ctx.lineTo(page.right, Math.round(y) + 0.5) }
        ctx.stroke()
        ctx.globalAlpha = 1
        // Its padding.
        const style = getComputedStyle(el)
        const pad = ['Top', 'Right', 'Bottom', 'Left'].map((side) => parseFloat(style.getPropertyValue(`padding-${side.toLowerCase()}`)) || 0) as [number, number, number, number]
        ctx.fillStyle = palette.pad
        ctx.globalAlpha = 0.22
        ctx.fillRect(r.left, r.top, r.width, pad[0])
        ctx.fillRect(r.left, r.bottom - pad[2], r.width, pad[2])
        ctx.fillRect(r.left, r.top + pad[0], pad[3], r.height - pad[0] - pad[2])
        ctx.fillRect(r.right - pad[1], r.top + pad[0], pad[1], r.height - pad[0] - pad[2])
        ctx.globalAlpha = 1
        ctx.strokeStyle = palette.accent
        ctx.lineWidth = 2
        ctx.strokeRect(r.left, r.top, r.width, r.height)
        // Its distance to its parent, each side.
        if (el !== root) {
          const p = parentBox(el, root)
          ctx.strokeStyle = palette.danger
          ctx.lineWidth = 1
          const midX = r.left + r.width / 2
          const midY = r.top + r.height / 2
          const sides: [number, number, number, number, number][] = [
            [midX, p.top, midX, r.top, r.top - p.top],
            [midX, r.bottom, midX, p.bottom, p.bottom - r.bottom],
            [p.left, midY, r.left, midY, r.left - p.left],
            [r.right, midY, p.right, midY, p.right - r.right],
          ]
          for (const [x1, y1, x2, y2, d] of sides) {
            if (d <= 0.25) continue
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
            label(ctx, fmt(d), (x1 + x2) / 2 + 3, (y1 + y2) / 2 - 7, palette.danger, palette.ink)
          }
        }
        const slot = el.getAttribute('data-slot')
        const name = `${el.tagName.toLowerCase()}${slot ? `·${slot}` : ''}`
        const padText = pad.every((one) => one === pad[0]) ? lengthName(tokens, pad[0]) : pad.map((one) => lengthName(tokens, one)).join(' ')
        const size = parseFloat(style.fontSize)
        const sizeName = tokens.sizes.get(Math.round(size * 100) / 100)?.[0]?.replace(/^--hd-/, '') ?? `${fmt(size)}px`
        const type = `${sizeName} ${fmt(size)}/${style.lineHeight === 'normal' ? 'normal' : fmt(parseFloat(style.lineHeight))} ${style.fontWeight}`
        const radius = parseFloat(style.borderTopLeftRadius) || 0
        const facts = [
          `${name}  ${fmt(r.width)}×${fmt(r.height)}`,
          `pad ${padText}`,
          /flex|grid/.test(style.display) && parseFloat(style.rowGap || style.columnGap) ? `gap ${lengthName(tokens, parseFloat(style.columnGap) || parseFloat(style.rowGap))}` : null,
          radius ? `radius ${radius >= 999 ? 'full' : lengthName(tokens, radius, false)}` : null,
        ].filter(Boolean).join('  ')
        const ink = [
          `type ${type}`,
          colorName(tokens, style.color) ? `ink ${colorName(tokens, style.color)}` : null,
          colorName(tokens, style.backgroundColor, 'fill') ? `fill ${colorName(tokens, style.backgroundColor, 'fill')}` : null,
        ].filter(Boolean).join('  ')
        label(ctx, facts, r.left, r.top - 32, palette.accent, palette.ink)
        label(ctx, ink, r.left, r.top - 16, palette.accent, palette.ink)
        const off = offScaleOf(el, style, tokens)
        if (off.length) label(ctx, `off scale: ${off.map(({ what, value }) => `${what} ${value}`).join(', ')}`, r.left, r.bottom + 2, palette.warn, palette.ink)

        // Measure from the pinned element to this one.
        if (pinned && pinned !== el && pinned.isConnected) {
          const a = pinned.getBoundingClientRect()
          ctx.strokeStyle = palette.danger
          ctx.setLineDash([4, 3])
          ctx.lineWidth = 1.5
          ctx.strokeRect(a.left, a.top, a.width, a.height)
          ctx.setLineDash([])
          measureBetween(ctx, a, r, palette)
        }
      }
    }
    if (pinned && pinned.isConnected && !(layers.has('inspect') && pointer)) {
      const a = pinned.getBoundingClientRect()
      ctx.strokeStyle = palette.danger
      ctx.setLineDash([4, 3])
      ctx.strokeRect(a.left, a.top, a.width, a.height)
      ctx.setLineDash([])
    }
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw) }
  const onPointer = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; schedule() }
  const onLeave = () => { pointer = null; hovered = null; schedule() }
  let mutationTimer = 0
  let retheme = false
  // Match every appearance dial written by state/theme.ts, on either root.
  const appearanceAttributes = ['class', 'style', 'data-hd-dark-theme', 'data-hd-palette', 'data-hd-accent', 'data-hd-corners', 'data-hd-faces', 'data-hd-interface', 'data-hd-surface']
  const observe = () => {
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [...appearanceAttributes, 'data-state', 'open'] })
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: appearanceAttributes })
  }
  const mutations = new MutationObserver((records) => {
    if (records.some((one) => one.type === 'attributes' && (one.target === document.body || one.target === document.documentElement))) retheme = true
    if (mutationTimer) return
    mutationTimer = window.setTimeout(() => {
      mutationTimer = 0
      if (retheme) {
        // Sampling uses temporary DOM probes. Their writes are ours, not another page change.
        mutations.disconnect()
        try { palette = readPalette(); tokens = readTokens() } finally { observe(); retheme = false }
      }
      schedule()
    }, 120)
  })
  observe()
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  window.addEventListener('pointermove', onPointer, { passive: true })
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && pinned) { pinned = null; schedule(); return }
    if (event.key !== 'Shift' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as Element | null
    if (target?.closest?.('input, textarea, [contenteditable="true"]')) return
    pinned = hovered && hovered !== pinned ? hovered : null
    schedule()
  }
  window.addEventListener('keydown', onKey)
  document.documentElement.addEventListener('pointerleave', onLeave)
  schedule()

  return () => {
    if (frame) cancelAnimationFrame(frame)
    if (mutationTimer) clearTimeout(mutationTimer)
    mutations.disconnect()
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('pointermove', onPointer)
    window.removeEventListener('keydown', onKey)
    document.documentElement.removeEventListener('pointerleave', onLeave)
    canvas.remove()
  }
}

/** The mode the page was opened with: `?guides=`, else the last one chosen here. */
const initialGuidesMode = (): GuidesMode => {
  const asked = new URLSearchParams(window.location.search).get('guides')
  if (asked && (GUIDES_MODES as readonly string[]).includes(asked)) return asked as GuidesMode
  try {
    const kept = window.localStorage.getItem('hd-guides')
    if (kept && (GUIDES_MODES as readonly string[]).includes(kept)) return kept as GuidesMode
  } catch { /* storage refused: start off */ }
  return 'off'
}

/* One mode per page: the dial that sets it and the layer that draws it are
   often far apart in the tree (a preview route switch, a toolbar). */
let current: GuidesMode | null = null
const listeners = new Set<() => void>()
const modeNow = () => (current ??= initialGuidesMode())
const setGuidesMode = (next: GuidesMode) => {
  current = next
  try { window.localStorage.setItem('hd-guides', next) } catch { /* not kept */ }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/**
 * Turn the fix preview on or off, once the page has reached its state (a
 * scene's steps run first), and redraw the guides over the result. Returns
 * what was corrected.
 * A newer request or unmount supersedes the pending pass; it returns null
 * so its caller does not publish a stale correction count.
 */
const settleFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let fixPreviewVersion = 0
export const setFixPreview = async (on: boolean, roots: () => Element[]): Promise<string[] | null> => {
  const version = ++fixPreviewVersion
  if (!on) { clearFixes(); window.dispatchEvent(new Event('resize')); return [] }
  for (let i = 0; i < 100 && document.documentElement.dataset.sceneSteps === 'running'; i++) {
    await settleFor(100)
    if (version !== fixPreviewVersion) return null
  }
  await settleFor(300)
  if (version !== fixPreviewVersion) return null
  const fixes = previewFixes(roots()).map(({ what }) => what)
  window.dispatchEvent(new Event('resize'))
  return fixes
}

/** The page's guides mode and its setter, shared by every caller on the page. */
export const useGuidesMode = () => [useSyncExternalStore(subscribe, modeNow), setGuidesMode] as const

/**
 * Draw guides over `roots` in the page's mode, and let Alt+G step through
 * the modes. `roots` is read on every frame, so it may name elements that
 * mount later.
 */
export const useGuides = (roots: () => Element[]) => {
  const [mode] = useGuidesMode()
  // `roots` is read per frame; a new closure each render must not remount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mountGuides(roots, mode), [mode])
  // `?fix=1` opens the page with the fix preview on.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('fix') !== '1') return
    void setFixPreview(true, roots).then((fixes) => { if (fixes && window.parent !== window) window.parent.postMessage({ type: 'hd-fixes', fixes }, window.location.origin) })
    return () => { void setFixPreview(false, roots) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== 'KeyG' || event.metaKey || event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      setGuidesMode(GUIDES_MODES[(GUIDES_MODES.indexOf(modeNow()) + 1) % GUIDES_MODES.length]!)
    }
    // On the way down, before the focused element: a terminal reads Alt+G as
    // Meta+G off the Mac and stops the key, and the preview opens with a
    // terminal focused, so a listener on the way up never heard it there.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // A page embedded in the review board takes its mode from the board and
  // answers "what is at this point" for a review note.
  useEffect(() => {
    if (window.parent === window) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      const data = event.data as { type?: string; mode?: GuidesMode; x?: number; y?: number; id?: string; key?: string; on?: boolean }
      if (data.type === 'hd-guides' && data.mode && (GUIDES_MODES as readonly string[]).includes(data.mode)) setGuidesMode(data.mode)
      // The board's "Fixed" switch: show this window as it would be once its findings are fixed.
      if (data.type === 'hd-fix') void setFixPreview(!!data.on, roots).then((fixes) => { if (fixes) window.parent.postMessage({ type: 'hd-fixes', fixes }, window.location.origin) })
      // Shift and Escape, pressed while the board has focus.
      if (data.type === 'hd-key' && (data.key === 'Shift' || data.key === 'Escape')) window.dispatchEvent(new KeyboardEvent('keydown', { key: data.key }))
      if (data.type === 'hd-pick' && typeof data.x === 'number' && typeof data.y === 'number') {
        const target = document.elementFromPoint(data.x, data.y)
        const hit = target ? placedAt(target, roots()) : null
        window.parent.postMessage({ type: 'hd-picked', id: data.id, element: hit ? describe(hit.el) : target ? describe(target) : null, path: hit ? slotPath(hit.el) : null }, window.location.origin)
      }
    }
    window.addEventListener('message', onMessage)
    // A pinch or ⌘-wheel zooms the board, wherever the pointer is; only a
    // plain wheel scrolls the page itself.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      window.parent.postMessage({ type: 'hd-zoom', deltaY: event.deltaY, x: event.clientX, y: event.clientY }, window.location.origin)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    // Say "ready" once, whatever the mode: a board holds a note's question
    // until the window it asks can answer.
    const hello = window.setTimeout(() => window.parent.postMessage({ type: 'hd-guides-report', report: guidesReport.current }, window.location.origin), 300)
    return () => { window.removeEventListener('message', onMessage); window.removeEventListener('wheel', onWheel); clearTimeout(hello); void setFixPreview(false, roots) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** `page-section / row / row-title`: where an element sits, in the system's own names. */
const slotPath = (el: Element) => {
  const names: string[] = []
  for (let up: Element | null = el; up && names.length < 5; up = up.parentElement) {
    const slot = up.getAttribute('data-slot')
    if (slot) names.unshift(slot)
  }
  return names.join(' / ')
}
