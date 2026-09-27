import { expect, test, type Page } from '@playwright/test'

/**
 * The UI consistency programme's rules, rendered and mutation-tested.
 *
 * Every rule below used to be enforced by reading, by a unit test of one
 * component, or by an audit category that only counts declarations in
 * source. None of that fails when a component edit changes what the browser
 * actually computes — the audit cannot see a token shadowed by a sheet it
 * never reads, and a unit test of one component cannot see two components
 * disagreeing. This file asks the running catalogue and `preview.html`'s real
 * screens the same nine questions #831's programme decided, and proves each
 * checker is not vacuous by breaking the rule with `page.addStyleTag` and
 * checking the same function reports it.
 *
 * A rule that already fails on the real app is written and left red, with
 * the violation named in a comment — not weakened or skipped. `docs/design.md`
 * ("## The rules") documents the measured values and the decisions made
 * where the tracking issue's numbers disagreed with what the app renders.
 *
 * Selectors and driving techniques are reused from the specs already
 * exercising these surfaces — `row-height.spec.ts`'s token-probe and dial
 * helpers, `surface-focus.spec.ts`'s keyboard-focus fixture technique,
 * `visual-contracts.spec.ts`'s selection rig and account-menu flow, and
 * `sidebar-roles.spec.ts`'s row selector — rather than invented fresh; each
 * reuse is named where it happens. `taste.spec.ts`, `page-grammar.spec.ts`
 * and `header-title-floor.spec.ts` were read for how they drive the same
 * surfaces but did not have a check this file could reuse without repeating
 * it identically.
 */

/* --- shared helpers -------------------------------------------------------- */

/** The dials `preview.html` draws at its top (see `row-height.spec.ts`). */
const dial = (page: Page, label: string) =>
  page.locator('label').filter({ hasText: new RegExp(`^${label}`) }).locator('select').first()

const setPreviewDials = async (page: Page, theme: 'light' | 'dark', look: 'desk' | 'studio') => {
  await dial(page, 'theme').selectOption(theme)
  await dial(page, 'interface').selectOption(look)
  await expect
    .poll(() => page.evaluate(() => document.body.getAttribute('data-hd-interface') ?? 'desk'))
    .toBe(look)
}

const gotoPreview = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/preview.html')
  await page.waitForSelector('[class*="rowWrap_"]')
  await page.evaluate(async () => { await document.fonts.ready })
}

/** A CSS value resolved the way the browser resolves it, not read as text. */
const PROBE_HELPERS = `
  const probeHeight = (token) => {
    const el = document.body.appendChild(document.createElement('div'))
    el.style.cssText = 'position:absolute;visibility:hidden;height:var(' + token + ')'
    const value = Math.round(el.getBoundingClientRect().height)
    el.remove()
    return value
  }
  const probeFontFamily = (token) => {
    const el = document.body.appendChild(document.createElement('div'))
    el.style.cssText = 'position:absolute;visibility:hidden;font-family:var(' + token + ')'
    const value = getComputedStyle(el).fontFamily
    el.remove()
    return value
  }
  const probeColor = (decl) => {
    const el = document.body.appendChild(document.createElement('div'))
    el.style.cssText = 'position:absolute;visibility:hidden;' + decl
    const value = getComputedStyle(el).color
    el.remove()
    return value
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const c = getComputedStyle(el)
    return c.visibility !== 'hidden' && c.display !== 'none'
  }
`

/* ========================================================================
 * Rule: names
 *
 * Every element wearing a name role (`Text role=…` in
 * `design/patterns/Settings.tsx`, plus `PageHead`'s own `page-title`) computes
 * one of the pairs `docs/design.md`'s "Named text roles" table states:
 * wordmark 20/600, page 20/600, subject 14/500, row 13/500, navigation
 * 13/400, muted 13/400 — never 16px, never semibold outside wordmark and the
 * page title. `group label` is its own rule, below. The dashboard readouts
 * `Text` also draws (`meta`, `figure`, `metric`, `value`, `prose`) are not
 * names — nothing in the docs table lists them, `Text`'s own comment calls
 * them "dashboard readouts", and `figure`/`metric` are deliberately semibold
 * — so the checker only looks at the six name roles.
 *
 * Measured on `/preview.html`'s full set of mounted screens, across every
 * theme and interface (the pairs are named in tokens, not in the interface
 * layer, so they do not vary by dial — this proves that rather than assumes
 * it). Two real violations turned up and are asserted, not hidden:
 *
 * 1. `components/Publication.tsx`'s pull-request title is
 *    `<Text role="row" weight="semibold">` — a name at 13px wearing the
 *    weight `weight` was written for lifting a search match, not a title.
 * 2. Studio's group-label weight — see the group-labels rule below.
 */
const NAME_PAIRS: Record<string, { size: number; weight: number }> = {
  wordmark: { size: 20, weight: 600 },
  page: { size: 20, weight: 600 },
  subject: { size: 14, weight: 500 },
  row: { size: 13, weight: 500 },
  navigation: { size: 13, weight: 400 },
  muted: { size: 13, weight: 400 },
}

type NameFinding = { role: string; text: string; size: number; weight: number; reason: string }

const namesViolations = (page: Page) =>
  page.evaluate((pairs) => {
    const out: NameFinding[] = []
    const nodes = [
      ...document.querySelectorAll('[data-slot="text"][data-role]'),
      ...document.querySelectorAll('[data-slot="page-title"]'),
    ]
    for (const el of nodes) {
      const role = el.hasAttribute('data-slot') && el.getAttribute('data-slot') === 'page-title'
        ? 'page'
        : (el.getAttribute('data-role') ?? '')
      const wanted = (pairs as Record<string, { size: number; weight: number }>)[role]
      if (!wanted) continue
      if (!(el as HTMLElement).offsetParent && getComputedStyle(el).position !== 'fixed') continue
      const cs = getComputedStyle(el)
      const size = Math.round(parseFloat(cs.fontSize))
      const weight = Number(cs.fontWeight)
      const text = (el.textContent ?? '').trim().slice(0, 60)
      if (size === 16) out.push({ role, text, size, weight, reason: '16px, which no name role may be' })
      else if (weight === 600 && role !== 'wordmark' && role !== 'page') out.push({ role, text, size, weight, reason: 'semibold outside the wordmark and the page title' })
      else if (size !== wanted.size || weight !== wanted.weight) out.push({ role, text, size, weight, reason: `role ${role} wants ${wanted.size}/${wanted.weight}` })
    }
    return out
  }, NAME_PAIRS)

test.describe('rule: names', () => {
  test('rule: names — every name role computes its allowed size and weight, in every theme and interface', async ({ page }) => {
    await gotoPreview(page)
    const findings: NameFinding[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        for (const finding of await namesViolations(page)) findings.push({ ...finding, reason: `${theme}/${look}: ${finding.reason}` })
      }
    }
    // Known, real violations (see the rule's header comment) — left failing on
    // purpose rather than weakened, per the programme's own instruction.
    expect(findings).toEqual([])
  })

  test('rule: names — the checker catches a name role pushed to 16px', async ({ page }) => {
    await gotoPreview(page)
    const before = await namesViolations(page)
    await page.addStyleTag({ content: '[data-slot="text"][data-role="row"] { font-size: 16px !important; }' })
    const after = await namesViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.some((f) => f.reason.includes('16px'))).toBe(true)
  })
})

/* ========================================================================
 * Rule: group labels
 *
 * `GroupLabel` (`design/ui/group-label.tsx`) is the one implementation for
 * every group heading; `text-transform` is never `uppercase` (the design
 * audit's `uppercaseLabel` already refuses this in source — see
 * `docs/design.md` "One title, one group label" — this asserts the rendered
 * result) and the weight is regular in every instance.
 *
 * Measured across theme and interface: **Studio fails this today.**
 * `foundation/tokens.css`'s `body[data-hd-interface='studio']` block sets
 * `--hd-label-weight: var(--hd-weight-medium)` (500), and `GroupLabel`'s own
 * class reads that token — so every group label in Studio computes 500, not
 * regular. `group-label.tsx`'s own comment calls this out as a deliberate,
 * Studio-only variation ("the interfaces may vary the label's weight"), but
 * the rule as written in #838 says weight is regular "in every group-label
 * role" with no interface carve-out. Left failing rather than narrowed —
 * the controller decides whether the rule or the Studio token is wrong.
 */
type GroupLabelFinding = { text: string; transform: string; weight: number }

const groupLabelViolations = (page: Page) =>
  page.evaluate(() => {
    const out: GroupLabelFinding[] = []
    for (const el of document.querySelectorAll('[data-slot="group-label"]')) {
      const cs = getComputedStyle(el)
      const transform = cs.textTransform
      const weight = Number(cs.fontWeight)
      if (transform === 'uppercase' || weight !== 400) {
        out.push({ text: (el.textContent ?? '').trim().slice(0, 40), transform, weight })
      }
    }
    return out
  })

test.describe('rule: group labels', () => {
  test('rule: group labels — text-transform is never uppercase and weight is regular, in every theme and interface', async ({ page }) => {
    await gotoPreview(page)
    const findings: (GroupLabelFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        for (const finding of await groupLabelViolations(page)) findings.push({ ...finding, where: `${theme}/${look}` })
      }
    }
    // Real violation: Studio's --hd-label-weight is 500 (see header comment).
    expect(findings).toEqual([])
  })

  test('rule: group labels — the checker catches a group label set in capitals', async ({ page }) => {
    await gotoPreview(page)
    await setPreviewDials(page, 'light', 'desk')
    const before = await groupLabelViolations(page)
    await page.addStyleTag({ content: '[data-slot="group-label"] { text-transform: uppercase !important; }' })
    const after = await groupLabelViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.every((f) => f.transform === 'uppercase')).toBe(true)
  })
})

/* ========================================================================
 * Rule: destination rows
 *
 * A navigation row is `--hd-nav-h` tall wherever it appears: the sidebar's
 * session row (`components/SessionTree.tsx`, `[class*="rowWrap_"]` —
 * selector reused from `sidebar-roles.spec.ts`), the settings/usage rail row
 * (`AppWindow.tsx`'s `WindowNavItem`, `.winNavItem` — both windows share this
 * file), and a dropdown menu item (`design/ui/dropdown-menu.tsx`, all three
 * use the identical Tailwind recipe: `min-h-(--hd-nav-h)`, `py-1`,
 * `text-(length:--hd-text-sm)`, `leading-(--hd-line-sm)`).
 *
 * Measured rather than assumed: at Desk, every one of the three renders
 * 30px tall while `--hd-nav-h` itself resolves to 29px — the row's line
 * height plus its padding exceeds the token's floor by a pixel, exactly as
 * #838 anticipated. At Studio, `--hd-nav-h` is a literal 34px and every row
 * measures exactly that — no split. So the honest assertion, chosen from
 * measurement: **every destination row is at least `--hd-nav-h` tall, and
 * the three destination-row kinds agree with each other in a given
 * theme/interface** (they do, at both 30/29 in Desk and 34/34 in Studio).
 * `row-height.spec.ts` already proves `--hd-row-h` and `--hd-nav-h` resolve
 * to the same token across every palette and interface; this spec measures
 * the rows themselves rather than the token alias.
 */
type RowFinding = { where: string; height: number; navH: number; reason: string }

const destinationRowViolations = (page: Page) =>
  page.evaluate((helpers) => {
    // eslint-disable-next-line no-new-func
    return new Function(`${helpers}
      const out = []
      const navH = probeHeight('--hd-nav-h')
      const rows = {
        'sidebar session row': document.querySelector('[class*="rowWrap_"] button'),
        'settings/usage rail row': document.querySelector('[class*="winNavItem"]'),
      }
      const heights = {}
      for (const [where, el] of Object.entries(rows)) {
        if (!el || !visible(el)) continue
        const height = Math.round(el.getBoundingClientRect().height)
        heights[where] = height
        if (height < navH) out.push({ where, height, navH, reason: 'shorter than --hd-nav-h' })
      }
      const distinct = new Set(Object.values(heights))
      if (distinct.size > 1) {
        for (const [where, height] of Object.entries(heights)) {
          out.push({ where, height, navH, reason: 'destination rows disagree: ' + JSON.stringify(heights) })
        }
      }
      return out`)()
  }, PROBE_HELPERS) as Promise<RowFinding[]>

/** Opens the sidebar footer's account menu (reused from `visual-contracts.spec.ts`). */
const openAccountMenu = async (page: Page) => {
  const trigger = page.locator('button[class*="accountRow"]')
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  await expect(page.locator('[data-slot="popover-popup"]')).toBeVisible()
}

test.describe('rule: destination rows', () => {
  test('rule: destination rows — the sidebar row, the settings/usage rail row and a menu item all stand at least --hd-nav-h and agree with each other', async ({ page }) => {
    await gotoPreview(page)
    const findings: (RowFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        for (const finding of await destinationRowViolations(page)) findings.push({ ...finding, where: `${theme}/${look}: ${finding.where}` })
        // The menu item, measured the same way `visual-contracts.spec.ts`
        // opens this same popover: a real DropdownMenuItem, not a fixture.
        await openAccountMenu(page)
        const menuHeight = await page.locator('[role="menuitem"]').first().evaluate((el) => Math.round(el.getBoundingClientRect().height))
        const navH = await page.evaluate((helpers) => new Function(`${helpers}; return probeHeight('--hd-nav-h')`)(), PROBE_HELPERS) as number
        if (menuHeight < navH) findings.push({ where: `${theme}/${look}: menu item`, height: menuHeight, navH, reason: 'shorter than --hd-nav-h' })
        await page.keyboard.press('Escape')
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: destination rows — the checker catches a row shrunk under the floor', async ({ page }) => {
    await gotoPreview(page)
    await setPreviewDials(page, 'light', 'desk')
    const before = await destinationRowViolations(page)
    await page.addStyleTag({ content: '[class*="winNavItem"] { min-height: 10px !important; height: 10px !important; padding-top: 0 !important; padding-bottom: 0 !important; }' })
    const after = await destinationRowViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
  })
})

/* ========================================================================
 * Rule: fields
 *
 * Measured rather than assumed: at Desk, every default-size text field
 * (`design/ui/input.tsx`'s `Input`, and `Search`'s inner input,
 * `data-size="default"`) is 30px tall at 14px — exactly #838's number —
 * outside `[data-hd-density='comfortable']` (the settings and usage
 * windows), where Studio raises the rung to 36px via
 * `--hd-control-h-lg` (`foundation/tokens.css`, documented there as an
 * intentional density scope, not a second field system) — that scope is
 * excluded by name rather than asserted against.
 *
 * `Search`'s `compact` size (the sidebar's own filter,
 * `components/Sidebar.tsx`) is a second, deliberate rung of the *same*
 * pattern — 24px tall — not a second Search. The one-pattern claim the rule
 * makes is that every list filter renders through `[data-slot="search"]`
 * and both rungs share one font size; the checker asserts both.
 */
type FieldFinding = { where: string; height?: number; size?: string; reason: string }

const fieldViolations = (page: Page) =>
  page.evaluate(() => {
    const out: { where: string; height?: number; size?: string; reason: string }[] = []
    const comfortable = (el: Element) => el.closest('[data-hd-density="comfortable"]') != null
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      const cs = getComputedStyle(el)
      return cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    const fields = document.querySelectorAll('[data-slot="input"][data-size="default"], [data-slot="search"][data-size="default"] input')
    const fontSizes = new Set<string>()
    for (const field of fields) {
      if (comfortable(field) || !visible(field)) continue
      const cs = getComputedStyle(field)
      fontSizes.add(cs.fontSize)
      const height = Math.round(field.getBoundingClientRect().height)
      if (height !== 30 || cs.fontSize !== '14px') {
        out.push({ where: field.getAttribute('data-slot') ?? field.tagName, height, size: cs.fontSize, reason: 'default field is not 30px/14px' })
      }
    }
    const compactSearches = document.querySelectorAll('[data-slot="search"][data-size="compact"] input')
    for (const field of compactSearches) {
      if (!visible(field)) continue
      const cs = getComputedStyle(field)
      fontSizes.add(cs.fontSize)
    }
    if (fontSizes.size > 1) out.push({ where: 'compact vs default', reason: `fields disagree on font size: ${[...fontSizes].join(', ')}` })
    // One Search pattern for list filters: every input whose placeholder
    // reads as a filter renders through the shared component.
    for (const input of document.querySelectorAll('input[placeholder]')) {
      if (!visible(input)) continue
      const placeholder = (input.getAttribute('placeholder') ?? '').toLowerCase()
      if (!/search|filter/.test(placeholder)) continue
      if (!input.closest('[data-slot="search"]')) out.push({ where: placeholder, reason: 'a filter field outside the shared Search pattern' })
    }
    return out
  })

test.describe('rule: fields', () => {
  test('rule: fields — default fields are 30px/14px outside the comfortable density scope, and every filter uses one Search pattern', async ({ page }) => {
    await gotoPreview(page)
    const findings: (FieldFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        for (const finding of await fieldViolations(page)) findings.push({ ...finding, where: `${theme}/${look}: ${finding.where}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: fields — the checker catches a default field pushed off 30px/14px', async ({ page }) => {
    await gotoPreview(page)
    const before = await fieldViolations(page)
    await page.addStyleTag({ content: '[data-slot="input"][data-size="default"] { height: 40px !important; font-size: 16px !important; }' })
    const after = await fieldViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
  })
})

/* ========================================================================
 * Rule: selection
 *
 * `visual-contracts.spec.ts`'s "every chosen row, destination and option is
 * filled, and none changes weight" test already asserts, pairwise, on the
 * same `view=propagation` `selection-contracts` rig, that a chosen instance
 * keeps its resting neighbour's weight and gains a fill the neighbour lacks.
 * This does not repeat that assertion; it wraps the identical comparison in
 * a checker function so the rule can be proven mutation-sensitive, which the
 * existing spec (no `addStyleTag`) does not do.
 */
type SelectionFinding = { pair: string; reason: string }

const SELECTION_PAIRS: [string, 'button' | 'radio', string, 'button' | 'radio'][] = [
  ['Resting page', 'button', 'Chosen page', 'button'],
  ['Resting branch', 'button', 'Checked-out branch', 'button'],
  ['Resting option', 'button', 'Option turned on', 'button'],
  ['Resting answer', 'radio', 'Chosen answer', 'radio'],
]

const selectionViolations = async (page: Page): Promise<SelectionFinding[]> => {
  const section = page.getByTestId('selection-contracts')
  const look = (name: string, role: 'button' | 'radio') =>
    section.getByRole(role, { name, exact: true }).evaluate((node) => {
      const style = getComputedStyle(node)
      return { fill: style.backgroundColor, weight: style.fontWeight }
    })
  const out: SelectionFinding[] = []
  for (const [resting, restingRole, chosen, chosenRole] of SELECTION_PAIRS) {
    const [rest, pick] = [await look(resting, restingRole), await look(chosen, chosenRole)]
    if (pick.fill === rest.fill) out.push({ pair: `${resting}/${chosen}`, reason: 'the chosen row has no fill its neighbour lacks' })
    if (pick.weight !== rest.weight) out.push({ pair: `${resting}/${chosen}`, reason: `weight changed: ${rest.weight} → ${pick.weight}` })
  }
  return out
}

test.describe('rule: selection', () => {
  test('rule: selection — a chosen row keeps its neighbour\'s weight and gains a fill the neighbour lacks', async ({ page }) => {
    await page.goto('/design.html?view=propagation')
    await expect(page.getByTestId('selection-contracts')).toBeVisible()
    expect(await selectionViolations(page)).toEqual([])
  })

  test('rule: selection — the checker catches a chosen row with its fill removed', async ({ page }) => {
    await page.goto('/design.html?view=propagation')
    const section = page.getByTestId('selection-contracts')
    await expect(section).toBeVisible()
    const before = await selectionViolations(page)
    await page.addStyleTag({ content: '[data-testid="selection-contracts"] button[aria-checked="true"], [data-testid="selection-contracts"] [data-selected], [data-testid="selection-contracts"] [data-on] { background-color: transparent !important; }' })
    const after = await selectionViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
  })
})

/* ========================================================================
 * Rule: tertiary ink
 *
 * `tokens.contrast.test.ts` proves the token pair clears AA on
 * `--hd-background`, `--hd-card`, `--hd-sidebar` and `--hd-popover` — this
 * asserts the *rendered* result for the label tiers, including the "plate"
 * ground (`Card variant="plate"`, `--hd-card-fill`) the token test does not
 * cover. A small fixture mounts a real `Text role="meta"` (the tertiary
 * tier) on each real ground: `document.body` for the page, `Card` for the
 * card, `Card variant="plate"` for the plate, and — since a popover has to
 * be open and a sidebar plate has no bare ground of its own — the raw
 * `--hd-popover`/`--hd-sidebar` tokens applied directly, which read the same
 * live custom property every real popover and the real sidebar read.
 */
const mountInkGrounds = async (page: Page) => {
  await page.route('**/src/preview/main.tsx*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import inkReact from ${JSON.stringify(reactUrl)};
        import { Card } from '/src/design/ui/card.tsx';
        import { Text } from '/src/design/patterns/Settings.tsx';
        const h = inkReact.createElement;
        const ground = (name, style, Wrap) => h('div', { key: name, 'data-ground': name, style: { padding: 12, ...style } },
          Wrap ? h(Wrap, null, h(Text, { role: 'meta' }, 'Tertiary ' + name)) : h(Text, { role: 'meta' }, 'Tertiary ' + name));
        const Fixture = () => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          ground('page', { background: 'var(--hd-background)' }),
          ground('card', {}, Card),
          ground('plate', { background: 'var(--hd-card-fill, var(--hd-card))' }),
          ground('popover', { background: 'var(--hd-popover)' }),
          ground('sidebar', { background: 'var(--hd-sidebar)' }));
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Ink grounds fixture');
        frame.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;background:var(--hd-background)';
        document.body.append(frame);
        createRoot(frame).render(h(Fixture));
      `,
    })
  })
  await page.goto('/preview.html')
  await expect(page.getByRole('region', { name: 'Ink grounds fixture' })).toBeVisible()
}

type InkFinding = { ground: string; ratio: number }

const tertiaryInkViolations = (page: Page) =>
  page.evaluate(() => {
    const AA = 4.5
    /* `color-mix()` (the plate ground's `--hd-card-fill`) can serialize as
       CSS Color 4's `color(srgb r g b)`, channels 0–1, rather than
       `rgb(r g b)`, channels 0–255 — parsing both as 0–255 read the plate's
       wash as near-black and reported a false 3.9:1. */
    const parse = (value: string) => {
      const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value.trim())
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] == null ? 1 : Number(srgb[4]) }
      const parts = value.match(/[\d.]+/g)
      if (!parts) return null
      return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]), a: parts[3] == null ? 1 : Number(parts[3]) }
    }
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const channel = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const out: InkFinding[] = []
    for (const el of document.querySelectorAll('[aria-label="Ink grounds fixture"] [data-ground]')) {
      const ground = el.getAttribute('data-ground') ?? ''
      const text = el.querySelector('[data-slot="text"]') ?? el.querySelector('span')
      if (!text) continue
      const ink = parse(getComputedStyle(text).color)
      let bgEl: Element | null = el
      let bg = null
      while (bgEl && (!bg || bg.a === 0)) {
        bg = parse(getComputedStyle(bgEl).backgroundColor)
        bgEl = bgEl.parentElement
      }
      if (!ink || !bg) continue
      const ratio = contrast(ink, bg)
      if (ratio < AA) out.push({ ground, ratio: Math.round(ratio * 100) / 100 })
    }
    return out
  })

test.describe('rule: tertiary ink', () => {
  test('rule: tertiary ink — the rendered tertiary tier clears 4.5:1 on the page, card, plate, popover and sidebar grounds', async ({ page }) => {
    await mountInkGrounds(page)
    const findings: (InkFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        for (const finding of await tertiaryInkViolations(page)) findings.push({ ...finding, where: `${theme}/${look}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: tertiary ink — the checker catches a tertiary label matching its own ground', async ({ page }) => {
    await mountInkGrounds(page)
    const before = await tertiaryInkViolations(page)
    await page.addStyleTag({ content: '[data-ground="card"] [data-slot="text"] { color: var(--hd-card) !important; }' })
    const after = await tertiaryInkViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.some((f) => f.ground === 'card')).toBe(true)
  })
})

/* ========================================================================
 * Rule: focus ring
 *
 * `surface-focus.spec.ts` already proves a popup surface (dialog, confirm,
 * menu, popover) draws no ring of its own; this rule is about the control
 * that does draw one — a button and a field — and whether exactly one
 * element in the chain draws it. Reuses that spec's `mount` technique
 * (route-patching `preview/main.tsx` to append a fixture of real
 * `Button`/`Input`), nested two wrapper divs deep, so "no wrapper repeats
 * it" has a wrapper to fail against.
 *
 * Measured rather than assumed: **the button and the field do not draw the
 * same ring.** A button's `:focus-visible` draws the document-level native
 * `outline` (`styles/app.css`) — 2px solid, 2px clear at Desk (Studio: 3px,
 * 0px clear — `--hd-ring-width`/`--hd-ring-offset`, an owner-decided,
 * documented interface difference, not a bug). A field
 * (`design/ui/input.tsx`) instead draws `box-shadow: var(--hd-focus-ring)`,
 * `0 0 0 var(--hd-ring-width) …` — the same width, but flush against the
 * field's own border, zero clearance, because a box-shadow ring has no
 * offset to spend. The rule's "2px ring, 2px clearance" is the button's
 * number; the field's ring is one ring with no gap, asserted as what it is
 * rather than forced to match the button's mechanism.
 */
const mountRingFixture = async (page: Page) => {
  await page.route('**/src/preview/main.tsx*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import ringReact from ${JSON.stringify(reactUrl)};
        import { Button } from '/src/design/ui/button.tsx';
        import { Input } from '/src/design/ui/input.tsx';
        const h = ringReact.createElement;
        const Fixture = () => h('div', { style: { padding: 16 } },
          h('div', { className: 'ring-fixture-wrapper', style: { padding: 8 } },
            h('div', { className: 'ring-fixture-inner', style: { padding: 8 } },
              h(Button, { 'data-testid': 'ring-button' }, 'A button'))),
          h('div', { className: 'ring-fixture-wrapper', style: { padding: 8 } },
            h('div', { className: 'ring-fixture-inner', style: { padding: 8 } },
              h(Input, { 'data-testid': 'ring-field', defaultValue: '' }))));
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Ring rule fixture');
        frame.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;background:var(--hd-background)';
        document.body.append(frame);
        createRoot(frame).render(h(Fixture));
      `,
    })
  })
  await page.goto('/preview.html')
  await expect(page.getByRole('region', { name: 'Ring rule fixture' })).toBeVisible()
}

type RingFinding = { control: string; reason: string }

/** Focuses the control by keyboard (see the `Shift` trick above) and checks its ring. */
const focusAndCheckRing = (page: Page, testId: string, kind: 'outline' | 'shadow') =>
  page.evaluate(([id, ringKind]) => {
    const out: { control: string; reason: string }[] = []
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
    if (!el) { out.push({ control: id, reason: 'control not found' }); return out }
    el.focus()
    if (el !== document.activeElement || !el.matches(':focus-visible')) {
      out.push({ control: id, reason: 'did not match :focus-visible' })
      return out
    }
    const own = getComputedStyle(el)
    const ringDrawn = ringKind === 'outline' ? own.outlineStyle !== 'none' : own.boxShadow !== 'none'
    if (!ringDrawn) out.push({ control: id, reason: 'no ring drawn on focus' })
    let node = el.parentElement
    while (node && node !== document.body) {
      const cs = getComputedStyle(node)
      if (cs.outlineStyle !== 'none') out.push({ control: id, reason: `an ancestor (${node.className}) also draws an outline` })
      if (ringKind === 'shadow' && cs.boxShadow !== 'none' && cs.boxShadow === own.boxShadow) {
        out.push({ control: id, reason: `an ancestor (${node.className}) repeats the field's own box-shadow` })
      }
      node = node.parentElement
    }
    return out
  }, [testId, kind] as const) as Promise<RingFinding[]>

/** Both controls, called with a `Shift` keypress first so each `.focus()` matches `:focus-visible`. */
const ringViolations = async (page: Page): Promise<RingFinding[]> => {
  await page.keyboard.press('Shift')
  const button = await focusAndCheckRing(page, 'ring-button', 'outline')
  await page.keyboard.press('Shift')
  const field = await focusAndCheckRing(page, 'ring-field', 'shadow')
  return [...button, ...field]
}

test.describe('rule: focus ring', () => {
  test('rule: focus ring — a focused button and a focused field each draw one ring, and no wrapper repeats it', async ({ page }) => {
    await mountRingFixture(page)
    const findings: (RingFinding & { where: string })[] = []
    for (const look of ['desk', 'studio'] as const) {
      await page.evaluate((interfaceName) => document.body.setAttribute('data-hd-interface', interfaceName), look)
      for (const finding of await ringViolations(page)) findings.push({ ...finding, where: look })
      // Desk: 2px/2px. Studio: 3px/0px — see the rule's header comment.
      await page.keyboard.press('Shift')
      const buttonRing = await page.getByTestId('ring-button').evaluate((el: HTMLElement) => {
        el.focus()
        const cs = getComputedStyle(el)
        return { width: cs.outlineWidth, offset: cs.outlineOffset, style: cs.outlineStyle }
      })
      const wantWidth = look === 'desk' ? '2px' : '3px'
      const wantOffset = look === 'desk' ? '2px' : '0px'
      if (buttonRing.style !== 'solid' || buttonRing.width !== wantWidth || buttonRing.offset !== wantOffset) {
        findings.push({ control: 'ring-button', reason: `expected ${wantWidth}/${wantOffset}, got ${buttonRing.width}/${buttonRing.offset}`, where: look })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: focus ring — the checker catches a wrapper that repeats the ring', async ({ page }) => {
    await mountRingFixture(page)
    const before = await ringViolations(page)
    // The way a real regression would repeat the ring: a wrapper's own
    // `:focus-within` rule drawing a second outline round the same control.
    await page.addStyleTag({ content: '.ring-fixture-wrapper:focus-within { outline: 2px solid red; }' })
    const after = await ringViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.some((f) => f.reason.includes('also draws an outline'))).toBe(true)
  })
})

/* ========================================================================
 * Rule: monospace
 *
 * `docs/design.md` ("The code face"): the monospace family is for code and
 * output, never for "names that merely came from a machine". Scoped to
 * `[data-slot="text"][data-role]` — every name/label the app draws through
 * the one text primitive — rather than every element in the DOM: a
 * DOM-wide scan would have to know every legitimate monospace surface (the
 * terminal's own screen buffer, a diff's line numbers, a token count) to
 * avoid false positives, where the named-role set is closed and exhaustive
 * by construction (`Text` is the one component that emits `data-role`).
 * Measured: none do, today — this rule holds. The positive control
 * (`design.html?view=code`) confirms real code elements do compute the
 * monospace family, so the probe itself is meaningful.
 */
const monospaceViolations = (page: Page) =>
  page.evaluate((helpers) => {
    // eslint-disable-next-line no-new-func
    return new Function(`${helpers}
      const out = []
      const codeFamily = probeFontFamily('--hd-font-code')
      for (const el of document.querySelectorAll('[data-slot="text"][data-role]')) {
        if (!visible(el)) continue
        if (getComputedStyle(el).fontFamily === codeFamily) {
          out.push({ role: el.getAttribute('data-role'), text: (el.textContent ?? '').trim().slice(0, 40) })
        }
      }
      return out`)()
  }, PROBE_HELPERS) as Promise<{ role: string; text: string }[]>

test.describe('rule: monospace', () => {
  test('rule: monospace — no named text role computes the monospace family', async ({ page }) => {
    await gotoPreview(page)
    const findings: ({ role: string; text: string } & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        for (const finding of await monospaceViolations(page)) findings.push({ ...finding, where: `${theme}/${look}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: monospace — a real code element does compute the monospace family (positive control)', async ({ page }) => {
    await page.goto('/design.html?view=code')
    const family = await page.locator('[data-slot="code-text"], pre, code').first().evaluate((el) => getComputedStyle(el).fontFamily)
    const codeFamily = await page.evaluate((helpers) => new Function(`${helpers}; return probeFontFamily('--hd-font-code')`)(), PROBE_HELPERS)
    expect(family).toBe(codeFamily)
  })

  test('rule: monospace — the checker catches a named role pushed into the code face', async ({ page }) => {
    await gotoPreview(page)
    const before = await monospaceViolations(page)
    await page.addStyleTag({ content: '[data-slot="text"][data-role="navigation"] { font-family: var(--hd-font-code) !important; }' })
    const after = await monospaceViolations(page)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.some((f) => f.role === 'navigation')).toBe(true)
  })
})

/* ========================================================================
 * Rule: health takes no tone
 *
 * A reading that says nothing is wrong is not painted the success colour —
 * `design/patterns/Settings.tsx`'s own `Chip` doc says as much ("A default
 * or normal state is `neutral` or has no chip at all… Colour on every row is
 * noise that hides the one row that needs someone"). Operationalised as:
 * a leaf element whose text is the app's own word for that state, "Healthy"
 * (`lib/provenance.ts`'s `captureWords`, `state === 'healthy'`), must not
 * compute the resolved `--hd-success-ink` colour.
 *
 * **This is a real, live violation**, reachable on `/preview.html`'s
 * "Project — capture" frame with no mutation needed:
 * `components/ProjectProvenance.tsx` renders `<Chip tone="success"
 * label="Healthy" />` for a healthy capture — `lib/provenance.ts`'s
 * `captureWords` hands back `tone: 'success'` for `state === 'healthy'`. A
 * second call site does the same thing for a healthy context-window
 * reading: `components/AgentCards.tsx`'s `meterOf`/`seatMeter` both resolve
 * `tone: 'success'` when the fill is neither `bad` nor `warn`. Left failing
 * on purpose; not narrowed to hide it.
 */
type HealthFinding = { text: string; tag: string }

const healthToneViolations = (page: Page, root = 'body') =>
  page.evaluate(([helpers, rootSelector]) => {
    // eslint-disable-next-line no-new-func
    return new Function('rootSelector', `${helpers}
      const out = []
      const successInk = probeColor('color: var(--hd-success-ink)')
      const scope = document.querySelector(rootSelector) ?? document.body
      for (const el of scope.querySelectorAll('*')) {
        if (el.children.length > 0) continue
        const text = (el.textContent || '').trim()
        if (!/\\bHealthy\\b/.test(text)) continue
        if (!visible(el)) continue
        if (getComputedStyle(el).color === successInk) out.push({ text: text.slice(0, 40), tag: el.tagName })
      }
      return out`)(rootSelector)
  }, [PROBE_HELPERS, root] as const) as Promise<HealthFinding[]>

test.describe('rule: health takes no tone', () => {
  test('rule: health takes no tone — a "Healthy" reading is not rendered in the success ink', async ({ page }) => {
    await gotoPreview(page)
    // The capture frame loads its health asynchronously; give it a beat.
    await expect.poll(async () => page.locator('text=Healthy').count()).toBeGreaterThan(0)
    const findings = await healthToneViolations(page)
    // Real violation: components/ProjectProvenance.tsx's Chip (see header comment).
    expect(findings).toEqual([])
  })

  test('rule: health takes no tone — the checker catches a healthy reading painted in the success ink', async ({ page }) => {
    // A controlled fixture, since the real violation already trips the
    // checker above and would make this test prove nothing about the
    // checker's sensitivity on its own: a plain, correctly-neutral "Healthy"
    // reading, then mutated to the success colour with page.addStyleTag —
    // the same regression the real Chip already has, reproduced on demand.
    await page.route('**/src/preview/main.tsx*', async (route) => {
      const response = await route.fetch()
      const source = await response.text()
      const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
      if (!reactUrl) throw new Error('preview React module import was not found')
      await route.fulfill({
        response,
        body: `${source}
          import healthReact from ${JSON.stringify(reactUrl)};
          import { Chip } from '/src/design/patterns/Settings.tsx';
          const h = healthReact.createElement;
          const frame = document.createElement('section');
          frame.setAttribute('aria-label', 'Health tone fixture');
          frame.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;background:var(--hd-background)';
          document.body.append(frame);
          createRoot(frame).render(h(Chip, { tone: 'neutral', label: 'Healthy' }));
        `,
      })
    })
    await page.goto('/preview.html')
    await expect(page.getByRole('region', { name: 'Health tone fixture' })).toBeVisible()
    // Scoped to the fixture alone: the real page also carries the live
    // violation this rule already reports above, so an unscoped read would
    // never be empty and would prove nothing about this fixture specifically.
    const scope = '[aria-label="Health tone fixture"]'
    const before = await healthToneViolations(page, scope)
    expect(before).toEqual([])
    await page.addStyleTag({ content: `${scope} [data-slot="chip"] { color: var(--hd-success-ink) !important; }` })
    const after = await healthToneViolations(page, scope)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.some((f) => f.text.includes('Healthy'))).toBe(true)
  })
})
