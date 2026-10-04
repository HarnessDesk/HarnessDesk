import { expect, test, type Page } from '@playwright/test'

// #894's original repair is already in ConfirmDialog. Exercise the actual
// attachment-review caller too: text in the DOM alone does not prove that a
// person can read its final character before approving.
const commands = {
  long: 'node ' + 'x'.repeat(1991) + ' end', // Exactly 2,000 characters.
  multiline: ['node', ...Array.from({ length: 80 }, (_, i) => `--argument-${i}=${'x'.repeat(100)}`), '--last-argument=end'].join('\n'),
}

async function openReview(page: Page, text: string, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme })
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import reviewReact from ${JSON.stringify(reactUrl)};
        import { AgentAttachments } from '/src/components/AgentAttachments.tsx';
        import { SummaryList } from '/src/design/index.ts';
        const h = reviewReact.createElement;
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'MCP review fixture');
        // Keep the catalogue's fixed toolbar out of this isolated scene.
        document.getElementById('root').hidden = true;
        document.body.append(frame);
        const entry = {
          id: 'reviewer', origin: 'user', path: '/work/demo/AGENT.md', digest: 'd', shadows: [], problems: [],
          definition: { name: 'Reviewer', skills: [], mcp: ['demo-tools'] },
        };
        const view = {
          agent: entry.id, origin: entry.origin, agentDigest: entry.digest,
          skillsMode: 'runtime-defaults', mcpMode: 'allowlist',
          declarations: [{ kind: 'mcp', name: 'demo-tools', problem: null,
            identity: { kind: 'mcp', name: 'demo-tools', digest: 'e'.repeat(64), source: 'library', pathLabel: '~/demo-tools' } }],
          support: [{ runtime: 'rig', build: '1', skills: 'scoped', mcp: 'scoped-gated', suppressUnapproved: true, reason: null }],
        };
        const snapshot = { ...emptySnapshot(), status: 'open',
          workspace: { name: 'Demo', path: '/work/demo' },
          runtimes: [{ id: 'rig', presentation: { name: 'Rig Agent' } }],
        };
        window.__mcpApprovals = 0;
        const fixtureStore = {
          subscribe: () => () => {}, getSnapshot: () => snapshot,
          readAgentAttachments: async () => view,
          reviewAttachments: async () => ({ token: 'synthetic-review', expiresAt: 0,
            declarations: view.declarations, runtime: 'rig', effectiveCeiling: 'merge',
            consequence: 'This server may load when this Agent is next seated.', hidden: [],
            files: [{ path: 'demo-tools', text: ${JSON.stringify(text)} }],
          }),
          approveAttachments: async () => { window.__mcpApprovals += 1 },
        };
        createRoot(frame).render(h(StoreProvider, { store: fixtureStore },
          h(SummaryList, null, h(AgentAttachments, { entry }))));
      `,
    })
  })
  await page.goto(`/preview.html?theme=${theme}`)
  await page.getByRole('region', { name: 'MCP review fixture' }).getByRole('button', { name: 'Review & Approve…' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Approve what Rig Agent would load?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  return dialog
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 800, 390]) {
    for (const [kind, command] of Object.entries(commands)) {
      test(`MCP ${kind} command is readable before approval at ${width}px in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 600 })
        const text = `transport: stdio\ncommand: ${command}\nenvironment: (nothing added)\nidentity: ${'e'.repeat(64)}\n`
        const dialog = await openReview(page, text, theme)
        const code = dialog.locator('pre')
        expect(await code.textContent()).toBe(text)
        if (width === 1280 && kind === 'long') {
          await page.screenshot({ path: testInfo.outputPath(`mcp-review-${theme}.png`) })
        }

        const geometry = await dialog.evaluate(node => {
          const box = node.getBoundingClientRect()
          const body = node.querySelector<HTMLElement>('[data-slot="confirm-body"]')!
          const code = node.querySelector('pre')!
          const style = getComputedStyle(code)
          return {
            top: box.top, bottom: box.bottom,
            over: Math.max(body.scrollWidth - body.clientWidth, code.scrollWidth - code.clientWidth),
            whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
          }
        })
        expect(geometry.over, 'the whole command fits the reading width').toBeLessThanOrEqual(1)
        expect(geometry.whiteSpace, 'line breaks survive and long words wrap').toBe('pre-wrap')
        expect(geometry.textOverflow).not.toBe('ellipsis')
        expect(geometry.top).toBeGreaterThanOrEqual(0)
        expect(geometry.bottom).toBeLessThanOrEqual(600)

        const buttons = dialog.getByRole('button')
        const before = await buttons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()))
        // The final non-whitespace character must be reachable by scrolling
        // only the body. Inspect its actual glyph rectangle, not just textContent.
        const end = await dialog.evaluate(node => {
          const body = node.querySelector<HTMLElement>('[data-slot="confirm-body"]')!
          const code = node.querySelector('pre')!
          body.scrollTop = body.scrollHeight
          const text = code.firstChild!
          const last = text.textContent!.trimEnd().length
          const range = document.createRange()
          range.setStart(text, last - 1)
          range.setEnd(text, last)
          const glyph = range.getBoundingClientRect()
          const box = body.getBoundingClientRect()
          return { left: glyph.left - box.left, right: glyph.right - box.right,
            top: glyph.top - box.top, bottom: glyph.bottom - box.bottom }
        })
        expect(end.left).toBeGreaterThanOrEqual(0)
        expect(end.right).toBeLessThanOrEqual(1)
        expect(end.top).toBeGreaterThanOrEqual(0)
        expect(end.bottom).toBeLessThanOrEqual(1)
        expect(await buttons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()))).toEqual(before)
        for (const name of ['Approve', 'Keep']) {
          await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport()
        }
        expect(await page.evaluate(() => (window as unknown as { __mcpApprovals: number }).__mcpApprovals)).toBe(0)
        await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Approved', exact: true })).toBeVisible()
        expect(await page.evaluate(() => (window as unknown as { __mcpApprovals: number }).__mcpApprovals)).toBe(1)
      })
    }
  }
}
