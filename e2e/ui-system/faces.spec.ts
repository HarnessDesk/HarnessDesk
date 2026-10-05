import { expect, test, type Page } from '@playwright/test'

/**
 * Every place the app draws someone follows the person's Faces setting.
 *
 * A face is an agent at work or a person, and takes its corner from
 * `--hd-face-radius` (`docs/design.md` § "Shapes say what a mark is"). What
 * kept that true was review, and review kept finding one more face drawn in a
 * fixed corner: the side-by-side tile, a board's assignees, the Agents panel's
 * rows, a notice's face, the Activity panel's rows (#1218, three rounds).
 *
 * Every primitive that draws a face declares it with `data-shape` (`face`, and
 * `round` for an account's ring, `square` for a thing), so this reads the
 * mounted screens instead of guessing from a class. Under each Faces setting
 * it asks three things of what is on screen:
 *
 *   1. Every declared face computes `--hd-face-radius` (or `-lg`), and is
 *      filled solid, except a notice's face, which keeps its tone's wash: it is
 *      translucent by design, so it is held to the wash its tone paints.
 *   2. Every tile that holds an agent's mark is a face, an account's ring, or
 *      a named exception. A tile drawn in a fixed square or round that holds an
 *      agent is the next one a review would have found.
 *   3. Each surface named below is present, as a face. A refactor that drops a
 *      surface's `data-shape` (or the surface) fails here by name instead of
 *      leaving the census one smaller.
 *
 * The Agents panel draws a row only once a session has delegated, so no page
 * can mount it: `packages/ui/src/design/faces.census.test.ts` reads the source
 * of every screen instead and refuses an agent's mark in a tile that is not a
 * face. The two together are the list of every surface that draws someone.
 *
 * A check that finds nothing passes by default, so each mutation below breaks
 * the rule on purpose and must be caught.
 */

const PREVIEW_READY = '[data-region="session-row"] [data-slot="sidebar-menu-button"]'

type Surface = {
  /** What draws it, in the words a review would use. */
  readonly what: string
  /** The preview frame it sits in; absent, the whole page. */
  readonly frame?: string
  readonly selector: string
}

/**
 * How a page takes the Faces setting: the app sets `body[data-hd-faces]`, and
 * the catalogue's own Faces dial sets the two tokens inline (see
 * `design/explorer/Explorer.tsx`). Each page is driven the way its own dial is.
 */
type FacesHow = 'attribute' | 'tokens'

const PAGES: readonly { readonly name: string; readonly url: string; readonly ready: string; readonly how: FacesHow; readonly surfaces: readonly Surface[] }[] = [
  {
    name: 'the preview',
    url: '/preview.html',
    ready: PREVIEW_READY,
    how: 'attribute',
    surfaces: [
      { what: 'the Team rail’s members and the chat’s senders', frame: 'goal-roster', selector: '[data-slot="icon-tile"][data-shape="face"]' },
      { what: 'a notice carrying an agent’s face', frame: 'goal-roster', selector: ':not([data-slot])[data-tone][data-shape="face"]' },
      { what: 'a board card’s holder', frame: 'board-populated', selector: '[data-slot="icon-tile"][data-shape="face"]' },
      { what: 'the Activity panel’s rows', frame: 'panel-activity', selector: '[data-slot="icon-tile"][data-shape="face"]' },
      { what: 'a channel’s senders', frame: 'room-channel-grouping', selector: '[data-slot="icon-tile"][data-shape="face"]' },
      { what: 'a person’s face in a channel', frame: 'room-channel-grouping', selector: 'span[data-shape="face"]:not([data-slot])' },
      { what: 'the seat’s face', frame: 'sidebar-column', selector: 'span[data-shape="face"]' },
      { what: 'the setup survey’s runtime faces', frame: 'setup-survey', selector: '[data-slot="icon-tile"][data-shape="face"]' },
      { what: 'the profile’s face', frame: 'settings-sheet', selector: 'span[data-shape="face"]' },
    ],
  },
  {
    name: 'side by side',
    url: '/preview.html?side-by-side',
    ready: PREVIEW_READY,
    how: 'attribute',
    surfaces: [
      { what: 'a side-by-side tile, two columns', frame: 'side-by-side-two', selector: '[data-slot="icon-tile"][data-shape="face"]' },
      { what: 'a side-by-side tile, four columns', frame: 'side-by-side-four', selector: '[data-slot="icon-tile"][data-shape="face"]' },
    ],
  },
  {
    name: 'the catalogue’s lists',
    url: '/design.html?view=list',
    ready: '[data-slot="avatar-stack"]',
    how: 'tokens',
    surfaces: [{ what: 'an avatar stack’s members', selector: '[data-slot="avatar-stack"] [data-shape="face"]' }],
  },
]

/**
 * Tiles that hold an agent's mark and are deliberately not a face. An account's
 * ring is not one of these: it is `round` and is not an `IconTile`.
 */
type Excused = readonly { readonly frame: string; readonly slot: string; readonly shape: string }[]

const NOT_SOMEONE: Excused = []

const dial = (page: Page, label: string) =>
  page.locator('label').filter({ hasText: new RegExp(`^${label}`) }).locator('select').first()

const open = async (page: Page, url: string, ready: string) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(url)
  await page.waitForSelector(ready)
  await page.evaluate(async () => { await document.fonts.ready })
}

/** Faces are square unless the person chose round: an absent attribute is square. */
const setFaces = (page: Page, how: FacesHow, faces: 'square' | 'round') =>
  page.evaluate(({ how, value }) => {
    if (how === 'attribute') {
      if (value === 'square') document.body.removeAttribute('data-hd-faces')
      else document.body.setAttribute('data-hd-faces', value)
      return
    }
    const round = value === 'round'
    document.body.style.setProperty('--hd-face-radius', round ? 'var(--hd-radius-full)' : 'var(--hd-radius-sm)')
    document.body.style.setProperty('--hd-face-radius-lg', round ? 'var(--hd-radius-full)' : 'var(--hd-radius)')
  }, { how, value: faces })

type FaceFinding = { rule: string; where: string; slot: string; detail: string }

const faceReport = (page: Page, exceptions: Excused) =>
  page.evaluate((excused) => {
    const probe = (token: string, scope: Element = document.body) => {
      const el = scope.appendChild(document.createElement('div'))
      el.style.cssText = `position:absolute;visibility:hidden;width:24px;height:24px;border-radius:var(${token})`
      const value = getComputedStyle(el).borderTopLeftRadius
      el.remove()
      return value
    }
    const corners = [probe('--hd-face-radius'), probe('--hd-face-radius-lg')]
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width >= 1 && r.height >= 1 && (el as HTMLElement).checkVisibility?.() !== false
    }
    const where = (el: Element) => el.closest('[data-frame-id]')?.getAttribute('data-frame-id') ?? '(page)'
    const slot = (el: Element) => el.getAttribute('data-slot') ?? el.tagName.toLowerCase()
    const findings: FaceFinding[] = []
    let faces = 0
    for (const el of document.querySelectorAll('[data-shape="face"]')) {
      if (!visible(el)) continue
      faces += 1
      const cs = getComputedStyle(el)
      // Only the face leads that read this token gain the family corner.
      const familyLead = el.parentElement?.matches('[data-slot="list-row-lead"], [data-slot="table-cell-lead"]')
      const wanted = familyLead ? [...corners, probe('--hd-table-face-radius', el.parentElement!)] : corners
      if (!wanted.includes(cs.borderTopLeftRadius)) {
        findings.push({ rule: 'corner', where: where(el), slot: slot(el), detail: `${cs.borderTopLeftRadius}, wanted ${wanted.join(' or ')}` })
      }
      // A notice's face keeps its tone's wash (it has no data-slot and a tone):
      // translucent by design, so it is not held to solid. It is held to the
      // wash its tone paints, read from the same tile drawn without the face
      // (so the tone-to-token mapping is not copied here): opaque, washed out
      // or gone are all a different ground, and it must be visible at all.
      const notice = !el.hasAttribute('data-slot') && el.hasAttribute('data-tone')
      if (notice) {
        const twin = el.cloneNode(false) as HTMLElement
        twin.removeAttribute('data-shape')
        el.after(twin)
        const wash = getComputedStyle(twin).backgroundColor
        twin.remove()
        const alpha = cs.backgroundColor.match(/^rgba\(.*,\s*([\d.]+)\)$/)?.[1]
        if (cs.backgroundColor !== wash || (alpha !== undefined && Number(alpha) === 0)) {
          findings.push({ rule: 'ground', where: where(el), slot: slot(el), detail: `${cs.backgroundColor}, its tone paints ${wash}` })
        }
      } else if (!/^rgb\(/.test(cs.backgroundColor)) {
        findings.push({ rule: 'solid', where: where(el), slot: slot(el), detail: cs.backgroundColor })
      }
    }
    for (const el of document.querySelectorAll('[data-shape]')) {
      const shape = el.getAttribute('data-shape') ?? ''
      if (!['face', 'round', 'square'].includes(shape) || !visible(el)) continue
      if (!el.querySelector('svg.brand:not(.brand-github), svg.lucide-bot')) continue
      if (shape === 'face') continue
      // An account's ring holds a mark and is round, and is not a tile.
      if (shape === 'round' && slot(el) !== 'icon-tile') continue
      const named = excused.some((one) => one.frame === where(el) && one.slot === slot(el) && one.shape === shape)
      if (!named) findings.push({ rule: 'mark', where: where(el), slot: slot(el), detail: `an agent's mark in a ${shape} tile` })
    }
    return { corners, faces, findings }
  }, exceptions)

const surfaceCount = (page: Page, surface: Surface) =>
  page.evaluate(({ frame, selector }) => {
    const root: ParentNode = frame ? (document.querySelector(`[data-frame-id="${frame}"]`) ?? document.createElement('div')) : document
    return [...root.querySelectorAll(selector)].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width >= 1 && r.height >= 1
    }).length
  }, { frame: surface.frame ?? null, selector: surface.selector })

test.describe('rule: faces', () => {
  for (const spec of PAGES) {
    test(`rule: faces — ${spec.name}: every face follows the Faces setting, and every named surface is a face`, async ({ page }) => {
      await open(page, spec.url, spec.ready)
      const seen: Record<string, string> = {}
      for (const faces of ['square', 'round'] as const) {
        await setFaces(page, spec.how, faces)
        const report = await faceReport(page, NOT_SOMEONE)
        seen[faces] = report.corners[0] ?? ''
        expect(report.faces, `${spec.name}/${faces}: no face was found`).toBeGreaterThan(0)
        expect(report.findings, `${spec.name}/${faces}`).toEqual([])
        for (const surface of spec.surfaces) {
          expect(await surfaceCount(page, surface), `${spec.name}/${faces}: ${surface.what} is not a face (or is not drawn)`).toBeGreaterThan(0)
        }
      }
      // The setting has to move the corner, or the rule above proves nothing.
      expect(seen['round'], `${spec.name}: the Faces setting did not change --hd-face-radius`).not.toBe(seen['square'])
    })
  }

  test('rule: faces — the preview, in dark', async ({ page }) => {
    const spec = PAGES[0]!
    await open(page, spec.url, spec.ready)
    await dial(page, 'theme').selectOption('dark')
    for (const faces of ['square', 'round'] as const) {
      await setFaces(page, spec.how, faces)
      expect((await faceReport(page, NOT_SOMEONE)).findings, `dark/${faces}`).toEqual([])
    }
  })

  test('rule: faces — the checker catches a face drawn in a fixed corner under round faces', async ({ page }) => {
    const spec = PAGES[0]!
    await open(page, spec.url, spec.ready)
    await setFaces(page, spec.how, 'round')
    expect((await faceReport(page, NOT_SOMEONE)).findings).toEqual([])
    await page.addStyleTag({ content: '[data-frame-id="goal-roster"] [data-slot="icon-tile"][data-shape="face"] { border-radius: 2px !important; }' })
    const after = await faceReport(page, NOT_SOMEONE)
    expect(after.findings.some((f) => f.rule === 'corner' && f.where === 'goal-roster')).toBe(true)
  })

  test('rule: faces — the checker catches a face that is not solid', async ({ page }) => {
    const spec = PAGES[0]!
    await open(page, spec.url, spec.ready)
    await page.addStyleTag({ content: '[data-frame-id="goal-roster"] [data-slot="icon-tile"][data-shape="face"] { background-color: rgba(0, 0, 0, 0.1) !important; }' })
    const after = await faceReport(page, NOT_SOMEONE)
    expect(after.findings.some((f) => f.rule === 'solid' && f.where === 'goal-roster')).toBe(true)
  })

  test('rule: faces — the checker catches a notice’s face that lost its ground', async ({ page }) => {
    const spec = PAGES[0]!
    await open(page, spec.url, spec.ready)
    // A notice's face is translucent by design (its tone's wash), so it is not held to solid; it is held to having a ground at all.
    expect((await faceReport(page, NOT_SOMEONE)).findings).toEqual([])
    await page.addStyleTag({ content: '[data-frame-id="goal-roster"] :not([data-slot])[data-tone][data-shape="face"] { background-color: transparent !important; }' })
    const after = await faceReport(page, NOT_SOMEONE)
    expect(after.findings.some((f) => f.rule === 'ground' && f.where === 'goal-roster')).toBe(true)
  })

  test('rule: faces — the checker catches a notice’s face painted solid or washed out', async ({ page }) => {
    const spec = PAGES[0]!
    await open(page, spec.url, spec.ready)
    expect((await faceReport(page, NOT_SOMEONE)).findings).toEqual([])
    // The wash is the tone's own, so any other ground on the face is wrong: too heavy (opaque) or too faint to see.
    for (const ground of ['rgb(52, 88, 240)', 'rgba(52, 88, 240, 0.01)']) {
      const style = await page.addStyleTag({ content: `[data-frame-id="goal-roster"] :not([data-slot])[data-tone][data-shape="face"] { background-color: ${ground} !important; }` })
      const after = await faceReport(page, NOT_SOMEONE)
      expect(after.findings.some((f) => f.rule === 'ground' && f.where === 'goal-roster'), ground).toBe(true)
      await style.evaluate((el) => el.remove())
    }
    expect((await faceReport(page, NOT_SOMEONE)).findings).toEqual([])
  })

  test('rule: faces — the checker catches an agent’s mark in a tile that is not a face, with no setup exception', async ({ page }) => {
    const spec = PAGES[0]!
    await open(page, spec.url, spec.ready)
    const before = await faceReport(page, NOT_SOMEONE)
    expect(before.findings.filter((f) => f.rule === 'mark')).toEqual([])
    // Someone drew an agent in a square: the next one a review would have found.
    await page.evaluate(() => {
      const tile = document.querySelector('[data-frame-id="goal-roster"] [data-slot="icon-tile"][data-shape="face"]')
      tile?.setAttribute('data-shape', 'square')
    })
    const after = await faceReport(page, NOT_SOMEONE)
    expect(after.findings.some((f) => f.rule === 'mark' && f.where === 'goal-roster')).toBe(true)
    // Setup now follows the same rule; putting its old square back is caught.
    await page.evaluate(() => {
      document.querySelector('[data-frame-id="setup-survey"] [data-slot="icon-tile"]')?.setAttribute('data-shape', 'square')
    })
    const bare = await faceReport(page, [])
    expect(bare.findings.some((f) => f.rule === 'mark' && f.where === 'setup-survey')).toBe(true)
  })
})


test('rule: faces — table corners are scoped to the family lead', async ({ page }) => {
  await page.setContent(`<main id="root"><style>
    body { --hd-face-radius:6px; --hd-face-radius-lg:10px; --hd-table-face-radius:8px; }
    [data-shape=face] { display:block;width:32px;height:32px;border-radius:8px;background:rgb(240,240,240); }
  </style><div data-slot="list-row-lead"><span data-shape="face"></span></div></main>`)
  expect((await faceReport(page, [])).findings).toEqual([])
  await page.locator('[data-slot="list-row-lead"]').evaluate(el => el.removeAttribute('data-slot'))
  expect((await faceReport(page, [])).findings.filter(f => f.rule === 'corner')).toHaveLength(1)
})
