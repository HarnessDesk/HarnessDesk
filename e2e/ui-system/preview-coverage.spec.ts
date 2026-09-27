import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

/**
 * Every shipped component renders somewhere the design system can see it.
 *
 * `preview.html` and `design.html` are the two pages that mount real
 * screens over a fixture, and between the preview page's frames and every
 * dial's own options, and every board `design.html` lists, a component that
 * ships in `components/` or `panels/` should turn up in at least one of
 * them — a file that never renders is a file nobody looking at these two
 * pages can see broke, restyled, or removed by accident. This walks both
 * pages, collects every component name React actually mounted (the same
 * fiber walk the measuring script this suite grew from used), and fails by
 * naming the file whose every export came back unseen.
 *
 * Coverage is per *file*, not per export: a file with four exports where
 * only one is ever mounted directly (the other three are its own internal
 * dialogs, reached from the first) still counts as covered, because the
 * import graph proves the other three are reachable from something that did
 * render. `EXEMPT` is the last resort for a file that genuinely cannot be
 * mounted here — a hook or a helper with no component to find, chiefly, and
 * the panel system's own chassis, which composes correctly only inside the
 * full window shell — and every entry says why.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const uiSrc = path.join(repoRoot, 'packages/ui/src')

/**
 * A file this spec cannot cover, and the reason — read once, reported once.
 *
 * Four are structural, not a missing frame: a hook or a plain helper never
 * appears as a fiber's own type, so no amount of mounting finds it by this
 * method — `useImportOffer`, `useOptionConfirm` and `useTabStrip` (with its
 * sibling helper `stripEdges`) are each a file's *only* non-icon export, and
 * `Icons.tsx`'s one export that is not itself an icon, `copyIconMarkup`,
 * returns a markup string rather than JSX. Three more are the panel system's
 * own chassis — `Workbench`, its `PanelActions` strip (real only once a view
 * is actually docked, `chrome === 'own'`) and `views.tsx`'s `ViewHost` —
 * which compose correctly only inside the full window shell `preview.html`
 * deliberately never mounts a second copy of (see this file's own header
 * comment and `main.tsx`'s "real screens... never the app shell").
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'components/Icons.tsx': 'Its one non-icon export, copyIconMarkup, returns a markup string, never JSX — it cannot appear as a fiber type.',
  'components/ImportOffer.tsx': 'Exports only the hook useImportOffer; a hook is never a fiber type.',
  'components/OptionConfirm.tsx': 'Exports only the hook useOptionConfirm; a hook is never a fiber type.',
  'components/TabStrip.tsx': 'Exports only the hook useTabStrip and the plain helper stripEdges; neither is a fiber type.',
  'panels/PanelActions.tsx': 'Reads a real dock/panel mount (usePanelControls) that exists only inside the full Workbench shell, which preview.html deliberately never mounts (individual screens only).',
  'panels/Workbench.tsx': "The window's own chassis — sidebar, docks, resize and drag wiring — not a screen; already exercised by the real app and packages/desktop.",
  'panels/views.tsx': "ViewHost and ShellProvider are the panel registry's own glue, composed only inside the full Workbench shell above.",
}

/** Icon components are a flat façade over lucide (rule 11): drawing every one somewhere is not what this gate is for. */
const isIconName = (name: string): boolean => name.endsWith('Icon') || name.endsWith('Icons')

/**
 * Every top-level `export const Name = …` or `export function Name(` in one
 * file's text — a light parse, not a compiler: it is looking for a name to
 * search the rendered set for, not validating the file. Namespaced or
 * destructured exports (`export const { a, b } = …`) do not match, which is
 * correct here: nothing in `components/` or `panels/` uses that form for a
 * component.
 */
const exportedNames = (source: string): readonly string[] => {
  const names = new Set<string>()
  for (const match of source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
    const name = match[1]!
    if (!isIconName(name)) names.add(name)
  }
  return [...names]
}

/** Every `.tsx` file directly under `dir` whose own exports this gate should look for — tests and style modules are not components. */
const componentFiles = (dir: string): readonly { readonly file: string; readonly names: readonly string[] }[] =>
  readdirSync(dir)
    .filter((entry) => entry.endsWith('.tsx') && !entry.includes('.test.'))
    .map((entry) => ({ file: entry, names: exportedNames(readFileSync(path.join(dir, entry), 'utf8')) }))
    .filter((one) => one.names.length > 0)

/**
 * The fiber walk `rendered2.mjs` uses: every element on the page, its own
 * fiber, and every ancestor's function/class name up to the root. Run
 * in-page so a whole sweep costs one round trip, not one per element.
 */
const collectRendered = (page: Page): Promise<readonly string[]> =>
  page.evaluate(() => {
    const out = new Set<string>()
    for (const el of document.querySelectorAll('*')) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
      if (!key) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fiber: any = (el as unknown as Record<string, unknown>)[key]
      while (fiber) {
        const type = fiber.type
        if (typeof type === 'function' || (type && typeof type === 'object')) {
          const name = type.displayName || type.name || type.render?.name || type.type?.name
          if (name) out.add(name)
        }
        fiber = fiber.return
      }
    }
    return [...out]
  })

/**
 * Every `<select>` on the page, cycled through every one of its own option
 * values and back to the first ("off", for a dialog dial), collecting the
 * fiber names rendered after each — all inside one `page.evaluate`, so the
 * whole sweep costs one round trip rather than hundreds. Hundreds of
 * `locator.evaluate()`/`waitForTimeout()` calls each carry their own
 * protocol round trip; at ~150ms apiece that alone blew this suite's
 * ~60s budget before design.html was even reached.
 *
 * Values are set the way a person's own choice reaches React — set
 * `.value`, dispatch `change` — never `selectOption()`: a dial that opens a
 * full-page dialog moves the whole document (the dialog sits after every
 * frame in the DOM, and opening one scrolls the page to it), and
 * `selectOption`'s own actionability-then-verify loop never resolves
 * against a `<select>` that just became unreachable that way.
 */
const sweepSelects = (page: Page, settleMs: number): Promise<readonly string[]> =>
  page.evaluate(async (delay) => {
    const collect = (): string[] => {
      const out = new Set<string>()
      for (const el of document.querySelectorAll('*')) {
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
        if (!key) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fiber: any = (el as unknown as Record<string, unknown>)[key]
        while (fiber) {
          const type = fiber.type
          if (typeof type === 'function' || (type && typeof type === 'object')) {
            const name = type.displayName || type.name || type.render?.name || type.type?.name
            if (name) out.add(name)
          }
          fiber = fiber.return
        }
      }
      return [...out]
    }
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const setValue = (select: HTMLSelectElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const rendered = new Set<string>()
    for (const name of collect()) rendered.add(name)
    for (const select of [...document.querySelectorAll('select')]) {
      const values = [...select.options].map((option) => option.value)
      const neutral = values[0]
      for (const value of values) {
        setValue(select, value)
        await wait(delay)
        for (const name of collect()) rendered.add(name)
        if (value !== neutral && neutral !== undefined) {
          setValue(select, neutral)
          await wait(20)
        }
      }
    }
    return [...rendered]
  }, settleMs)

test.describe('preview coverage', () => {
  test('every components/ and panels/ file renders in preview.html or design.html', async ({ page }) => {
    test.setTimeout(90_000)
    const rendered = new Set<string>()

    // -- preview.html: the page's own frames, then every dial's every option.
    // `?composer` and `?empty` gate two more frames the plain page never
    // draws — a composer with a picture, a queue, and the pane with no
    // session at all — so both are visited too.
    for (const query of ['', '?composer', '?empty']) {
      await page.goto(`/preview.html${query}`)
      await page.waitForTimeout(1200)
      for (const name of await collectRendered(page)) rendered.add(name)
    }

    for (const name of await sweepSelects(page, 60)) rendered.add(name)

    // -- design.html: every board the nav rail lists.
    await page.goto('/design.html')
    await page.waitForTimeout(800)
    for (const name of await collectRendered(page)) rendered.add(name)
    const boardLabels = [...new Set(await page.locator('aside button, nav button').allTextContents())]
      .map((label) => label.trim())
      .filter(Boolean)
    for (const label of boardLabels) {
      await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {})
      await page.waitForTimeout(150)
      for (const name of await collectRendered(page)) rendered.add(name)
    }

    // -- what should have shown up.
    const files = [
      ...componentFiles(path.join(uiSrc, 'components')).map((one) => ({ ...one, dir: 'components' })),
      ...componentFiles(path.join(uiSrc, 'panels')).map((one) => ({ ...one, dir: 'panels' })),
    ]

    const uncovered = files
      .filter((one) => !one.names.some((name) => rendered.has(name)))
      .map((one) => `${one.dir}/${one.file}`)
      .filter((path) => !(path in EXEMPT))

    expect(uncovered, `Uncovered files (add a frame/dial in packages/ui/src/preview, or an EXEMPT entry): ${uncovered.join(', ')}`).toEqual([])
  })

  /**
   * A dial's own dialog is `position: fixed`, so mounting one unconditionally
   * — the mistake `ShapeEditor` and `AuthorDialog` ("Library — writing a
   * skill") both made — does not merely sit in its own frame the way an
   * inline component would: it stays pinned to the viewport as the page
   * scrolls, so every screenshot of the page shows it sitting over whatever
   * else is on screen. Three screens (Settings, Agents, the Dashboard) are
   * the documented, deliberate exception: each is wrapped in a
   * `transform`-bearing div that becomes that `position: fixed` dialog's own
   * containing block, which is what keeps it inside that one frame instead
   * of following the page (see `main.tsx`'s "Settings — the sheet" comment).
   * So the real invariant a fresh load must hold is not "no dialog at all" —
   * it is "no dialog that would follow the page": every `[role="dialog"]`
   * open before anything is clicked must sit under such a confining
   * ancestor. Every dialog reached from a dial defaults to `off`, so this
   * also stands as the fresh-load half of "the dial's default is off".
   */
  test('a fresh load opens no dialog that is not confined to its own frame', async ({ page }) => {
    await page.goto('/preview.html')
    await page.waitForTimeout(1200)
    const unconfined = await page.evaluate(() => {
      const isConfined = (node: Element | null): boolean => {
        for (let el = node; el && el !== document.body; el = el.parentElement) {
          if (el instanceof HTMLElement && el.style.transform) return true
        }
        return false
      }
      return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .filter((node) => !isConfined(node))
        .map((node) => node.getAttribute('aria-label') ?? node.querySelector('h1,h2,[data-slot="dialog-title"]')?.textContent ?? '(untitled)')
    })
    expect(unconfined, `Dialog(s) open on a fresh load, uncontained, that would cover the page as it scrolls: ${unconfined.join(', ')}`).toEqual([])
  })
})
