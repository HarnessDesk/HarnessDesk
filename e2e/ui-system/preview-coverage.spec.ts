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
 * pages, collects every component *reference* React actually mounted as a
 * fiber's own `type`, and fails by naming the file whose every export came
 * back unmatched.
 *
 * Coverage is per *file*, not per export: a file with four exports where
 * only one is ever mounted directly (the other three are its own internal
 * dialogs, reached from the first) still counts as covered, because the
 * import graph proves the other three are reachable from something that did
 * render. `EXEMPT` is the last resort for a file that genuinely cannot be
 * mounted here — a hook or a helper with no component to find, chiefly, and
 * the panel system's own chassis, which composes correctly only inside the
 * full window shell — and every entry says why.
 *
 * The match is by *reference*, not by name (`packages/ui/src/preview/
 * coverage-registry.ts`, built from `import.meta.glob`). A name collides the
 * moment two files export the same identifier for different reasons —
 * `GitDialogs.tsx`'s own local `ConfirmDialog` beside the design system's
 * `ConfirmDialog`, or `ToolPaneHeader`, `ActivityView`, `AgentRow`,
 * `CodeEditor`, each defined twice — and a name match cannot tell which one a
 * screen actually rendered; a reference can, because `import()`ing a file
 * from inside the same page resolves to the very module instance already in
 * that page's fiber tree.
 */

/**
 * A file this spec cannot cover, and the reason — read once, reported once.
 *
 * Four are structural, not a missing frame: a hook or a plain helper never
 * appears as a fiber's own type, so no amount of mounting finds it by this
 * method — `useImportOffer`, `useOptionConfirm` and `useTabStrip` (with its
 * sibling helper `stripEdges`) are each a file's *only* non-icon export, and
 * `Icons.tsx`'s one export that is not itself an icon, `copyIconMarkup`,
 * returns a markup string rather than JSX. One more is the panel system's
 * own chassis — `Workbench`, the window's sidebar/dock/resize/drag wiring —
 * which composes correctly only inside the full window shell `preview.html`
 * deliberately never mounts a second copy of (see this file's own header
 * comment and `main.tsx`'s "real screens... never the app shell").
 *
 * `panels/PanelActions.tsx` and `panels/views.tsx` are deliberately *not*
 * here: both render once `Panes` mounts a docked view (`frames-panels.tsx`'s
 * "split tree" option), and the check below fails loudly if either turns up
 * actually uncovered — the old exemption for them predated that dial option
 * and the reference-based match that can now tell their real components from
 * a same-named one elsewhere.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'components/Icons.tsx': 'Its one non-icon export, copyIconMarkup, returns a markup string, never JSX — it cannot appear as a fiber type.',
  'components/ImportOffer.tsx': 'Exports only the hook useImportOffer; a hook is never a fiber type.',
  'components/OptionConfirm.tsx': 'Exports only the hook useOptionConfirm; a hook is never a fiber type.',
  'components/TabStrip.tsx': 'Exports only the hook useTabStrip and the plain helper stripEdges; neither is a fiber type.',
  'panels/Workbench.tsx': "The window's own chassis — sidebar, docks, resize and drag wiring — not a screen; already exercised by the real app and packages/desktop.",
}

/** Icon components are a flat façade over lucide (rule 11): drawing every one somewhere is not what this gate is for. */
const isIconName = (name: string): boolean => name.endsWith('Icon') || name.endsWith('Icons')

/**
 * Runs inside the page. Imports `coverage-registry.ts` fresh (this page's own
 * module graph, so every reference it holds is `===` to whatever that same
 * page mounted), builds a reference → file(s) map from every non-icon export,
 * then walks every element's fiber chain — the same walk `rendered2.mjs`
 * uses — matching each ancestor's `type` (and a forwardRef's `.render`, and a
 * memo's `.type`, the two wrapper shapes a plain name/reference check would
 * otherwise miss) against that map. Returns the full file list once (it does
 * not change page to page) and the set of files this page load covered.
 */
const collectCoverage = (page: Page): Promise<{ allFiles: readonly string[]; covered: readonly string[] }> =>
  page.evaluate(async () => {
    const isIconName = (name: string): boolean => name.endsWith('Icon') || name.endsWith('Icons')
    const mod = (await import('/src/preview/coverage-registry.ts')) as {
      coverageRegistry: readonly { file: string; exports: Readonly<Record<string, unknown>> }[]
    }
    const refToFiles = new Map<unknown, string[]>()
    const allFiles: string[] = []
    for (const entry of mod.coverageRegistry) {
      const names = Object.keys(entry.exports).filter((name) => !isIconName(name))
      if (names.length === 0) continue
      allFiles.push(entry.file)
      for (const name of names) {
        const value = entry.exports[name]
        if (value === null || (typeof value !== 'function' && typeof value !== 'object')) continue
        const list = refToFiles.get(value)
        if (list) list.push(entry.file)
        else refToFiles.set(value, [entry.file])
      }
    }

    const covered = new Set<string>()
    const credit = (candidate: unknown): void => {
      const files = refToFiles.get(candidate)
      if (files) for (const file of files) covered.add(file)
    }
    for (const el of document.querySelectorAll('*')) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
      if (!key) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fiber: any = (el as unknown as Record<string, unknown>)[key]
      while (fiber) {
        const type = fiber.type
        credit(type)
        if (type && typeof type === 'object') {
          credit(type.render) // forwardRef
          credit(type.type) // memo
        }
        fiber = fiber.return
      }
    }
    return { allFiles, covered: [...covered] }
  })

/**
 * The same reference-matching pass as `collectCoverage`, but run once after
 * every value of every `<select>` on the page (a dial's own dropdown) —
 * inlined into a single `page.evaluate` so the whole sweep costs one round
 * trip rather than hundreds. Hundreds of `locator.evaluate()`/
 * `waitForTimeout()` calls each carry their own protocol round trip; at
 * ~150ms apiece that alone blew this suite's ~60s budget before design.html
 * was even reached.
 *
 * Values are set the way a person's own choice reaches React — set `.value`,
 * dispatch `change` — never `selectOption()`: a dial that opens a full-page
 * dialog moves the whole document (the dialog sits after every frame in the
 * DOM, and opening one scrolls the page to it), and `selectOption`'s own
 * actionability-then-verify loop never resolves against a `<select>` that
 * just became unreachable that way.
 */
const sweepSelectsForCoverage = (page: Page, settleMs: number): Promise<readonly string[]> =>
  page.evaluate(async (delay) => {
    const isIconName = (name: string): boolean => name.endsWith('Icon') || name.endsWith('Icons')
    const mod = (await import('/src/preview/coverage-registry.ts')) as {
      coverageRegistry: readonly { file: string; exports: Readonly<Record<string, unknown>> }[]
    }
    const refToFiles = new Map<unknown, string[]>()
    for (const entry of mod.coverageRegistry) {
      for (const name of Object.keys(entry.exports)) {
        if (isIconName(name)) continue
        const value = entry.exports[name]
        if (value === null || (typeof value !== 'function' && typeof value !== 'object')) continue
        const list = refToFiles.get(value)
        if (list) list.push(entry.file)
        else refToFiles.set(value, [entry.file])
      }
    }
    const covered = new Set<string>()
    const collect = (): void => {
      for (const el of document.querySelectorAll('*')) {
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
        if (!key) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fiber: any = (el as unknown as Record<string, unknown>)[key]
        while (fiber) {
          const type = fiber.type
          const credit = (candidate: unknown): void => {
            const files = refToFiles.get(candidate)
            if (files) for (const file of files) covered.add(file)
          }
          credit(type)
          if (type && typeof type === 'object') {
            credit(type.render)
            credit(type.type)
          }
          fiber = fiber.return
        }
      }
    }
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const setValue = (select: HTMLSelectElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    collect()
    for (const select of [...document.querySelectorAll('select')]) {
      const values = [...select.options].map((option) => option.value)
      const neutral = values[0]
      for (const value of values) {
        setValue(select, value)
        await wait(delay)
        collect()
        if (value !== neutral && neutral !== undefined) {
          setValue(select, neutral)
          await wait(20)
        }
      }
    }
    return [...covered]
  }, settleMs)

test.describe('preview coverage', () => {
  test('every components/ and panels/ file renders in preview.html or design.html', async ({ page }) => {
    test.setTimeout(90_000)
    const covered = new Set<string>()
    let allFiles: readonly string[] = []

    // -- preview.html: the page's own frames, then every dial's every option.
    // `?composer` and `?empty` gate two more frames the plain page never
    // draws — a composer with a picture, a queue, and the pane with no
    // session at all — so both are visited too.
    for (const query of ['', '?composer', '?empty']) {
      await page.goto(`/preview.html${query}`)
      await page.waitForTimeout(1200)
      const result = await collectCoverage(page)
      allFiles = result.allFiles
      for (const file of result.covered) covered.add(file)
    }

    for (const file of await sweepSelectsForCoverage(page, 60)) covered.add(file)

    // -- design.html: every board the nav rail lists.
    await page.goto('/design.html')
    await page.waitForTimeout(800)
    {
      const result = await collectCoverage(page)
      for (const file of result.covered) covered.add(file)
    }
    const boardLabels = [...new Set(await page.locator('aside button, nav button').allTextContents())]
      .map((label) => label.trim())
      .filter(Boolean)
    for (const label of boardLabels) {
      await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {})
      await page.waitForTimeout(150)
      const result = await collectCoverage(page)
      for (const file of result.covered) covered.add(file)
    }

    const uncovered = allFiles.filter((file) => !covered.has(file) && !(file in EXEMPT))

    expect(uncovered, `Uncovered files (add a frame/dial in packages/ui/src/preview, or an EXEMPT entry): ${uncovered.join(', ')}`).toEqual([])

    // The guard on the guard: an EXEMPT entry that has since become reachable
    // is a stale claim, not a harmless one — it hides the day a fix or a new
    // dial actually covered the file, and the next person to read EXEMPT
    // trusts a reason that no longer holds.
    const staleExemptions = Object.keys(EXEMPT).filter((file) => covered.has(file))
    expect(staleExemptions, `EXEMPT entries that now render (remove them from EXEMPT): ${staleExemptions.join(', ')}`).toEqual([])
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
