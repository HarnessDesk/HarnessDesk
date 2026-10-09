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
    const credit = (candidate: unknown): void => {
      const components = refToComponents.get(candidate)
      if (components) for (const component of components) covered.add(component)
    }
    // One visible leaf can share its complete fiber ancestry with thousands
    // of other DOM elements. Visit each ancestry once for this page state:
    // coverage remains reference-based, while a large preview stops doing
    // the same work once per leaf.
    const seenFibers = new Set<unknown>()
    for (const el of document.querySelectorAll('*')) {
      if (!isVisible(el)) continue
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
      if (!key) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fiber: any = (el as unknown as Record<string, unknown>)[key]
      while (fiber && !seenFibers.has(fiber)) {
        seenFibers.add(fiber)
        const type = fiber.type
        credit(type)
        credit(fiber.elementType)
        if (type && typeof type === 'object') {
          credit(type.render) // forwardRef
          credit(type.type) // memo
        }
        fiber = fiber.return
      }
    }
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
): Promise<{ covered: readonly string[]; delayedReveal: boolean | null }> =>
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
    const collect = (): void => {
      // Keep this set local to a collection: each dial value is a distinct
      // page state and can reveal a different mounted subtree.
      const seenFibers = new Set<unknown>()
      for (const el of document.querySelectorAll('*')) {
        if (!isVisible(el)) continue
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
        if (!key) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fiber: any = (el as unknown as Record<string, unknown>)[key]
        while (fiber && !seenFibers.has(fiber)) {
          seenFibers.add(fiber)
          const type = fiber.type
          const credit = (candidate: unknown): void => {
            const components = refToComponents.get(candidate)
            if (components) for (const component of components) covered.add(component)
          }
          credit(type)
          credit(fiber.elementType)
          if (type && typeof type === 'object') {
            credit(type.render)
            credit(type.type)
          }
          fiber = fiber.return
        }
      }
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
    const selects = probe ? [probe.select] : [...document.querySelectorAll('select')]
    for (const select of selects) {
      const values = [...select.options].map((option) => option.value)
      const neutral = values[0]
      for (const value of values) {
        setValue(select, value)
        await settle()
        collect()
      }
      if (select.value !== neutral && neutral !== undefined) {
        setValue(select, neutral)
        await settle()
      }
    }
    const delayedReveal = probe ? !probe.reveal.hidden : null
    probe?.select.remove()
    probe?.reveal.remove()
    return { covered: [...covered], delayedReveal }
  }, { delayedRevealProbe })

test.describe('preview coverage', () => {
  test('Seat browsers preview live pages and Seats with nothing open', async ({ page }) => {
    await page.goto('/preview.html?tile-browsers')
    const live = page.locator('[data-frame-id="side-by-side-browsers"]')
    await expect(live.frameLocator('iframe').first().getByRole('heading', { name: 'The daily planner' })).toBeVisible()
    await expect(live.frameLocator('iframe').nth(1).getByRole('heading', { name: 'The reading shelf' })).toBeVisible()
    const mixed = page.locator('[data-frame-id="side-by-side-browsers-empty"]')
    await expect(mixed.locator('iframe')).toHaveCount(2)
    await expect(mixed.getByText('Nothing open yet', { exact: true })).toHaveCount(2)
    await expect(mixed.getByText('Pages the agent opens appear here.', { exact: true })).toHaveCount(2)
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

  test('the coverage sweep settles a dial whose visible content follows an effect', async ({ page }) => {
    await page.goto('/preview.html')
    const result = await sweepSelectsForCoverage(page, { delayedRevealProbe: true })
    expect(result.delayedReveal).toBe(true)
  })

  test('a hidden or transparent preview wrapper earns no component coverage', async ({ page }) => {
    for (const [property, value] of [['display', 'none'], ['opacity', '0']] as const) {
      await page.goto('/preview.html')
      // Dialog portals sit beside #root. Hiding the document element makes
      // this a regression for both ordinary descendants and portal content.
      await page.locator('html').evaluate((node, style) => { ;(node as HTMLElement).style[style.property] = style.value }, { property, value })
      expect(await collectCoverage(page), `${property}: ${value}`).toMatchObject({ covered: [] })
    }
  })

  test('every exported components/ and panels/ component renders in preview.html or design.html', async ({ page }) => {
    // It visits every dial of both pages; on the hosted runner that now takes
    // about three minutes, and at 180s it failed two runs in three with
    // nothing wrong (#1140). Sharding is the lasting fix.
    test.setTimeout(360_000)
    const covered = new Set<string>()
    let allComponents: readonly string[] = []

    await page.goto('/design.html?view=team-start')
    await page.getByRole('button', { name: 'Picker', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
    const teamStartCoverage = await collectCoverage(page)
    expect(teamStartCoverage.covered).toContain('components/FrontDoor.tsx#FrontDoor')
    for (const component of teamStartCoverage.covered) covered.add(component)

    // -- preview.html: the page's own frames, then every dial's every option.
    // `?composer`, `?empty`, `?board-tool-approvals` and `?notice-placement` gate
    // frames the plain page never draws — a composer with a picture, a queue,
    // and the pane with no session at all; the board's tool approvals; whole
    // windows whose Workbench draws the notice's fallback host; compact
    // inspectors include the Seat record and its attachments — so each is visited too.
    for (const query of ['', '?composer', '?empty', '?board-tool-approvals', '?notice-placement', '?compact-panels', '?board-list', '?team-frame=controls', '?tile-browsers']) {
      await page.goto(`/preview.html${query}`)
      if (query === '?board-list') await page.getByRole('radio', { name: 'List', exact: true }).click()
      if (query === '?team-frame=controls') await expect(page.getByRole('menuitem', {name:'Fill the window',exact:true})).toBeVisible()
      await page.waitForTimeout(1200)
      const result = await collectCoverage(page)
      allComponents = result.allComponents
      for (const file of result.covered) covered.add(file)
    }

    // The catalogue's standalone grids omit the shared composer. The real
    // Team preview mounts its recipient settings under the shared dock.
    await page.goto('/preview.html?side-by-side')
    await expect(page.locator('[data-frame-id="side-by-side-two"] [data-shared-composer]')).toBeVisible()
    const sharedComposerCoverage = await collectCoverage(page)
    expect(sharedComposerCoverage.covered).toContain('components/RoomComposerOptions.tsx#RoomComposerOptions')
    for (const component of sharedComposerCoverage.covered) covered.add(component)

    // Comparison frames mount the recorded verdict; its person scene opens
    // the same real attempt dialog as the Board, with synthetic candidates.
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

    // A trigger Team mounts its history only after the Runs tab opens.
    await page.goto('/preview.html?team-frame=trigger-runs')
    const triggerTeam = page.locator('[data-slot="team-room"]')
    await triggerTeam.getByRole('tab', { name: /^Runs/ }).click()
    await expect(triggerTeam.locator('[data-slot="team-runs"]')).toBeVisible()
    const triggerCoverage = await collectCoverage(page)
    expect(triggerCoverage.covered).toContain('components/TeamRuns.tsx#TeamRuns')
    for (const component of triggerCoverage.covered) covered.add(component)

    // The Run supplies its sibling inspectors only after its real Team view mounts.
    await page.goto('/preview.html?run-dock')
    await page.locator('#run-dock-frame [data-team-page="run"]').click()
    await expect(page.locator('#run-dock-frame [data-slot="run-inspector"]:visible')).toBeVisible()
    for (const component of (await collectCoverage(page)).covered) covered.add(component)
    await page.locator('#run-dock-frame').getByRole('radio', { name: 'Flow', exact: true }).click()
    await expect(page.locator('#run-dock-frame [data-slot="run-steps"]:visible')).toBeVisible()
    for (const component of (await collectCoverage(page)).covered) covered.add(component)

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

    await page.goto('/preview.html?history')
    await expect(page.locator('[data-frame-id="history-rows"]').getByRole('button', { name: 'Trace the slow startup', exact: true })).toBeVisible()
    await expect(page.locator('[data-frame-id="history-agent-done"]').getByRole('button', { name: 'Browse', exact: true })).toBeVisible()
    const historyCoverage = await collectCoverage(page)
    expect(historyCoverage.covered).toContain('components/History.tsx#HistorySection')
    expect(historyCoverage.covered).toContain('components/History.tsx#AgentHistory')
    for (const component of historyCoverage.covered) covered.add(component)

    // Fail closed if an import-glob/configuration change silently empties the
    // inventory. These representatives prove we are still checking a root
    // component, a nested component, and a recursively discovered panel.
    expect(allComponents).toEqual(expect.arrayContaining([
      'components/Settings.tsx#Settings',
      'components/usage/ActivityView.tsx#ActivityView',
      'panels/Workbench.tsx#Workbench',
    ]))

    // Normal and composer frames expose different dials. Sweep both, rather
    // than the final `?empty` page alone: a composer-only sheet must earn its
    // own coverage. The empty page adds an inline frame but no unique dial.
    for (const query of ['', '?composer']) {
      await page.goto(`/preview.html${query}`)
      await page.waitForTimeout(1200)
      for (const component of (await sweepSelectsForCoverage(page)).covered) covered.add(component)
    }

    // -- design.html: every board the nav rail lists.
    await page.goto('/design.html')
    await page.waitForTimeout(800)
    {
      const result = await collectCoverage(page)
      for (const file of result.covered) covered.add(file)
    }
    const boardNav = page.getByRole('navigation').filter({ has: page.getByText('Design system', { exact: true }) })
    const boardControls = boardNav.locator(':scope > button')
    const boardLabels = [...new Set(await boardControls.allTextContents())]
      .map((label) => label.trim())
      .filter(Boolean)
    for (const label of boardLabels) {
      const board = boardNav.getByRole('button', { name: label, exact: true })
      await expect(board).toHaveCount(1)
      await board.click()
      // The design navigator has exactly one active board. Confirm the click
      // selected this board before attributing its mounted exports to it.
      const selected = boardNav.locator(':scope > button[data-selected="true"]')
      await expect(selected).toHaveCount(1)
      await expect(selected).toHaveText(label)
      const isProductSurface = await board.evaluate((button) => {
        let heading = button.previousElementSibling
        while (heading?.tagName === 'BUTTON') heading = heading.previousElementSibling
        return heading?.textContent?.trim() === 'Product Surfaces'
      })
      if (isProductSurface) await waitForLazyBoardToSettle(page, label)
      const result = await collectCoverage(page)
      for (const file of result.covered) covered.add(file)
      if (label === 'Panels') expect(result.covered).toContain('panels/Workbench.tsx#Workbench')
    }

    const uncovered = allComponents.filter((component) => !covered.has(component) && !(component in EXEMPT))

    expect(uncovered, `Uncovered components (add a frame/dial in packages/ui/src/preview, or an EXEMPT entry): ${uncovered.join(', ')}`).toEqual([])

    // The guard on the guard: an EXEMPT entry that has since become reachable
    // is a stale claim, not a harmless one — it hides the day a fix or a new
    // dial actually covered the file, and the next person to read EXEMPT
    // trusts a reason that no longer holds.
    const staleExemptions = Object.keys(EXEMPT).filter((component) => covered.has(component))
    expect(staleExemptions, `EXEMPT entries that now render (remove them from EXEMPT): ${staleExemptions.join(', ')}`).toEqual([])
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
    const deletion = page.getByRole('menuitem', { name: 'Delete everywhere…', exact: true })
    await expect(deletion).toBeDisabled()
    await expect(deletion).toHaveAttribute('title', 'Beta erases it for good, so delete it there')
  })
}
