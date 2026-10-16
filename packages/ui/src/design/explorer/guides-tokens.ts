/**
 * The token names behind a measured value, and the values no token names.
 *
 * Guides read the live document: every `--hd-*` custom property on `body`,
 * resolved, so a foundation or theme being inspected is the one measured.
 * A length is "on scale" when some token resolves to it; a type size only
 * when a type token does; a colour when some colour token resolves to it.
 * That is the standard the audit holds source to (`design-audit.mjs` refuses a
 * literal where a token exists), measured on the rendered page instead.
 */

export type TokenTable = {
  /** px value → token names, every length token. */
  lengths: Map<number, string[]>
  /** px value → type-size token names. */
  sizes: Map<number, string[]>
  /** `rgb(…)` → colour token names. */
  colors: Map<string, string[]>
}

const LENGTH = /^-?\d+(\.\d+)?px$/
/**
 * A length a token derives from others, `calc(8px + 8px + 1px)` once the
 * variables are in. Units that resolve against a box (`%`, viewport, `em`)
 * are left out: what they come to on the probe is not what they come to
 * where they are used.
 */
const DERIVED = /^(calc|min|max|clamp)\((?!.*(%|vw|vh|vmin|vmax|dvh|svh|lvh|\bem|ch\b|ex\b|lh\b))/
const add = <K>(map: Map<K, string[]>, key: K, name: string) => {
  const list = map.get(key)
  if (list) list.push(name)
  else map.set(key, [name])
}

/** Names that say what a value is for, ahead of names that merely alias it. */
const rank = (name: string) =>
  /^--hd-space-/.test(name) ? 0 : /^--hd-(text|line)/.test(name) ? 1 : /^--hd-radius/.test(name) ? 2 : /^--hd-hdp|^--hdp-/.test(name) ? 9 : 5

const resolve = (probe: HTMLElement, value: string) => {
  probe.style.marginLeft = ''
  probe.style.marginLeft = value
  if (!probe.style.marginLeft) return null
  const px = getComputedStyle(probe).marginLeft
  return LENGTH.test(px) ? px : null
}

export const readTokens = (): TokenTable => {
  const table: TokenTable = { lengths: new Map(), sizes: new Map(), colors: new Map() }
  const style = getComputedStyle(document.body)
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden'
  document.body.append(probe)
  const names: string[] = []
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i)
    if (name.startsWith('--hd-')) names.push(name)
  }
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const name of names) {
    const value = style.getPropertyValue(name).trim()
    if (!value) continue
    // The probe resolves a derived length; a margin takes negatives as they are.
    const length = LENGTH.test(value) ? value : DERIVED.test(value) ? resolve(probe, value) : null
    if (length) {
      const px = Math.round(parseFloat(length) * 100) / 100
      add(table.lengths, px, name)
      if (/^--hd-(text|heading|title|display|btn-text)/.test(name)) add(table.sizes, px, name)
      continue
    }
    if (/^(#|rgb|hsl|oklch|color|lab|lch)/.test(value) || /^[a-z]+$/.test(value)) {
      probe.style.color = ''
      probe.style.color = value
      if (!probe.style.color) continue
      const rgb = getComputedStyle(probe).color
      add(table.colors, rgb, name)
    }
  }
  probe.remove()
  return table
}

const short = (name: string) => name.replace(/^--hd-/, '')

/**
 * `12` → `space-3`. A spacing is named only by the spacing scale: a padding
 * that happens to equal a type size is not on the scale, and printing
 * `text-sm` for it would say it was. Other lengths take whatever names them.
 */
export const lengthName = (table: TokenTable, px: number, spacing = true) => {
  if (px === 0) return '0'
  const names = table.lengths.get(Math.round(px * 100) / 100) ?? []
  const named = spacing ? names.find((name) => /^--hd-space-/.test(name)) : names[0]
  return named ? short(named) : `${Math.round(px * 10) / 10}px`
}

/** A colour by the name that says its job: an ink by a foreground, a fill by a ground. */
export const colorName = (table: TokenTable, rgb: string, role: 'ink' | 'fill' = 'ink') => {
  if (rgb === 'rgba(0, 0, 0, 0)' || rgb === 'transparent') return null
  const names = table.colors.get(rgb)
  if (!names) return rgb.replace(/\s+/g, '')
  const fits = role === 'ink' ? /foreground|ink|text|label/ : /background|card|muted|hover|active|selected|fill|surface|popover|accent|secondary/
  return short(names.find((name) => fits.test(name)) ?? names[0]!)
}

export type OffScale = { what: string; value: string }

/** Every value on `el` that no token resolves to. */
export const offScaleOf = (el: Element, style: CSSStyleDeclaration, table: TokenTable): OffScale[] => {
  const out: OffScale[] = []
  const length = (what: string, raw: string) => {
    if (!LENGTH.test(raw)) return
    const px = Math.round(parseFloat(raw) * 100) / 100
    // Past the scale's last step a length is layout, not a spacing choice —
    // the room kept under a composer is its measured height.
    if (px === 0 || px === 1 || px > 96) return
    if (!table.lengths.has(px)) out.push({ what, value: `${px}px` })
  }
  for (const side of ['top', 'right', 'bottom', 'left']) length(`padding-${side}`, style.getPropertyValue(`padding-${side}`))
  if (/flex|grid/.test(style.display)) {
    length('row-gap', style.rowGap)
    length('column-gap', style.columnGap)
  }
  const radius = style.borderTopLeftRadius
  if (LENGTH.test(radius) && parseFloat(radius) < 999) length('radius', radius)
  // Type is judged where it is set, not on every element that inherits it.
  const parent = el.parentElement ? getComputedStyle(el.parentElement) : null
  if (!parent || parent.fontSize !== style.fontSize) {
    const size = Math.round(parseFloat(style.fontSize) * 100) / 100
    if (size && !table.sizes.has(size)) out.push({ what: 'font-size', value: `${size}px` })
  }
  const bg = style.backgroundColor
  if (bg !== 'rgba(0, 0, 0, 0)' && !table.colors.has(bg) && (!parent || parent.backgroundColor !== bg)) out.push({ what: 'background', value: bg.replace(/\s+/g, '') })
  if (!parent || parent.color !== style.color) {
    if (!table.colors.has(style.color)) out.push({ what: 'color', value: style.color.replace(/\s+/g, '') })
  }
  return out
}
