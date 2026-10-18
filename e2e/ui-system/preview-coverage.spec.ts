import { cataloguePageCases, PAGE_ITEMS } from './catalogue-sweep'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { teamDetails, selectTeamPage, closeTeamDetails } from './team-frame-actions'
import { selectRunView } from './run-frame-actions'
import { expect, test, type Page } from '@playwright/test'

/**
 * Every shipped component renders somewhere the design system can see it.
 *
 * `preview.html` and `design.html` are the two pages that mount real
 * screens over a fixture, and between the preview page's frames and every
 * dial's own options, and every board `design.html` lists, a component that
 * ships in `components/` or `panels/` should turn up in at least one of
 * them — a component that never renders is a component nobody looking at
 * these two pages can see broke, restyled, or removed by accident. This
 * walks both pages, collects every component *reference* React actually mounted as a
 * fiber's own `type`, and fails by naming every exported visual component
 * that came back unmatched.
 *
 * Coverage is per exported visual component: a sibling component cannot be
 * excused just because its module happens to export another component that
 * rendered. Hooks and helpers have lower-case export names, so they are not
 * visual components and do not enter this inventory. `EXEMPT` is the last
 * resort for a named visual component that genuinely cannot be mounted here,
 * and every entry says why.
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
 * A visual component this spec cannot cover, and the reason — read once,
 * reported once. Keys are `${file}#${exportName}`, so an exemption cannot
 * silently excuse a sibling export from the same file.
 *
 * `Notices` is a coordinator with no DOM of its own; its two visible outlets
 * each have their own export and preview coverage.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'components/Notices.tsx#Notices': 'The toast and inbox coordinator returns no DOM of its own; its visible outlets are covered separately by NoticeStripOutlet and SidebarNotices.',
}

for (const theme of ['light', 'dark'] as const) {
  test(`supported catalogue controls keep their real state and actions in ${theme}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/design.html?view=panel-controls&theme=${theme}`)
    const terminal = page.locator('[data-frame-id="supported-terminal-toggle"]')
    const terminalResources = () => terminal.evaluate(async element => {
      const path = '/src/state/workbench.ts'
      const { dockViews } = await import(/* @vite-ignore */ path)
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'))
      let fiber: any = key && (element as unknown as Record<string, unknown>)[key]
      while (fiber) {
        const store = fiber.memoizedProps?.store
        if (store?.getSnapshot) {
          const { workbench } = store.getSnapshot()
          return [...dockViews(workbench.bottom), ...dockViews(workbench.right)]
            .filter(one => one.view.kind === 'terminal')
            .map(one => ({ mount: one.id, terminal: one.view.terminalId }))
        }
        fiber = fiber.return
      }
      throw new Error('Terminal specimen store missing')
    })
    await terminal.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await expect(terminal).toContainText('1 terminal resources')
    await expect(terminal.getByRole('button', { name: 'Close terminal', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const resources = await terminalResources()
    expect(resources).toHaveLength(1)
    await terminal.getByRole('button', { name: 'Close terminal', exact: true }).click()
    await expect(terminal.getByRole('button', { name: 'Open terminal', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(terminal).toContainText('1 terminal resources')
    expect(await terminalResources()).toEqual(resources)
    await terminal.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await expect(terminal.getByRole('button', { name: 'Close terminal', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(terminal).toContainText('1 terminal resources')
    expect(await terminalResources()).toEqual(resources)
    const panel = page.locator('[data-frame-id="supported-work-actions"]')
    await expect(panel.getByRole('menuitem', { name: 'To the main area', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('menuitem', { name: 'To the sidebar', exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: 'Fill the window', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Back to the layout', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Fill the window', exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: 'Back to the layout', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Fill the window', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Back to the layout', exact: true })).toHaveCount(0)
    await page.goto(`/design.html?view=usage-meter-row&theme=${theme}`)
    const plan = page.locator('[data-frame-id="supported-plan-meters"]')
    const meters = plan.getByRole('button').filter({ has: page.locator('[data-slot="plan-meter"]') })
    await expect(meters).toHaveCount(2)
    const anchor = meters.filter({ has: page.getByRole('progressbar', { name: 'Weekly — what is left', exact: true }) })
    await expect(anchor).toHaveCount(1)
    await anchor.click()
    const menu = page.getByRole('menu')
    await expect(menu).toContainText('Weekly')
    await expect(menu).toContainText('79%')
    await menu.getByRole('menuitem').first().click()
    await expect(plan).toContainText('Recorded plan opened')
    expect(errors).toEqual([])
  })

  test(`the comparison notice catalogue keeps its shelf in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=comparison-notice')
    await expect(page.getByRole('heading', { name: 'Comparison notice', exact: true })).toBeVisible()
    const picked = page.locator('[data-catalog-case="picked"]')
    await expect(picked.getByRole('status')).toContainText('Attempt A picked by Judge')
    await expect(picked.getByRole('button', { name: 'Merge the picked change' })).toBeVisible()
    const waiting = page.locator('[data-catalog-case="waiting"]')
    await expect(waiting.getByRole('button', { name: 'Pick an attempt…' })).toBeVisible()
    await expect(waiting.locator('[data-waiting]')).toBeVisible()
    const longText = page.locator('[data-catalog-case="long-reason"]').getByRole('status')
    await expect(longText).toBeVisible()
    expect(await longText.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const shelf = picked.locator('[data-slot="comparison-notice-slot"]')
    const measured = page.locator('[data-catalog-variant="default"][data-catalog-size="default"]')
    await expect(measured, 'metrics measure one shelf, without the board captions and other states').toHaveAttribute('data-slot', 'comparison-notice-slot')
    const before = await shelf.boundingBox()
    await picked.getByRole('button', { name: 'Dismiss verdict' }).click()
    await expect(picked.getByRole('status')).toHaveCount(0)
    expect((await shelf.boundingBox())?.height).toBe(before?.height)
    await expect(page.locator('[data-catalog-case="empty"] [data-slot="comparison-notice"]')).toHaveCount(0)
  })
}

/**
 * A product surface is code-split under Explorer's Suspense boundary. The nav
 * selection updates before its lazy tree mounts, so the title alone is not a
 * safe signal that coverage can inspect the selected board.
 */
const waitForLazyBoardToSettle = (page: Page, title: string): Promise<unknown> =>
  page.waitForFunction((expectedTitle) => {
    const heading = [...document.querySelectorAll('main h1')]
      .some((node) => node.textContent?.trim() === expectedTitle)
    const mounting = [...document.querySelectorAll('p')]
      .some((node) => node.textContent?.trim() === 'Mounting the screen…')
    return heading && !mounting
  }, title)

/**
 * Runs inside the page. Imports `coverage-registry.ts` fresh (this page's own
 * module graph, so every reference it holds is `===` to whatever that same
 * page mounted), builds a reference → component map from every visual export,
 * then walks every element's fiber chain — the same walk `rendered2.mjs`
 * uses — matching each ancestor's `type` (and a forwardRef's `.render`, and a
 * memo's `.type`, the two wrapper shapes a plain name/reference check would
 * otherwise miss) against that map. Returns the full component list once (it
 * does not change page to page) and the set this page load covered.
 */
const settleCoveragePage = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

const collectCoverage = (page: Page): Promise<{ allComponents: readonly string[]; covered: readonly string[] }> =>
  page.evaluate(async () => {
    const mod = (await import('/src/preview/coverage-registry.ts')) as {
      coverageRegistry: readonly { file: string; exports: Readonly<Record<string, unknown>> }[]
      isVisualComponentExport: (name: string, value: unknown) => boolean
    }
    const refToComponents = new Map<unknown, string[]>()
    const allComponents: string[] = []
    for (const entry of mod.coverageRegistry) {
      for (const [name, value] of Object.entries(entry.exports)) {
        if (!mod.isVisualComponentExport(name, value)) continue
        const component = `${entry.file}#${name}`
        allComponents.push(component)
        const list = refToComponents.get(value)
        if (list) list.push(component)
        else refToComponents.set(value, [component])
      }
    }

    const covered = new Set<string>()
    const isVisible = (element: Element): boolean =>
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && element.getClientRects().length > 0
    // Earn a reference from a visible leaf once per page state. Unrelated
    // DOM and ancestry already credited by a sibling need no geometry probe.
    const seenFibers = new Set<unknown>()
    for (const el of document.querySelectorAll('*')) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
      if (!key) continue
      const chain: any[] = []
      const pending = new Set<string>()
      const consider = (candidate: unknown): void => {
        for (const name of refToComponents.get(candidate) ?? []) if (!covered.has(name)) pending.add(name)
      }
      let fiber: any = (el as unknown as Record<string, unknown>)[key]
      while (fiber && !seenFibers.has(fiber)) {
        chain.push(fiber)
        const type = fiber.type
        consider(type)
        consider(fiber.elementType)
        if (type && typeof type === 'object') { consider(type.render); consider(type.type) }
        fiber = fiber.return
      }
      // Hidden leaves cannot earn new references; leave their ancestry for
      // a visible sibling, including content mounted through a portal.
      if (pending.size > 0 && !isVisible(el)) continue
      for (const member of chain) seenFibers.add(member)
      for (const name of pending) covered.add(name)
    }
    // A destination registers slots; the visible host renders them as a
    // sibling, so no DOM leaf has the registrar in its ancestry. Credit the
    // exact mounted reference only when its active scope has a visible host.
    const registryEntry = (file: string) => mod.coverageRegistry.find(entry => entry.file === file)?.exports
    const registrar = registryEntry('panels/destination-page.tsx')?.DestinationBar
    const pageScope = registryEntry('panels/destination-page.tsx')?.DestinationPageScope
    const outlet = registryEntry('panels/top-bar.tsx')?.TopBarOutlet
    const owners = new Set<string>()
    for (const bar of document.querySelectorAll('[data-slot="top-bar"]')) {
      if (!isVisible(bar)) continue
      const key = Object.keys(bar).find(name => name.startsWith('__reactFiber$'))
      if (!key) continue
      let fiber: any = (bar as unknown as Record<string, unknown>)[key]
      while (fiber) {
        if (fiber.type === outlet && typeof fiber.memoizedProps?.owner === 'string') owners.add(fiber.memoizedProps.owner)
        fiber = fiber.return
      }
    }
    const visited = new Set<unknown>()
    const inspect = (first: any): void => {
      for (let fiber = first; fiber; fiber = fiber.sibling) {
        if (visited.has(fiber)) continue
        visited.add(fiber)
        if (fiber.stateNode instanceof Element) continue
        if (fiber.type === registrar && fiber.child === null) {
          let scope: any = null, host: Element | null = null
          for (let parent = fiber.return; parent; parent = parent.return) {
            if (parent.type === pageScope && scope === null) scope = parent.memoizedProps
            if (parent.stateNode instanceof Element && host === null) host = parent.stateNode
          }
          if (scope?.active && owners.has(scope.owner) && host && isVisible(host)) {
            for (let parent = fiber; parent; parent = parent.return) {
              const names = refToComponents.get(parent.type)
              if (names) for (const name of names) covered.add(name)
              if (parent.type === pageScope) break
            }
          }
        }
        inspect(fiber.child)
      }
    }
    for (const fiber of seenFibers as Set<any>) inspect(fiber.child)
    return { allComponents, covered: [...covered] }
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
const sweepSelectsForCoverage = (
  page: Page,
  { delayedRevealProbe = false }: { delayedRevealProbe?: boolean } = {},
): Promise<{ covered: readonly string[]; delayedReveal: boolean | null; stateElementsVisited: number }> =>
  page.evaluate(async ({ delayedRevealProbe }) => {
    const mod = (await import('/src/preview/coverage-registry.ts')) as {
      coverageRegistry: readonly { file: string; exports: Readonly<Record<string, unknown>> }[]
      isVisualComponentExport: (name: string, value: unknown) => boolean
    }
    const refToComponents = new Map<unknown, string[]>()
    for (const entry of mod.coverageRegistry) {
      for (const [name, value] of Object.entries(entry.exports)) {
        if (!mod.isVisualComponentExport(name, value)) continue
        const component = `${entry.file}#${name}`
        const list = refToComponents.get(value)
        if (list) list.push(component)
        else refToComponents.set(value, [component])
      }
    }
    const covered = new Set<string>()
    const isVisible = (element: Element): boolean =>
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && element.getClientRects().length > 0
    let collections = 0, stateElementsVisited = 0
    const collect = (roots: readonly ParentNode[] = [document]): void => {
      collections++
      // Keep this set local to a collection: each dial value is a distinct
      // page state and can reveal a different mounted subtree.
      const seenFibers = new Set<unknown>()
      const elements = new Set<Element>()
      for (const root of roots) {
        if (root instanceof Element) elements.add(root)
        for (const element of root.querySelectorAll('*')) elements.add(element)
      }
      for (const el of elements) {
        if (collections > 1) stateElementsVisited++
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
        if (!key) continue
        // Visibility is expensive on a page containing every specimen. Only
        // a reference not already earned can add coverage in this dial state.
        const chain: any[] = []
        const pending = new Set<string>()
        let fiber: any = (el as unknown as Record<string, unknown>)[key]
        const consider = (candidate: unknown): void => {
          for (const name of refToComponents.get(candidate) ?? []) if (!covered.has(name)) pending.add(name)
        }
        while (fiber && !seenFibers.has(fiber)) {
          chain.push(fiber)
          const type = fiber.type
          consider(type)
          consider(fiber.elementType)
          if (type && typeof type === 'object') { consider(type.render); consider(type.type) }
          fiber = fiber.return
        }
        // Hidden leaves never earn new ancestors: a visible sibling may do so.
        if (pending.size > 0 && !isVisible(el)) continue
        for (const member of chain) seenFibers.add(member)
        for (const name of pending) covered.add(name)
      }

      // A destination registers slots; the visible host renders them as a
      // sibling, so no DOM leaf has the registrar in its ancestry. Credit the
      // exact mounted reference only when its active scope has a visible host.
      const registryEntry = (file: string) => mod.coverageRegistry.find(entry => entry.file === file)?.exports
      const registrar = registryEntry('panels/destination-page.tsx')?.DestinationBar
      const pageScope = registryEntry('panels/destination-page.tsx')?.DestinationPageScope
      const outlet = registryEntry('panels/top-bar.tsx')?.TopBarOutlet
      const owners = new Set<string>()
      for (const bar of document.querySelectorAll('[data-slot="top-bar"]')) {
        if (!isVisible(bar)) continue
        const key = Object.keys(bar).find(name => name.startsWith('__reactFiber$'))
        if (!key) continue
        let fiber: any = (bar as unknown as Record<string, unknown>)[key]
        while (fiber) {
          if (fiber.type === outlet && typeof fiber.memoizedProps?.owner === 'string') owners.add(fiber.memoizedProps.owner)
          fiber = fiber.return
        }
      }
      const visited = new Set<unknown>()
      const inspect = (first: any): void => {
        for (let fiber = first; fiber; fiber = fiber.sibling) {
          if (visited.has(fiber)) continue
          visited.add(fiber)
          if (fiber.stateNode instanceof Element) continue
          if (fiber.type === registrar && fiber.child === null) {
            let scope: any = null, host: Element | null = null
            for (let parent = fiber.return; parent; parent = parent.return) {
              if (parent.type === pageScope && scope === null) scope = parent.memoizedProps
              if (parent.stateNode instanceof Element && host === null) host = parent.stateNode
            }
            if (scope?.active && owners.has(scope.owner) && host && isVisible(host)) {
              for (let parent = fiber; parent; parent = parent.return) {
                const names = refToComponents.get(parent.type)
                if (names) for (const name of names) covered.add(name)
                if (parent.type === pageScope) break
              }
            }
          }
          inspect(fiber.child)
        }
      }
      for (const fiber of seenFibers as Set<any>) inspect(fiber.child)
    }
    // React receives the `change` synchronously, then may place an effect's
    // state-gated subtree in the next render. Two animation frames make that
    // rendered state observable without a timing guess per option.
    const settle = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const setValue = (select: HTMLSelectElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const probe = delayedRevealProbe ? (() => {
      const select = document.createElement('select')
      select.add(new Option('off', 'off'), undefined)
      select.add(new Option('on', 'on'), undefined)
      const reveal = document.createElement('span')
      reveal.hidden = true
      select.addEventListener('change', () => {
        if (select.value === 'on') {
          // A chosen state commits first; its effect reveals dependent content
          // on the next frame, as a React effect can do.
          queueMicrotask(() => requestAnimationFrame(() => requestAnimationFrame(() => { reveal.hidden = false })))
        }
      })
      document.body.append(select, reveal)
      return { select, reveal }
    })() : null
    collect()
    // Only the dial's specimen and DOM changed by its effect can earn new
    // references after the initial inventory. Portals are included by observing
    // additions and attribute changes anywhere in the document.
    const changed = new Set<Element>()
    const observe = (records: MutationRecord[]): void => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element) changed.add(record.target)
        if (record.type === 'characterData' && record.target.parentElement) changed.add(record.target.parentElement)
        for (const node of record.addedNodes) if (node instanceof Element) changed.add(node)
      }
    }
    const observer = new MutationObserver(observe)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    const selects = probe ? [probe.select] : [...document.querySelectorAll('select')]
    for (const select of selects) {
      const values = [...select.options].map((option) => option.value)
      const neutral = values[0]
      for (const value of values) {
        changed.clear()
        setValue(select, value)
        await settle()
        observe(observer.takeRecords())
        const specimen = select.closest('[data-frame-id]') ?? (select.parentElement === document.body ? select : select.parentElement ?? select)
        collect([specimen, ...changed].filter(element => element.isConnected))
      }
      if (select.value !== neutral && neutral !== undefined) {
        setValue(select, neutral)
        await settle()
      }
    }
    observer.disconnect()
    const delayedReveal = probe ? !probe.reveal.hidden : null
    probe?.select.remove()
    probe?.reveal.remove()
    return { covered: [...covered], delayedReveal, stateElementsVisited }
  }, { delayedRevealProbe })

test('a dial sweep visits only changed specimens after its initial inventory', async ({ page }) => {
  await page.goto('/preview.html')
  await settleCoveragePage(page)
  // Measure the synthetic dial independently of live preview timers and effects.
  await page.evaluate(() => {
    const unrelated = document.createElement('div')
    for (let index = 0; index < 1000; index++) {
      const leaf = document.createElement('span')
      leaf.textContent = 'Synthetic'
      unrelated.append(leaf)
    }
    document.body.replaceChildren(unrelated)
  })
  const result = await sweepSelectsForCoverage(page, { delayedRevealProbe: true })
  expect(result.delayedReveal).toBe(true)
  expect(result.stateElementsVisited).toBeLessThanOrEqual(10)
})

test('coverage does not spend visibility probes on unrelated DOM leaves', async ({ page }) => {
  await page.goto('/preview.html?frame-wall=conversation')
  await expect(page.locator('[data-slot="composer"]:visible')).toBeVisible()
  const before = await collectCoverage(page)
  await page.evaluate(() => {
    const island = document.createElement('div'); island.id = 'coverage-unrelated-dom'
    for (let i = 0; i < 1000; i++) { const leaf = document.createElement('span'); leaf.textContent = 'Synthetic'; island.append(leaf) }
    document.body.append(island)
    const original = Element.prototype.checkVisibility
    const probe = { original, calls: 0 }
      ; (window as Window & { __coverageCostProbe?: typeof probe }).__coverageCostProbe = probe
    Element.prototype.checkVisibility = function(options) {
      if (this === island || island.contains(this)) probe.calls++
      return original.call(this, options)
    }
  })
  try {
    const after = await collectCoverage(page)
    expect([...after.covered].sort()).toEqual([...before.covered].sort())
    expect(await page.evaluate(() => (window as Window & { __coverageCostProbe: { calls: number } }).__coverageCostProbe.calls)).toBe(0)
  } finally {
    await page.evaluate(() => {
      const probe = (window as Window & { __coverageCostProbe: { original: typeof Element.prototype.checkVisibility } }).__coverageCostProbe
      Element.prototype.checkVisibility = probe.original
      document.getElementById('coverage-unrelated-dom')?.remove()
    })
  }
})

test('a published destination bar credits only its active visible registration', async ({ page }) => {
  await page.goto('/preview.html?frame-wall=library')
  await expect(page.locator('[data-page-destination="library"]:visible h1')).toHaveText('Library')
  await expect(page.locator('[data-slot="top-bar"]:visible [data-topbar-title]')).toHaveCount(0)
  const before = await collectCoverage(page)
  expect(before.covered).toContain('panels/destination-page.tsx#DestinationBar')
  expect(before.covered).toContain('panels/library-bar.tsx#LibraryBar')
  await page.locator('[data-page-destination="library"]').evaluate(node => { (node as HTMLElement).style.opacity = '0' })
  const hidden = await collectCoverage(page)
  expect(hidden.covered).not.toContain('panels/destination-page.tsx#DestinationBar')
  expect(hidden.covered).not.toContain('panels/library-bar.tsx#LibraryBar')
})

test.describe('preview coverage', () => {
  test('Seat browsers preview live pages and Seats with nothing open', async ({ page }) => {
    await page.goto('/preview.html?tile-browsers')
    const live = page.locator('[data-frame-id="side-by-side-browsers"]')
    await expect(live.frameLocator('iframe').first().getByRole('heading', { name: 'The daily planner' })).toBeVisible()
    await expect(live.frameLocator('iframe').nth(1).getByRole('heading', { name: 'The reading shelf' })).toBeVisible()
    const mixed = page.locator('[data-frame-id="side-by-side-browsers-empty"]')
    await expect(mixed.locator('iframe')).toHaveCount(2)
    await expect(mixed.getByText('Nothing open yet', { exact: true })).toHaveCount(2)
    await expect(mixed.getByText('Pages the runtime opens appear here.', { exact: true })).toHaveCount(2)
    expect((await collectCoverage(page)).covered).toContain('components/SeatBrowser.tsx#SeatBrowser')
  })

  test('the in-page inventory keeps an acronym-led React component', async ({ page }) => {
    await page.goto('/preview.html')
    const included = await page.evaluate(async () => {
      const { isVisualComponentExport } = await import('/src/preview/coverage-registry.ts')
      return isVisualComponentExport('URLPane', () => null)
    })
    expect(included).toBe(true)
  })

  test('the in-page inventory leaves an animated icon drawing out, as it does an icon', async ({ page }) => {
    await page.goto('/preview.html')
    const included = await page.evaluate(async () => {
      const { isVisualComponentExport } = await import('/src/preview/coverage-registry.ts')
      return [isVisualComponentExport('BellGlyph', () => null), isVisualComponentExport('BellIcon', () => null)]
    })
    expect(included).toEqual([false, false])
  })

  test('the coverage sweep settles a dial whose visible content follows an effect', async ({ page }) => {
    await page.goto('/preview.html')
    const result = await sweepSelectsForCoverage(page, { delayedRevealProbe: true })
    expect(result.delayedReveal).toBe(true)
  })

  {

    for (const [item0, [property, value]] of ([['display', 'none'], ['opacity', '0']] as const).entries()) test(`a hidden or transparent preview wrapper earns no component coverage [item ${[item0].join('-')}]`, async ({ page }) => {

      await page.goto('/preview.html')
      await page.locator('html').evaluate((node, style) => { ; (node as HTMLElement).style[style.property] = style.value }, { property, value })
      expect(await collectCoverage(page), `${property}: ${value}`).toMatchObject({ covered: [] })
      expect((await sweepSelectsForCoverage(page, { delayedRevealProbe: true })).covered, `${property}: ${value} dial sweep`).toEqual([])


    })
  }

  cataloguePageCases('every exported components/ and panels/ component renders in preview.html or design.html', getPage => {
    const covered = new Set<string>()
    let allComponents: readonly string[] = []
    test.afterAll(async () => {
      const uncovered = allComponents.filter((component) => !covered.has(component) && !(component in EXEMPT))
      expect(uncovered, `Uncovered components (add a frame/dial in packages/ui/src/preview, or an EXEMPT entry): ${uncovered.join(', ')}`).toEqual([])
      const staleExemptions = Object.keys(EXEMPT).filter((component) => covered.has(component))
      expect(staleExemptions, `EXEMPT entries that now render (remove them from EXEMPT): ${staleExemptions.join(', ')}`).toEqual([])
    })
    test(`coverage page 0`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/design.html?view=team-start')
      await page.getByRole('button', { name: 'Picker', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
      const teamStartCoverage = await collectCoverage(page)
      expect(teamStartCoverage.covered).toContain('components/FrontDoor.tsx#FrontDoor')
      for (const component of teamStartCoverage.covered) covered.add(component)
    })

    for (const [item, query] of (['', '?composer', '?empty', '?board-tool-approvals', '?notice-placement', '?compact-panels', '?board-list', '?team-frame=controls', '?tile-browsers', '?flows-page=catalogue', '?flows-page=editor', '?frame-wall=library&frame-detail=skill&frame-name=code-review', '?frame-wall=agents&frame-account-name=dialog']).entries()) test(`coverage page 1: query ${item}`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto(`/preview.html${query}`)
      if (query === '?board-list') {
        const board = page.locator('[data-frame-id="board-list-page"]')
        await board.getByRole('button', { name: 'View', exact: true }).click()
        await page.getByRole('menuitem', { name: 'List', exact: true }).click()
        await expect(board.locator('[data-slot="board-list"]')).toBeVisible()
      }
      if (query === '?team-frame=controls') await expect(page.getByRole('menuitem', { name: 'Fill the window', exact: true })).toBeVisible()
      if (query === '?flows-page=catalogue') await expect(page.getByRole('button', { name: 'New Flow', exact: true })).toBeVisible()
      if (query === '?flows-page=editor') await expect(page.getByRole('main', { name: 'Flow editor', exact: true })).toBeVisible()
      if (query.includes('frame-detail=skill')) await expect(page.locator('[data-slot="skill-page"]')).toBeVisible()
      await settleCoveragePage(page)
      const result = await collectCoverage(page)
      allComponents = result.allComponents
      for (const file of result.covered) covered.add(file)
    })

    for (const [query, title, component] of [
      ['library-github', 'Add from GitHub', 'LibraryGithub'],
      ['library-github=plan', 'Install code-review', 'LibraryFiles'],
    ] as const) test(`coverage Library dialog: ${title}`, async () => {
      const page = getPage()
      await page.goto(`/preview.html?${query}`)
      // Dialog-only previews mount in a portal, leaving #root empty.
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await expect(dialog).toBeVisible()
      if (component === 'LibraryFiles') await expect(dialog.getByText('3 files · 1 can run', { exact: true })).toBeVisible()
      const result = await collectCoverage(page)
      expect(result.covered).toContain(`components/${component}.tsx#${component}`)
      for (const file of result.covered) covered.add(file)
    })

    test(`coverage page 2`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html')
      await page.locator('[data-frame-id="coverage-answer-actions"]').getByRole('button', { name: 'Mark this response as good', exact: true }).click()
      await expect(page.locator('[data-frame-id="coverage-answer-actions"] [data-message-actions][data-sticky]')).toBeVisible()
      for (const component of (await collectCoverage(page)).covered) covered.add(component)
    })

    test(`coverage page 3`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await installFramePreviewFixture(page)
    })

    test(`coverage page 4`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?frame-wall=conversation&frame-update=1')
      await expect(page.getByRole('button', { name: 'Relaunch to update', exact: true })).toBeVisible()
      for (const component of (await collectCoverage(page)).covered) covered.add(component)
    })

    for (const [item, scene] of (['comparison', 'investigation']).entries()) test(`coverage page 5: scene ${item}`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto(`/preview.html?run-shapes=${scene}`)
      await page.locator('#run-shapes-frame [data-step-row][data-row="card-1-1"] button').click()
      if (scene === 'comparison') await expect(page.locator('[data-slot="run-inspector"] [data-slot="timeline-card"]')).toHaveCount(2)
      else await expect(page.locator('[data-slot="timeline-document-body"]')).toContainText('Investigation answer')
      for (const component of (await collectCoverage(page)).covered) covered.add(component)
    })

    test(`coverage page 6`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?side-by-side')
      await expect(page.locator('[data-frame-id="side-by-side-two"] [data-shared-composer]')).toBeVisible()
      const sharedComposerCoverage = await collectCoverage(page)
      expect(sharedComposerCoverage.covered).toContain('components/RoomComposerOptions.tsx#RoomComposerOptions')
      for (const component of sharedComposerCoverage.covered) covered.add(component)
    })

    test(`coverage page 7`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?comparison-verdict')
      await expect(page.locator('[data-frame-id="comparison-picked"] [data-slot="comparison-decision"]')).toContainText('The judge picked A')
      const verdictCoverage = await collectCoverage(page)
      expect(verdictCoverage.covered).toContain('components/ComparisonVerdict.tsx#ComparisonVerdict')
      expect(verdictCoverage.covered).toContain('components/ComparisonActions.tsx#ComparisonActions')
      for (const component of verdictCoverage.covered) covered.add(component)
      await page.locator('[data-frame-id="comparison-person"]').getByRole('button', { name: 'Pick an attempt…' }).click()
      const pick = page.getByRole('dialog', { name: 'Pick the better attempt' })
      await expect(pick.getByRole('radiogroup', { name: 'Attempts' })).toBeVisible()
      await expect(pick).toContainText('attempt-1')
      const personCoverage = await collectCoverage(page)
      expect(personCoverage.covered).toContain('components/PersonStepDialog.tsx#PersonStepDialog')
      for (const component of personCoverage.covered) covered.add(component)
    })

    test(`coverage page 8`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?team-frame=trigger-runs')
      const triggerFrame = page.locator('[data-frame-id="team-frame"]')
      const triggerTeam = triggerFrame.locator('[data-slot="team-room"]')
      await selectTeamPage(triggerFrame, 'runs')
      await expect(triggerTeam.locator('[data-slot="team-runs"]')).toBeVisible()
      const triggerCoverage = await collectCoverage(page)
      expect(triggerCoverage.covered).toContain('components/TeamRuns.tsx#TeamRuns')
      for (const component of triggerCoverage.covered) covered.add(component)
    })

    test(`coverage page 9`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?frame-wall=conversation&frame-details-case=active')
      const rail = page.locator('[data-slot="top-bar"]:visible [data-work-rail-toggle]')
      if (await rail.getAttribute('aria-pressed') !== 'true') await rail.click()
      await expect(page.locator('[data-slot="tool-body"]:visible [aria-label="Conversation facts"]')).toBeVisible()
      const conversationDetailsCoverage = await collectCoverage(page)
      expect(conversationDetailsCoverage.covered).toContain('panels/work-details.tsx#ConversationDetails')
      expect(conversationDetailsCoverage.covered).toContain('components/Conversation.tsx#GitControl')
      for (const component of conversationDetailsCoverage.covered) covered.add(component)
    })

    test(`coverage page 10`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?frame-wall=conversation&frame-tool=changes')
      await expect(page.locator('[data-slot="tool-body"]:visible').getByText('Changes', { exact: true })).toBeVisible()
      const workChangesCoverage = await collectCoverage(page)
      expect(workChangesCoverage.covered).toContain('components/WorkToolContents.tsx#WorkChangesView')
      for (const component of workChangesCoverage.covered) covered.add(component)
      await page.goto('/preview.html?frame-wall=conversation&frame-explorer=git')
      await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Files', exact: true }).click()
      const files = page.locator('[data-frame-region="right"]')
      await expect(files.locator('[data-explorer-head]')).toContainText('Changed 4')
      await expect(files.getByRole('button', { name: 'app', exact: true })).toBeVisible()
      await expect(files.getByRole('button', { name: 'Go to file', exact: true })).toBeVisible()
      const filesCoverage = await collectCoverage(page)
      expect(filesCoverage.covered).toContain('panels/FilesPane.tsx#FilesPane')
      expect(filesCoverage.covered).toContain('editor/index.ts#Explorer')
      for (const component of filesCoverage.covered) covered.add(component)
      await page.goto('/preview.html?frame-wall=conversation&frame-editor-mode=source')
      await expect(page.locator('[data-slot="editor-main"] .cm-content')).toBeVisible()
      const editorCoverage = await collectCoverage(page)
      expect(editorCoverage.covered).toContain('editor/index.ts#FileTabs')
      expect(editorCoverage.covered).toContain('editor/index.ts#EditorMain')
      for (const component of editorCoverage.covered) covered.add(component)
      const editor = page.locator('[data-slot="editor-main"]')
      await editor.getByRole('radio', { name: /^Changes \+/ }).click()
      await expect(editor.locator('.cm-deletedChunk')).toBeVisible()
      const changesCoverage = await collectCoverage(page)
      expect(changesCoverage.covered).toContain('editor/index.ts#MergeView')
      for (const component of changesCoverage.covered) covered.add(component)
      await editor.getByRole('tab', { name: 'README.md', exact: true }).click()
      await expect(editor.getByRole('heading', { name: 'Storefront', exact: true })).toBeVisible()
      const markdownCoverage = await collectCoverage(page)
      expect(markdownCoverage.covered).toContain('editor/index.ts#MarkdownView')
      for (const component of markdownCoverage.covered) covered.add(component)
    })

    test(`coverage page 11`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?frame-wall=team')
      const heldTeam = page.locator('[data-frame-id="frame-wall"]')
      await selectTeamPage(heldTeam, 'room')
      const heldComposer = heldTeam.locator('[data-slot="room-body"] [data-slot="composer"]:visible').first()
      const heldDraft = heldComposer.locator('textarea').first()
      await heldDraft.fill('Keep this coverage draft while messages are held.')
      await heldComposer.getByRole('button', { name: 'Send to', exact: true }).click()
      await page.getByRole('switch', { name: 'Board-only', exact: true }).click()
      await expect(heldComposer.getByText('Board-only', { exact: true })).toBeVisible()
      await expect(heldDraft).toHaveValue('Keep this coverage draft while messages are held.')
      await expect(heldDraft).toBeEnabled()
      const holdingCoverage = await collectCoverage(page)
      expect(holdingCoverage.covered).toContain('components/RoomMessaging.tsx#HoldingMessagesChip')
      for (const component of holdingCoverage.covered) covered.add(component)
    })

    test(`coverage page 12`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?run-dock')
      const runFrame = page.locator('#run-dock-frame')
      await selectTeamPage(runFrame, 'run')
      await runFrame.locator('[data-row][data-kind="card"]').first().click()
      await expect(runFrame.locator('[data-slot="tool-body"]:visible [data-slot="run-inspector"]')).toBeVisible()
      for (const component of (await collectCoverage(page)).covered) covered.add(component)
      await closeTeamDetails(runFrame)
      await selectRunView(runFrame, 'Timeline')
      await expect(runFrame.locator('[data-slot="workbench-main"] [data-slot="run-steps"]')).toBeVisible()
      for (const component of (await collectCoverage(page)).covered) covered.add(component)
    })

    test(`coverage page 13`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?storage=page')
      await expect(page.getByRole('button', { name: 'Review…', exact: true })).toBeVisible()
      const storageCoverage = await collectCoverage(page)
      expect(storageCoverage.covered).toContain('components/Storage.tsx#StorageSection')
      for (const component of storageCoverage.covered) covered.add(component)
      await page.getByRole('button', { name: 'Discard worktree…', exact: true }).first().click()
      await expect(page.getByRole('alertdialog', { name: 'Discard worktree?' })).toBeVisible()
      const discardCoverage = await collectCoverage(page)
      expect(discardCoverage.covered).toContain('components/DiscardWorktree.tsx#DiscardWorktree')
      for (const component of discardCoverage.covered) covered.add(component)
    })

    test(`coverage page 14`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?history')
      await expect(page.locator('[data-frame-id="history-rows"]').getByRole('button', { name: 'Trace the slow startup', exact: true })).toBeVisible()
      await expect(page.locator('[data-frame-id="history-agent-done"]').getByRole('button', { name: 'Browse', exact: true })).toBeVisible()
      const historyCoverage = await collectCoverage(page)
      expect(historyCoverage.covered).toContain('components/History.tsx#HistorySection')
      expect(historyCoverage.covered).toContain('components/History.tsx#AgentHistory')
      for (const component of historyCoverage.covered) covered.add(component)
      expect(allComponents).toEqual(expect.arrayContaining([
        'components/Settings.tsx#Settings',
        'components/usage/ActivityView.tsx#ActivityView',
        'panels/Workbench.tsx#Workbench',
      ]))
    })

    test(`coverage page 15`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/preview.html?board-list')
      const boardFrame = page.locator('[data-frame-id="board-list-page"]')
      await boardFrame.getByRole('button', { name: 'View', exact: true }).click()
      await page.getByRole('menuitem', { name: 'List', exact: true }).click()
      await expect(boardFrame.getByRole('table', { name: 'Jobs', exact: true })).toBeVisible()
      for (const component of (await collectCoverage(page)).covered) covered.add(component)
    })

    for (const [item, query] of (['', '?composer']).entries()) test(`coverage page 16: query ${item}`, async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto(`/preview.html${query}`)
      await settleCoveragePage(page)
      for (const component of (await sweepSelectsForCoverage(page)).covered) covered.add(component)
    })

    test("coverage page: design inventory", async () => {
      const page = getPage(); test.setTimeout(360_000);
      await page.goto('/design.html')
      await settleCoveragePage(page)
      {
        const result = await collectCoverage(page)
        for (const file of result.covered) covered.add(file)
      }
      const boardNav = page.getByRole('navigation').filter({ has: page.getByText('Design system', { exact: true }) })
      const boardControls = boardNav.locator(':scope > button')
      const boardLabels = [...new Set(await boardControls.allTextContents())]
        .map((label) => label.trim())
        .filter(Boolean)
      expect(boardLabels).toEqual(PAGE_ITEMS.boards)
    })

    for (const label of PAGE_ITEMS.boards) test(`coverage board: ${label}`, async () => {
      const page = getPage();
      if (new URL(page.url()).pathname !== '/design.html') { await page.goto('/design.html'); await settleCoveragePage(page) }
      const boardNav = page.getByRole('navigation').filter({ has: page.getByText('Design system', { exact: true }) });
      const board = boardNav.getByRole('button', { name: label, exact: true })
      await expect(board).toHaveCount(1)
      await board.click()
      const selected = boardNav.locator(':scope > button[data-selected="true"]')
      await expect(selected).toHaveCount(1)
      await expect(selected).toHaveText(label)
      const isProductSurface = await board.evaluate((button) => {
        let heading = button.previousElementSibling
        while (heading?.tagName === 'BUTTON') heading = heading.previousElementSibling
        return heading?.textContent?.trim() === 'Product Surfaces'
      })
      if (isProductSurface) await waitForLazyBoardToSettle(page, label)
      if (label === 'Library') {
        await expect(page.locator('[data-slot="skill-card"]').first()).toBeVisible()
        await expect(page.locator('[data-slot="skill-list"] [data-slot="skill-row"]').first()).toBeVisible()
      }
      const result = await collectCoverage(page)
      for (const file of result.covered) covered.add(file)
      if (label === 'Library') expect(result.covered).toEqual(expect.arrayContaining(['components/SkillRow.tsx#SkillList', 'components/SkillRow.tsx#SkillRow']))
      if (label === 'Panels') expect(result.covered).toContain('panels/Workbench.tsx#Workbench')
    })
  })

  test('preview shows the three board-tool permission card states and keeps grants quiet', async ({ page }) => {
    await page.goto('/preview.html?board-tool-approvals')
    const session = page.locator('[data-frame-id="board-tool-approval-always"] [data-slot="approval-card"]')
    const permanent = page.locator('[data-frame-id="board-tool-approval-permanent"] [data-slot="approval-card"]')
    const none = page.locator('[data-frame-id="board-tool-approval-setting"] [data-slot="approval-card"]')
    const guidance = "To always allow, turn on permanent tool approval in Gemini CLI's settings."

    await expect(session).toContainText("Gemini CLI wants to use HarnessDesk's board to list the board's work items.")
    await expect(session).toContainText("HarnessDesk can't confirm which server is asking.")
    await expect(session).not.toContainText('list_intents')
    // Gemini's own order decides the numbers; the card draws the refusal first and the plain yes last.
    await expect(session.locator('button')).toHaveText(['Reject4', 'Allow all server tools for this session1', 'Allow for this session2', 'Allow once3'])
    await expect(session.getByRole('button', { name: 'Allow all server tools for this session' })).toHaveAttribute('data-variant', 'quiet')
    await expect(session.getByRole('button', { name: 'Allow for this session' })).toHaveAttribute('data-variant', 'quiet')
    await expect(session.getByRole('button', { name: 'Allow once' })).toHaveAttribute('data-variant', 'default')
    await expect(session.getByRole('button', { name: 'Allow for this session' })).toHaveAttribute('title', 'Allows this tool for the rest of this session.')
    // Every grant on offer ends with the session, so the card says how to turn on a lasting one.
    await expect(session).toContainText(guidance)

    await expect(permanent.locator('button')).toHaveText(['Reject5', 'Allow all server tools for this session1', 'Allow for this session2', 'Allow tool for all future sessions3', 'Allow once4'])
    await expect(permanent.getByRole('button', { name: 'Allow tool for all future sessions' })).toHaveAttribute('data-variant', 'quiet')
    await expect(permanent.getByRole('button', { name: 'Allow once' })).toHaveAttribute('data-variant', 'default')
    await expect(permanent).not.toContainText('To always allow')

    await expect(none).toContainText(guidance)
    await expect(none).not.toContainText('security.enablePermanentToolApproval')
    await expect(none.locator('[data-slot="approval-reason"]')).toHaveAttribute('title', 'security.enablePermanentToolApproval')
    await expect(none.getByRole('button', { name: 'Allow for this session' })).toHaveCount(0)
    await expect(none.locator('button')).toHaveText(['Reject2', 'Allow once1'])

    await page.goto('/design.html')
    await page.getByRole('button', { name: 'Dialog · ConfirmDialog', exact: true }).click()
    await page.getByRole('button', { name: 'Approval · board tool', exact: true }).click()
    await expect(page.locator('[data-catalog-case="board-tool-approval-always"]')).toContainText('Allow for this session')
    await expect(page.locator('[data-catalog-case="board-tool-approval-permanent"]')).toContainText('Allow tool for all future sessions')
    await expect(page.locator('[data-catalog-case="board-tool-approval-setting"]')).toContainText(guidance)
  })

  /**
   * A dial's own dialog is `position: fixed`, so mounting one unconditionally
   * — the mistake `ShapeEditor` and `AuthorDialog` ("Library — writing a
   * skill") both made — does not merely sit in its own frame the way an
   * inline component would: it stays pinned to the viewport as the page
   * scrolls, so every screenshot of the page shows it sitting over whatever
   * else is on screen. Settings, Agents and Dashboard are retained main
   * destinations in their own bounded App specimens. Dialog dials default
   * to off; an open first-run boundary must remain confined to its frame.
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


for (const theme of ['light', 'dark'] as const) {
  test(`History uses the landed hide and delete controls in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?history=rows')
    const frame = page.locator('[data-frame-id="history-rows"]')
    await frame.getByRole('button', { name: 'Trace the slow startup actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Hide from HarnessDesk', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Delete everywhere…', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete "Trace the slow startup" everywhere?' })
    await expect(dialog.getByRole('button', { name: 'Move to Trash' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
    await frame.getByRole('button', { name: 'Fix the project picker actions', exact: true }).click()
    const deletion = page.getByRole('menuitem', { name: /^Delete everywhere…(?:\s|$)/ })
    await expect(deletion).toHaveAttribute('aria-disabled', 'true')
    await expect(deletion).toHaveAttribute('title', 'Beta erases it for good, so delete it there')
  })
}
