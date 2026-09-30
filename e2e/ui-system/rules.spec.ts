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
 * A rule the real app violates is never weakened or skipped to pass it: the
 * violation is named, and either the app is fixed or the rule is scoped to
 * the deliberate difference (an interface's own choice, an owner question
 * still open). `docs/design.md` ("## The rules") documents the measured
 * values and which of those two happened, per rule.
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
 * — so the checker only looks at the six name roles. A name drawn outside
 * `Text`/`PageHead` altogether (`EmptyState`'s h3, a `Notices` title,
 * `AgentCard`'s own name) is out of this rule's reach and tracked separately
 * (#1072), not silently passed.
 *
 * Measured on `/preview.html`'s full set of mounted screens, across every
 * theme and interface (the pairs are named in tokens, not in the interface
 * layer, so they do not vary by dial — this proves that rather than assumes
 * it). The pull-request card's title (`components/Publication.tsx`) was the
 * one name wearing `weight="semibold"` — the weight `weight` exists for
 * lifting a search match, not a title — and now takes its row role's own.
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
    let measured = 0
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
      measured += 1
      const cs = getComputedStyle(el)
      const size = Math.round(parseFloat(cs.fontSize))
      const weight = Number(cs.fontWeight)
      const text = (el.textContent ?? '').trim().slice(0, 60)
      if (size === 16) out.push({ role, text, size, weight, reason: '16px, which no name role may be' })
      else if (weight === 600 && role !== 'wordmark' && role !== 'page') out.push({ role, text, size, weight, reason: 'semibold outside the wordmark and the page title' })
      else if (size !== wanted.size || weight !== wanted.weight) out.push({ role, text, size, weight, reason: `role ${role} wants ${wanted.size}/${wanted.weight}` })
    }
    return { out, measured }
  }, NAME_PAIRS)

test.describe('rule: names', () => {
  test('rule: names — every name role computes its allowed size and weight, in every theme and interface', async ({ page }) => {
    await gotoPreview(page)
    const findings: NameFinding[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        const { out, measured } = await namesViolations(page)
        // A check that measures nothing must fail, not pass by default.
        expect(measured, `${theme}/${look}: no name-role element was found`).toBeGreaterThan(0)
        for (const finding of out) findings.push({ ...finding, reason: `${theme}/${look}: ${finding.reason}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: names — the checker catches a name role pushed to 16px', async ({ page }) => {
    await gotoPreview(page)
    const before = await namesViolations(page)
    await page.addStyleTag({ content: '[data-slot="text"][data-role="row"] { font-size: 16px !important; }' })
    const after = await namesViolations(page)
    expect(after.out.length).toBeGreaterThan(before.out.length)
    expect(after.out.some((f) => f.reason.includes('16px'))).toBe(true)
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
 * The weight is the interface's label weight: regular in Desk, and in
 * Studio the medium its `--hd-label-weight` sets on purpose
 * (`foundation/tokens.css`: "Studio varies only the weight and the air
 * above a rail's group"). Size, ink and case are the same in both.
 */
type GroupLabelFinding = { text: string; transform: string; weight: number }

/** The label weight each interface sets: regular in Desk, medium in Studio. */
const LABEL_WEIGHT = { desk: 400, studio: 500 } as const

const groupLabelViolations = (page: Page, expectedWeight: number = LABEL_WEIGHT.desk) =>
  page.evaluate((expected) => {
    const out: GroupLabelFinding[] = []
    for (const el of document.querySelectorAll('[data-slot="group-label"]')) {
      const cs = getComputedStyle(el)
      const transform = cs.textTransform
      const weight = Number(cs.fontWeight)
      if (transform === 'uppercase' || weight !== expected) {
        out.push({ text: (el.textContent ?? '').trim().slice(0, 40), transform, weight })
      }
    }
    return out
  }, expectedWeight)

test.describe('rule: group labels', () => {
  test('rule: group labels — text-transform is never uppercase and the weight is the interface\'s label weight (regular in Desk), in every theme', async ({ page }) => {
    await gotoPreview(page)
    const findings: (GroupLabelFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        // A check that measures nothing must fail, not pass by default.
        expect(await page.locator('[data-slot="group-label"]:visible').count(), `${theme}/${look}: no group label was found`).toBeGreaterThan(0)
        for (const finding of await groupLabelViolations(page, LABEL_WEIGHT[look])) findings.push({ ...finding, where: `${theme}/${look}` })
      }
    }
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

  test('rule: group labels — the checker catches a group label set heavier than its interface\'s weight', async ({ page }) => {
    await gotoPreview(page)
    await setPreviewDials(page, 'light', 'desk')
    expect(await groupLabelViolations(page, LABEL_WEIGHT.desk)).toEqual([])
    await page.addStyleTag({ content: '[data-slot="group-label"] { font-weight: 600 !important; }' })
    const after = await groupLabelViolations(page, LABEL_WEIGHT.desk)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((f) => f.weight === 600)).toBe(true)
  })
})

/* ========================================================================
 * Rule: destination rows
 *
 * A navigation row is `--hd-nav-h` tall wherever it appears: every one of
 * the sidebar's session rows (`components/SessionTree.tsx`, all of
 * `[class*="rowWrap_"] button` — selector reused from
 * `sidebar-roles.spec.ts`), every settings/usage rail row (`AppWindow.tsx`'s
 * `WindowNavItem`, all of `.winNavItem` — both windows share this file), and
 * a dropdown menu item (`design/ui/dropdown-menu.tsx`). The rail row and the
 * menu item both carry the Tailwind `size="navigation"` recipe
 * (`min-h-(--hd-nav-h)`, `py-1`, `text-(length:--hd-text-sm)`,
 * `leading-(--hd-line-sm)`) with nothing else added; the sidebar's session
 * row carries that same recipe too, but its `Button` also carries
 * `Sidebar.module.css`'s own `.rowWrap`/`.row` rules (flex alignment, width,
 * gap — no height or padding of their own). So the three are not one
 * recipe repeated three times, but they render at one height because
 * nothing the sidebar's own sheet adds touches height.
 *
 * Measured on every instance, not one sample per kind. Every row of every
 * kind is at least `--hd-nav-h` tall, every row of one kind agrees with its
 * own siblings, and the kinds agree with each other — in both interfaces.
 * Studio's rows are 34px. Desk's are 30px since #1073: `--hd-nav-h` used to
 * be solved from the type alone (29px), so the sidebar's session rows and
 * the menu item, whose line, block padding and border add up to 30, stood a
 * pixel taller than the rail's rows on the floor. It is now solved from
 * that same box, and every kind stands on it.
 *
 * Agreement across kinds is a claim about one-line rows, measured at the
 * session list's compact density, which is what the preview renders. At
 * comfortable density a session row carries a second line and more air —
 * a preview, or a chip on a row that needs you — and stands taller by
 * design; it is still floored at --hd-nav-h, but it is not the rail's row.
 *
 * The settings rail's identity row was the one row of a kind that disagreed
 * with its siblings: its 28px face in a 29px row with 1px borders pushed it
 * to 30px. It now draws the seat's own 24px face, the size the sidebar's
 * seat row uses, and sits with the rest. `row-height.spec.ts` already proves
 * `--hd-row-h` and `--hd-nav-h` resolve to the same token across every
 * palette and interface; this spec measures the rows themselves.
 */
type RowFinding = { where: string; height: number; navH: number; reason: string }

const destinationRowViolations = (page: Page, menuHeight?: number, kindsAgree = true) =>
  page.evaluate(([helpers, menuH, acrossKindsToo]) => {
    // eslint-disable-next-line no-new-func
    return new Function('menuH', 'acrossKindsToo', `${helpers}
      const out = []
      let measured = 0
      const navH = probeHeight('--hd-nav-h')
      const measure = (selector) => [...document.querySelectorAll(selector)]
        .filter(visible)
        .map((el) => Math.round(el.getBoundingClientRect().height))
      const groups = {
        'sidebar session row': measure('[class*="rowWrap_"] button'),
        'settings/usage rail row': measure('[class*="winNavItem"]'),
      }
      if (menuH != null) groups['menu item'] = [menuH]
      const representative = {}
      for (const [where, list] of Object.entries(groups)) {
        measured += list.length
        for (const height of list) {
          if (height < navH) out.push({ where, height, navH, reason: 'shorter than --hd-nav-h' })
        }
        const distinctOwn = new Set(list)
        if (distinctOwn.size > 1) {
          out.push({ where, height: list[0], navH, reason: where + "'s own rows disagree: " + JSON.stringify(list) })
        } else if (distinctOwn.size === 1) {
          representative[where] = list[0]
        }
      }
      const acrossKinds = new Set(Object.values(representative))
      if (acrossKindsToo && acrossKinds.size > 1) {
        for (const [where, height] of Object.entries(representative)) {
          out.push({ where, height, navH, reason: 'destination-row kinds disagree: ' + JSON.stringify(representative) })
        }
      }
      const counts = Object.fromEntries(Object.entries(groups).map(([where, list]) => [where, list.length]))
      return { out, measured, counts }`)(menuH, acrossKindsToo)
  }, [PROBE_HELPERS, menuHeight, kindsAgree] as const) as Promise<{ out: RowFinding[]; measured: number; counts: Record<string, number> }>

/** Opens the sidebar footer's account menu (reused from `visual-contracts.spec.ts`). */
const openAccountMenu = async (page: Page) => {
  const trigger = page.locator('button[class*="accountRow"]')
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  await expect(page.locator('[data-slot="popover-popup"]')).toBeVisible()
}

test.describe('rule: destination rows', () => {
  test('rule: destination rows — every sidebar row, every rail row and a menu item stand at least --hd-nav-h, each kind agrees with itself, and the kinds agree with each other in both interfaces', async ({ page }) => {
    await gotoPreview(page)
    const findings: (RowFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        // The menu item, measured the same way `visual-contracts.spec.ts`
        // opens this same popover: a real DropdownMenuItem, not a fixture —
        // folded into the same agreement set the sidebar and rail rows are.
        await openAccountMenu(page)
        const menuHeight = await page.locator('[role="menuitem"]').first().evaluate((el) => Math.round(el.getBoundingClientRect().height))
        await page.keyboard.press('Escape')
        const { out, measured, counts } = await destinationRowViolations(page, menuHeight)
        // A check that measures nothing must fail, not pass by default — and
        // per kind, not in total: the menu item alone would make `measured`
        // non-zero, and agreement across kinds means nothing with a kind
        // missing.
        expect(measured, `${theme}/${look}: no destination row was found`).toBeGreaterThan(0)
        for (const [where, count] of Object.entries(counts)) {
          expect(count, `${theme}/${look}: no ${where} was found`).toBeGreaterThan(0)
        }
        for (const finding of out) findings.push({ ...finding, where: `${theme}/${look}: ${finding.where}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: destination rows — the checker catches a row shrunk under the floor', async ({ page }) => {
    await gotoPreview(page)
    await setPreviewDials(page, 'light', 'desk')
    const before = await destinationRowViolations(page, undefined, false)
    expect(before.out).toEqual([])
    await page.addStyleTag({ content: '[class*="winNavItem"] { min-height: 10px !important; height: 10px !important; padding-top: 0 !important; padding-bottom: 0 !important; }' })
    const after = await destinationRowViolations(page, undefined, false)
    expect(after.out.some((f) => f.reason === 'shorter than --hd-nav-h')).toBe(true)
  })

  test('rule: destination rows — the checker catches one row of a kind taller than its siblings', async ({ page }) => {
    await gotoPreview(page)
    await setPreviewDials(page, 'light', 'desk')
    const before = await destinationRowViolations(page, undefined, false)
    expect(before.out).toEqual([])
    // What the settings rail's identity row did with a 28px face in a 29px row.
    await page.addStyleTag({ content: '[class*="winNavItem"]:first-of-type { min-height: calc(var(--hd-nav-h) + 1px) !important; }' })
    const after = await destinationRowViolations(page, undefined, false)
    expect(after.out.some((f) => f.reason.includes("own rows disagree"))).toBe(true)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`rule: destination rows — the checker catches the kinds a pixel apart in Desk (${theme})`, async ({ page }) => {
      await gotoPreview(page)
      await setPreviewDials(page, theme, 'desk')
      const before = await destinationRowViolations(page)
      expect(before.out).toEqual([])
      expect(before.counts['settings/usage rail row']).toBeGreaterThan(0)
      // What Desk was before #1073, the other way round: one kind a pixel off
      // the others while agreeing with its own siblings.
      await page.addStyleTag({ content: '[class*="winNavItem"] { min-height: calc(var(--hd-nav-h) + 1px) !important; }' })
      const after = await destinationRowViolations(page)
      expect(after.out.some((f) => f.reason.startsWith('destination-row kinds disagree'))).toBe(true)
    })
  }
})

/* ========================================================================
 * Rule: fields
 *
 * Measured rather than assumed: every default-size text field
 * (`design/ui/input.tsx`'s `Input`, and `Search`'s inner input,
 * `data-size="default"`) is 30px tall at 14px — exactly #838's number —
 * **including** inside `[data-hd-density='comfortable']` (the settings and
 * usage windows) when the interface is Desk: `foundation/tokens.css`'s
 * universal `[data-hd-density='comfortable']` block only restates
 * `--hd-control-h` (the square controls), never `--hd-btn-h`/`--hd-field-h`
 * — the file's own comment records a past regression where restating those
 * two there dropped every labelled control in the settings and usage
 * windows to 26px, and the fix was to move that restatement into the
 * Studio-only scope beneath it. Only inside
 * `body[data-hd-interface='studio'] [data-hd-density='comfortable']` does
 * `--hd-field-h` become `--hd-control-h-lg`, 36px — a second, intentional
 * density rung, checked as its own number rather than excluded.
 *
 * `Search`'s `compact` size (the sidebar's own filter,
 * `components/Sidebar.tsx`) is a second, deliberate rung of the *same*
 * pattern — 24px tall — not a second Search. The one-pattern claim the rule
 * makes is that every list filter renders through `[data-slot="search"]`
 * and both rungs share one font size; the checker asserts both.
 */
type FieldFinding = { where: string; height?: number; size?: string; reason: string }

const fieldViolations = (page: Page, look: 'desk' | 'studio') =>
  page.evaluate((interfaceName) => {
    const out: { where: string; height?: number; size?: string; reason: string }[] = []
    let measuredDefault = 0
    let measuredComfortable = 0
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
      if (!visible(field)) continue
      measuredDefault += 1
      const inComfortable = comfortable(field)
      if (inComfortable) measuredComfortable += 1
      // Only Studio's comfortable scope raises the rung; Desk's own
      // comfortable windows stay on the ordinary 30px field.
      const wantHeight = interfaceName === 'studio' && inComfortable ? 36 : 30
      const cs = getComputedStyle(field)
      fontSizes.add(cs.fontSize)
      const height = Math.round(field.getBoundingClientRect().height)
      if (height !== wantHeight || cs.fontSize !== '14px') {
        out.push({ where: field.getAttribute('data-slot') ?? field.tagName, height, size: cs.fontSize, reason: `default field is not ${wantHeight}px/14px` })
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
    return { out, measuredDefault, measuredComfortable }
  }, look)

test.describe('rule: fields', () => {
  test('rule: fields — default fields are 30px/14px (36px in Studio\'s comfortable scope), and every filter uses one Search pattern', async ({ page }) => {
    await gotoPreview(page)
    const findings: (FieldFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        const { out, measuredDefault, measuredComfortable } = await fieldViolations(page, look)
        // A check that measures nothing must fail, not pass by default —
        // and the comfortable scope (settings/usage) is where the two
        // interfaces actually disagree, so it has to be exercised too.
        expect(measuredDefault, `${theme}/${look}: no default field was found`).toBeGreaterThan(0)
        expect(measuredComfortable, `${theme}/${look}: no field inside the comfortable density scope was found`).toBeGreaterThan(0)
        for (const finding of out) findings.push({ ...finding, where: `${theme}/${look}: ${finding.where}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: fields — the checker catches a default field pushed off 30px/14px', async ({ page }) => {
    await gotoPreview(page)
    const before = await fieldViolations(page, 'desk')
    await page.addStyleTag({ content: '[data-slot="input"][data-size="default"] { height: 40px !important; font-size: 16px !important; }' })
    const after = await fieldViolations(page, 'desk')
    expect(after.out.length).toBeGreaterThan(before.out.length)
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
 *
 * The catalogue rig proves the contract in the abstract; a second check
 * below proves it on two real destinations `/preview.html` already selects
 * by default — the sidebar's active session row (`data-active`) and the
 * settings rail's current page (`data-selected`, "General") — against an
 * unselected sibling of the same kind, in every theme and interface.
 */
type SelectionFinding = { pair: string; reason: string }

const realSelectionViolations = (page: Page) =>
  page.evaluate(() => {
    const out: { pair: string; reason: string }[] = []
    let measured = 0
    const compare = (pair: string, selectedSelector: string, restingSelector: string) => {
      const selected = document.querySelector(selectedSelector) as HTMLElement | null
      const resting = document.querySelector(restingSelector) as HTMLElement | null
      if (!selected || !resting) return
      measured += 1
      const s = getComputedStyle(selected)
      const r = getComputedStyle(resting)
      if (s.backgroundColor === r.backgroundColor) out.push({ pair, reason: 'the selected row has no fill its neighbour lacks' })
      if (s.fontWeight !== r.fontWeight) out.push({ pair, reason: `weight changed: ${r.fontWeight} → ${s.fontWeight}` })
    }
    compare(
      'sidebar session row',
      '[class*="rowWrap_"] button[data-active]',
      '[class*="rowWrap_"] button:not([data-active])',
    )
    compare(
      'settings/usage rail row',
      '[class*="winNavItem"][data-selected]',
      '[class*="winNavItem"]:not([data-selected])',
    )
    return { out, measured }
  })

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

  test('rule: selection — a real selected sidebar row and settings rail row keep the contract, in every theme and interface', async ({ page }) => {
    await gotoPreview(page)
    const findings: (SelectionFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        const { out, measured } = await realSelectionViolations(page)
        // A check that measures nothing must fail, not pass by default.
        expect(measured, `${theme}/${look}: no selected/resting pair was found`).toBe(2)
        for (const finding of out) findings.push({ ...finding, where: `${theme}/${look}` })
      }
    }
    expect(findings).toEqual([])
  })
})

/* ========================================================================
 * Rule: tertiary ink
 *
 * `tokens.contrast.test.ts` proves the token pair clears AA on
 * `--hd-background`, `--hd-card`, `--hd-sidebar` and `--hd-popover` — this
 * asserts the *rendered* result for the label tiers, including the "plate"
 * ground (`--hd-card-fill`, the fill `Card variant="plate"` paints itself
 * with) the token test does not cover. A small fixture mounts a real `Text
 * role="meta"` (the tertiary tier) on each real ground: the real `Card`
 * component for the card ground (so the text sits inside an actual card
 * rather than under one), and — since a popover has to be open and neither
 * a plate nor the sidebar has a bare ground of its own to mount into — the
 * raw `--hd-card-fill`/`--hd-popover`/`--hd-sidebar` tokens applied
 * directly on a plain div, which read the same live custom property every
 * real plate, popover and sidebar read.
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
    const grounds: string[] = []
    for (const el of document.querySelectorAll('[aria-label="Ink grounds fixture"] [data-ground]')) {
      const ground = el.getAttribute('data-ground') ?? ''
      const text = el.querySelector('[data-slot="text"]') ?? el.querySelector('span')
      if (!text) continue
      grounds.push(ground)
      const ink = parse(getComputedStyle(text).color)
      // Start the walk at the text's own parent, not at the ground `div`:
      // the card ground wraps its `Text` in a real `Card`, whose painted
      // background is a *descendant* of the ground div, never an ancestor
      // of it. Starting at the ground div and walking up skips the card
      // entirely and lands on the page behind it — the bug this comment
      // used to hide (the card ground read 3.92:1 against `--hd-background`
      // and reported it as the card's own contrast).
      let bgEl: Element | null = text.parentElement
      let bg = null
      while (bgEl && (!bg || bg.a === 0)) {
        bg = parse(getComputedStyle(bgEl).backgroundColor)
        bgEl = bgEl.parentElement
      }
      if (!ink || !bg) continue
      const ratio = contrast(ink, bg)
      if (ratio < AA) out.push({ ground, ratio: Math.round(ratio * 100) / 100 })
    }
    return { out, grounds }
  })

test.describe('rule: tertiary ink', () => {
  test('rule: tertiary ink — the rendered tertiary tier clears 4.5:1 on the page, card, plate, popover and sidebar grounds', async ({ page }) => {
    await mountInkGrounds(page)
    const findings: (InkFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        const { out, grounds } = await tertiaryInkViolations(page)
        // A check that measures nothing must fail, not pass by default —
        // and a check that silently skips a ground is the same failure
        // wearing a green checkmark, so all five have to show up by name.
        expect(new Set(grounds), `${theme}/${look}: not all five grounds were measured`)
          .toEqual(new Set(['page', 'card', 'plate', 'popover', 'sidebar']))
        for (const finding of out) findings.push({ ...finding, where: `${theme}/${look}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: tertiary ink — the checker catches a tertiary label matching its own ground', async ({ page }) => {
    await mountInkGrounds(page)
    const before = await tertiaryInkViolations(page)
    // `--hd-card` and `--hd-background` render as the same white in light
    // Desk, so matching the text to `--hd-card` used to pass this test
    // whichever ground the walk actually read — proving nothing about the
    // card specifically. Giving the card ground its own, arbitrary fill and
    // matching the text to *that* only passes once the walk reads the
    // card's own background rather than falling through to the page's.
    await page.addStyleTag({ content: `
      [data-ground="card"] [data-slot="card"] { background-color: rgb(10, 40, 90) !important; }
      [data-ground="card"] [data-slot="text"] { color: rgb(12, 42, 92) !important; }
    ` })
    const after = await tertiaryInkViolations(page)
    expect(after.out.length).toBeGreaterThan(before.out.length)
    expect(after.out.some((f) => f.ground === 'card')).toBe(true)
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

/**
 * Focuses the control by keyboard (see the `Shift` trick above) and checks
 * its ring against its own *resting* state, not against the literal string
 * `'none'` — a Studio field already carries a resting `box-shadow`
 * (`--hd-input-shadow`, the "transparent field with a hairline on a white
 * page is a rectangle drawn on paper" token from "Dialog forms" above), so
 * `boxShadow !== 'none'` was true whether or not focus had drawn anything:
 * a vacuous pass on the one interface that most needed the check. The ring
 * has to *add* something the resting state does not have.
 *
 * The wrapper-repeat check is the same idea one level up: an ancestor is
 * read at rest and again while the control is focused, and *any* new
 * outline or box-shadow that appears on it — not only an identical copy of
 * the control's own — is a repeat, because a real regression is as likely
 * to add its own ring's shape as to copy the control's.
 */
const focusAndCheckRing = (page: Page, testId: string, kind: 'outline' | 'shadow') =>
  page.evaluate(([id, ringKind]) => {
    const out: { control: string; reason: string }[] = []
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
    if (!el) { out.push({ control: id, reason: 'control not found' }); return out }
    const ancestors: HTMLElement[] = []
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) ancestors.push(node)
    const read = (node: Element) => ({ outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow })

    el.blur()
    const restingOwn = read(el)
    const restingAncestors = ancestors.map(read)

    el.focus()
    if (el !== document.activeElement || !el.matches(':focus-visible')) {
      out.push({ control: id, reason: 'did not match :focus-visible' })
      return out
    }
    const focusedOwn = read(el)
    const ringAdded = ringKind === 'outline' ? focusedOwn.outline !== restingOwn.outline : focusedOwn.shadow !== restingOwn.shadow
    if (!ringAdded) out.push({ control: id, reason: 'focusing added no ring (resting and focused states match)' })

    ancestors.forEach((ancestor, index) => {
      const now = read(ancestor)
      const before = restingAncestors[index]
      if (now.outline !== before.outline) out.push({ control: id, reason: `an ancestor (${ancestor.className}) started drawing an outline on focus` })
      if (now.shadow !== before.shadow) out.push({ control: id, reason: `an ancestor (${ancestor.className}) started drawing a box-shadow on focus` })
    })
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
    expect(after.some((f) => f.reason.includes('started drawing an outline on focus'))).toBe(true)
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
        expect(await page.locator('[data-slot="text"][data-role]:visible').count(), `${theme}/${look}: no named text role was found`).toBeGreaterThan(0)
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
 * noise that hides the one row that needs someone"). Operationalised as: a
 * leaf element whose *whole* text is one of the app's own words for a
 * resting, nothing-to-report state — "Healthy", "Armed", "On", "Loaded" —
 * must not compute the resolved `--hd-success-ink` colour, and must not sit
 * on an ancestor filled with `--hd-success-dim` or `--hd-success` (a tone
 * can paint a chip's fill or a dot instead of the text itself). The word
 * list is deliberately short and exact-matched (not "contains"): a verdict
 * or a recorded fact — "Open", "Merged", "Passed", a `+120` diff count — is
 * not this rule's target and stays green; `docs/design.md` says which
 * candidates were considered and left out, and why.
 *
 * Three real violators, found by widening past "Healthy" alone, all fixed
 * the same way (the resting half of the pair goes untoned, the non-resting
 * half keeps its own tone):
 *
 * - `lib/provenance.ts`'s `captureWords`: a healthy capture read "Healthy"
 *   in the success tone.
 * - `components/ProjectTriggers.tsx`'s `STATE_WORDS.armed`: an armed
 *   trigger read "Armed" in the success tone, the one state in that table
 *   that was toned at all — `off` is neutral.
 * - `components/SkillSheet.tsx`'s runtime-reach row: a skill a runtime
 *   reaches read "On" in the success tone; "Off" already had none.
 * - `components/SeatAttachments.tsx`: a loaded attachment read "Loaded" in
 *   the success tone; "Not loaded" keeps its warning, which is a verdict.
 *
 * A budget meter (`AgentCard`'s `meter`, `AgentCards.tsx`'s context/plan
 * readings) is explicitly out of scope — an open owner question, #1061 —
 * and not part of this checker's word list.
 */
const HEALTH_RESTING_WORDS = ['Healthy', 'Armed', 'On', 'Loaded']

type HealthFinding = { text: string; tag: string }

const healthToneViolations = (page: Page, root = 'body') =>
  page.evaluate(([helpers, rootSelector, words]) => {
    // eslint-disable-next-line no-new-func
    return new Function('rootSelector', 'words', `${helpers}
      const out = []
      let measured = 0
      const successInk = probeColor('color: var(--hd-success-ink)')
      const successDim = probeColor('background-color: var(--hd-success-dim)')
      const successSolid = probeColor('background-color: var(--hd-success)')
      // The nearest painted background, walking up from the reading itself
      // — a chip's fill (or a status dot's) is its own box, not the leaf
      // text node's, the same reason the tertiary-ink walk above starts
      // from the text and climbs rather than starting from a box and
      // assuming its own background is the one that matters.
      const opaqueBg = (el) => {
        let node = el
        while (node) {
          const bg = getComputedStyle(node).backgroundColor
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
          node = node.parentElement
        }
        return null
      }
      const scope = document.querySelector(rootSelector) ?? document.body
      for (const el of scope.querySelectorAll('*')) {
        if (el.children.length > 0) continue
        const text = (el.textContent || '').trim()
        if (!words.includes(text)) continue
        if (!visible(el)) continue
        measured += 1
        const cs = getComputedStyle(el)
        const bg = opaqueBg(el)
        const toned = cs.color === successInk || bg === successDim || bg === successSolid
        if (toned) out.push({ text: text.slice(0, 40), tag: el.tagName })
      }
      return { out, measured }`)(rootSelector, words)
  }, [PROBE_HELPERS, root, HEALTH_RESTING_WORDS] as const) as Promise<{ out: HealthFinding[]; measured: number }>

test.describe('rule: health takes no tone', () => {
  test('rule: health takes no tone — a resting-state reading is not rendered in the success colour, in every theme and interface', async ({ page }) => {
    await gotoPreview(page)
    // The capture frame loads its health asynchronously; give it a beat.
    // (The armed trigger in `ProjectTriggers`'s own preview fixture is
    // synchronous, but capture's `state: 'healthy'` is the one that has to
    // be waited for.)
    await expect.poll(async () => page.locator('text=Healthy').count()).toBeGreaterThan(0)
    const findings: (HealthFinding & { where: string })[] = []
    for (const theme of ['light', 'dark'] as const) {
      for (const look of ['desk', 'studio'] as const) {
        await setPreviewDials(page, theme, look)
        const { out, measured } = await healthToneViolations(page)
        // A check that measures nothing must fail, not pass by default.
        expect(measured, `${theme}/${look}: no resting-state reading was found`).toBeGreaterThan(0)
        for (const finding of out) findings.push({ ...finding, where: `${theme}/${look}` })
      }
    }
    expect(findings).toEqual([])
  })

  test('rule: health takes no tone — the checker catches a resting-state reading painted in the success ink', async ({ page }) => {
    // A controlled fixture, since the real violations already trip the
    // checker above and would make this test prove nothing about the
    // checker's own sensitivity: a plain, correctly-neutral "Healthy"
    // reading, then mutated to the success colour with page.addStyleTag —
    // the same shape of regression the real Chips had, reproduced on demand
    // so the check stays proven even after every known site is fixed.
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
    // Scoped to the fixture alone: the real page also carries other
    // resting-state readings this rule already reads above, so an unscoped
    // read would prove nothing about this fixture's own mutation.
    const scope = '[aria-label="Health tone fixture"]'
    const before = await healthToneViolations(page, scope)
    expect(before.out).toEqual([])
    await page.addStyleTag({ content: `${scope} [data-slot="chip"] { color: var(--hd-success-ink) !important; }` })
    const after = await healthToneViolations(page, scope)
    expect(after.out.length).toBeGreaterThan(before.out.length)
    expect(after.out.some((f) => f.text.includes('Healthy'))).toBe(true)
  })
})
