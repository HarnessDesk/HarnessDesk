import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Review instrument only. Nothing here alters the product or its baseline.
// TYPE_AUDIT_FRAMES=sidebar-column,goal-roster reruns two specimens.
const OUT = path.resolve('output/typography')
const FILTER = process.env.TYPE_AUDIT_FRAMES?.split(',')
const source = readFileSync('packages/ui/src/design/patterns/Settings.tsx', 'utf8')
const roleMap = Object.fromEntries([...source.slice(source.indexOf('const TEXT_ROLE ='), source.indexOf('const TEXT_ROLE_INK ='))
  .matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map(match => [match[1], match[2].split(/\s+/)]))
const write = (file: string, data: unknown) => writeFileSync(path.join(OUT, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n')
const dial = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}`) }).locator('select').first()
const ready = async (page: Page) => {
  await page.getByText('Mounting the screen…', { exact: true }).waitFor({ state: 'hidden' })
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
}
const themePreview = async (page: Page, theme: string) => {
  await dial(page, 'theme').selectOption(theme)
  await dial(page, 'interface').selectOption('desk')
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
  await ready(page)
}

const collect = (page: Page, selector: string, frame: string, theme: string) => page.locator(selector).evaluate((root, context) => {
  const visible = (el: Element) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"], [data-preview-caption], .sr-only')) return false
    for (let node: Element | null = el; node; node = node.parentElement) {
      const css = getComputedStyle(node)
      if (css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0) return false
    }
    const box = el.getBoundingClientRect()
    return box.width > 1 && box.height > 1
  }
  const domPath = (el: Element) => {
    const parts: string[] = []
    for (let node: Element | null = el; node && root.contains(node); node = node.parentElement) {
      const slot = node.getAttribute('data-slot')
      const region = node.getAttribute('data-region')
      const label = slot ? `[data-slot="${slot}"]` : region ? `[data-region="${region}"]` : node.tagName.toLowerCase()
      const peers = node.parentElement ? [...node.parentElement.children].filter(peer => peer.tagName === node!.tagName && peer.getAttribute('data-slot') === slot && peer.getAttribute('data-region') === region) : [node]
      parts.unshift(label + (peers.length > 1 ? `:nth-match(${peers.indexOf(node) + 1})` : ''))
    }
    return parts.join(' > ')
  }
  const resolveInk = (el: Element) => {
    const probe = document.createElement('span')
    el.appendChild(probe)
    const entries = ['foreground', 'secondary-foreground', 'muted-foreground'].map(token => {
      probe.style.color = `var(--hd-${token})`
      return [token, getComputedStyle(probe).color]
    })
    probe.remove()
    return entries
  }
  const role = (el: Element) => {
    for (let node: Element | null = el; node && root.contains(node); node = node.parentElement) {
      if (node.hasAttribute('data-role')) return { role: node.getAttribute('data-role')!, roleSource: 'data-role' }
      const matches = Object.entries(context.roles).filter(([, classes]) => classes.every(name => node!.classList.contains(name)))
      if (matches.length === 1) return { role: matches[0][0], roleSource: 'class-reverse-map' }
    }
    return { role: 'unnamed', roleSource: 'none' }
  }
  const nodes = [root, ...root.querySelectorAll('*')].filter(visible)
  return nodes.flatMap(el => {
    const direct = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    const control = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    if (!direct.length && !control) return []
    const text = direct.map(node => node.textContent!.trim()).join(' ') || (control ? el.value || el.placeholder : '')
    if (!text.trim()) return []
    const css = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const path = domPath(el)
    const canvas = document.createElement('canvas').getContext('2d')!
    canvas.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`
    const x = canvas.measureText('x')
    const cap = canvas.measureText('H')
    const inks = resolveInk(el)
    const area = path.includes('sidebar') || context.frame.includes('sidebar') ? 'sidebar lists'
      : el.closest('aside[class*="rail_"]') ? 'team rail'
      : path.includes('composer') || el.closest('[class*="composer_"]') || control && el instanceof HTMLTextAreaElement ? 'composer'
      : path.includes('room-stream') || context.frame.includes('conversation') || context.frame.includes('transcript') ? 'chat'
      : /menu/.test(path + context.frame) ? 'menus'
      : /settings|workspace|runtimes|library/.test(context.frame) ? 'Settings'
      : /dashboard|usage|insight/.test(context.frame) ? 'dashboard'
      : /dialog/.test(path + context.frame) || el.closest('[role="dialog"]') ? 'dialogs'
      : /panel/.test(context.frame) ? 'right panel' : 'other boards and frames'
    return [{ frame: context.frame, theme: context.theme, area, path, slot: el.getAttribute('data-slot'),
      text: text.replace(/\/Users\/[^/\s]+/g, '/Users/dev').slice(0, 180), textKind: direct.length ? 'direct-text' : 'form-value-or-placeholder',
      ...role(el), size: parseFloat(css.fontSize), weight: Number(css.fontWeight), lineHeight: css.lineHeight,
      letterSpacing: css.letterSpacing, fontFamily: css.fontFamily, color: css.color,
      ink: inks.find(([, value]) => value === css.color)?.[0] ?? 'other', resolvedInks: Object.fromEntries(inks),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      xHeight: x.actualBoundingBoxAscent + x.actualBoundingBoxDescent,
      capHeight: cap.actualBoundingBoxAscent + cap.actualBoundingBoxDescent,
    }]
  })
}, { frame, theme, roles: roleMap })
type Sample = Awaited<ReturnType<typeof collect>>[number]

const tables = (samples: Sample[]) => {
  const areas = [...new Set(samples.map(sample => sample.area))]
  return areas.map(area => {
    const groups = new Map<string, Sample[]>()
    for (const sample of samples.filter(item => item.area === area)) {
      const key = [sample.theme, sample.size, sample.weight, sample.lineHeight, sample.ink].join(' | ')
      groups.set(key, [...(groups.get(key) ?? []), sample])
    }
    return `## ${area}\n\n| Theme | px | Weight | Line | Ink | Text owners | Roles | Frame examples |\n|---|---:|---:|---|---|---:|---|---|\n` + [...groups].sort().map(([key, rows]) => `| ${key} | ${rows.length} | ${[...new Set(rows.map(row => row.role))].join(', ')} | ${[...new Set(rows.map(row => row.frame))].slice(0, 5).join(', ')} |`).join('\n')
  }).join('\n\n') + '\n'
}
const flags = (samples: Sample[]) => {
  const scale = new Set([12, 13, 14, 16, 20, 24, 36])
  const findings = samples.flatMap(sample => [
    ...(!scale.has(sample.size) ? ['off-scale'] : []), ...(sample.role === 'unnamed' ? ['unnamed'] : []),
  ].map(kind => ({ kind, frame: sample.frame, theme: sample.theme, path: sample.path,
    text: sample.text, pair: [sample.size, sample.weight], role: sample.role,
  })))
  const family = (sample: Sample) => sample.role === 'member' || sample.area === 'team rail' && sample.path.includes('list-row-title') && ['Alpha', 'Beta', 'Gamma', 'Delta'].includes(sample.text) ? 'people/agent names'
    : /title|session-row/.test(sample.path) || ['navigation', 'subject', 'row'].includes(sample.role) ? 'thing names'
    : sample.role === 'meta' || /time|meta/.test(sample.path) ? 'timestamps/meta'
    : /group-label/.test(sample.path) ? 'group headings'
    : /button/.test(sample.path) ? 'buttons' : null
  const families = new Map<string, Sample[]>()
  for (const sample of samples) {
    const name = family(sample)
    if (name) families.set(name, [...(families.get(name) ?? []), sample])
    const slots = [...sample.path.matchAll(/data-slot="([^"]+)"/g)].map(match => match[1])
    const component = slots.filter(slot => slot !== 'text').at(-1)
    if (component) {
      const key = `slot family: ${component}`
      families.set(key, [...(families.get(key) ?? []), sample])
    }
  }
  const clusters = [...families].map(([name, rows]) => ({ name,
    treatments: [...new Set(rows.map(row => `${row.size}/${row.weight}`))].sort().map(pair => ({ pair,
      frames: [...new Set(rows.filter(row => `${row.size}/${row.weight}` === pair).map(row => row.frame))].sort(),
      examples: rows.filter(row => `${row.size}/${row.weight}` === pair).slice(0, 8).map(row => ({ frame: row.frame, path: row.path, text: row.text })),
    })),
  })).filter(cluster => cluster.treatments.length > 1)
  // Match the same literal name across declared name roles and title slots;
  // don't infer that every 500/600 label is a person's name.
  const nameTexts = new Set(samples.filter(sample => ['member', 'subject', 'row', 'navigation'].includes(sample.role) || sample.slot === 'list-row-title').map(sample => sample.text))
  const nameWeightClusters = [...nameTexts].sort().flatMap(text => {
    const rows = samples.filter(sample => sample.text === text && [500, 600].includes(sample.weight))
    if (new Set(rows.map(row => row.weight)).size !== 2) return []
    return [{ text, occurrences: rows.map(row => ({ frame: row.frame, theme: row.theme, path: row.path, role: row.role, size: row.size, weight: row.weight })) }]
  })
  return { findings, clusters, nameWeightClusters }
}

test.describe('opt-in typography review', () => {
  test.skip(process.env.TYPE_AUDIT !== '1', 'TYPE_AUDIT=1 writes review evidence; never a product gate')

  test('instrument observes a deliberate size and weight mutation', async ({ page }) => {
    await page.goto('/preview.html')
    await ready(page)
    const target = '[data-frame-id="sidebar-column"] [data-slot="text"][data-role="navigation"]'
    const baseline = await collect(page, '[data-frame-id="sidebar-column"] > div', 'sidebar-column', 'light')
    expect(baseline.some(row => row.role === 'navigation' && row.size === 13 && row.weight === 400)).toBe(true)
    const mutation = await page.addStyleTag({ content: `${target} { font-size: 15px !important; font-weight: 600 !important; }` })
    const altered = await collect(page, '[data-frame-id="sidebar-column"] > div', 'sidebar-column', 'light')
    expect(flags(altered).findings.some(row => row.kind === 'off-scale' && row.pair[0] === 15)).toBe(true)
    expect(altered.some(row => row.role === 'navigation' && row.weight === 600)).toBe(true)
    await mutation.evaluate(node => node.remove())
  })

  test('records the preview frames and every design board in both themes', async ({ page }) => {
    test.setTimeout(600_000)
    mkdirSync(OUT, { recursive: true })
    const all: Sample[] = []
    const coverage: { frame: string; theme: string; route: string; owners: number }[] = []
    const routes = FILTER ? [''] : ['', '?composer&empty&dense&side-by-side&library-options&composer-slots&notice-placement&board-tool-approvals&sidebar=compact', '?sidebar=no-folder']
    for (const theme of ['light', 'dark']) {
      const seen = new Set<string>()
      for (const route of routes) {
        await page.goto('/preview.html' + route)
        await themePreview(page, theme)
        const frames = await page.locator('[data-frame-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-frame-id')!))
        for (const id of frames) {
          if (seen.has(id) || FILTER && !FILTER.includes(id)) continue
          seen.add(id)
          const rows = await collect(page, `[data-frame-id="${id}"] > div`, id, theme)
          all.push(...rows)
          coverage.push({ frame: id, theme, route: '/preview.html' + route, owners: rows.length })
        }
      }
      if (!FILTER) {
        // The four literal Frames gated behind page dials are separate states.
        // The remaining sheets portal outside Frames and are covered on boards.
        await page.goto('/preview.html')
        await themePreview(page, theme)
        for (const [label, value, id] of [
          ['panel sheet', 'split tree', 'panes-split-tree'], ['panel sheet', 'git tools', 'tools-git'],
          ['goals sheet', 'findings rail', 'goal-findings-rail'], ['settings sheet', 'plugins', 'settings-plugins'],
        ]) {
          await dial(page, label).selectOption(value)
          await page.locator(`[data-frame-id="${id}"]`).waitFor()
          await ready(page)
          const rows = await collect(page, `[data-frame-id="${id}"] > div`, id, theme)
          all.push(...rows)
          coverage.push({ frame: id, theme, route: `/preview.html (${label}=${value})`, owners: rows.length })
          await dial(page, label).selectOption('off')
        }
        await page.goto('/design.html')
        await page.getByRole('radio', { name: theme, exact: true }).click()
        await ready(page)
        const nav = page.locator('nav button')
        const count = await nav.count()
        expect(count).toBeGreaterThan(10)
        for (let index = 0; index < count; index++) {
          await nav.nth(index).click()
          await ready(page)
          const root = page.locator('[data-alignment-board-id]')
          const id = (await root.getAttribute('data-alignment-board-id'))!
          const rows = await collect(page, '[data-alignment-board-id]', `board:${id}`, theme)
          all.push(...rows)
          coverage.push({ frame: `board:${id}`, theme, route: `/design.html?view=${id}`, owners: rows.length })
        }
      }
    }
    expect(all.length).toBeGreaterThan(20)
    const prefix = FILTER ? 'spot-' : ''
    write(prefix + 'samples.json', all)
    write(prefix + 'coverage.json', coverage)
    write(prefix + 'area-tables.md', tables(all))
    const found = flags(all)
    expect(found.findings.filter(row => row.kind === 'unnamed')).toHaveLength(all.filter(row => row.role === 'unnamed').length)
    write(prefix + 'flags.json', found)
    write(prefix + 'name-weights.md', '# Literal names at 500 and 600\n\nCandidates come from named text roles or ListRow title slots. These are exact-text matches, not a claim that every matching title denotes a person. Every occurrence is retained in flags.json under nameWeightClusters.\n\n' + found.nameWeightClusters.map(cluster => `## ${cluster.text.replaceAll('|', '\\|')}\n\n` + [...new Set(cluster.occurrences.map(row => `${row.size}/${row.weight}: ${row.frame} (${row.role})`))].sort().map(line => `- ${line}`).join('\n')).join('\n\n') + '\n')
    write(prefix + 'flags.md', `# Measured flags\n\n${found.findings.filter(row => row.kind === 'off-scale').length} off-scale text owners; ${found.findings.filter(row => row.kind === 'unnamed').length} unnamed owners. These are observations, not all defects: Markdown ratios and primitive-owned labels have separate contracts. Every occurrence (frame, theme, path, pair) is in flags.json.\n\n` + found.clusters.map(cluster => `## ${cluster.name}\n\n` + cluster.treatments.map(item => `- ${item.pair}: ${item.frames.join(', ')}`).join('\n')).join('\n\n') + '\n')
    if (!FILTER) {
      let raw = 'No raw numeric font-size or arbitrary Tailwind size matches in packages/ui/src.\n'
      try { raw = execFileSync('git', ['grep', '-nE', 'font-size:[[:space:]]*[0-9]|text-\\[[0-9]+(px|rem|em)\\]', '--', 'packages/ui/src'], { encoding: 'utf8' }) }
      catch (error) { if ((error as { status?: number }).status !== 1) throw error }
      write('source-type.txt', raw)
      try { write('strict-audit.txt', execFileSync('node', ['script/design-audit.mjs', '--strict'], { encoding: 'utf8' })) }
      catch (error) { write('strict-audit.txt', String((error as { stdout?: string }).stdout ?? error)); throw error }
      write('provenance.json', { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), viewport: [1440, 900], interface: 'desk', userAgent: await page.evaluate(() => navigator.userAgent), roleMap, command: 'TYPE_AUDIT=1 pnpm exec playwright test -c playwright.ui-system.config.ts typography-audit.spec.ts' })
    }
  })

  test('makes real-screen comparisons, font metrics and a ruled specimen', async ({ page }) => {
    test.setTimeout(120_000)
    test.skip(Boolean(FILTER), 'two-frame measurement mode')
    mkdirSync(OUT, { recursive: true })
    const switches: unknown[] = []
    for (const theme of ['light', 'dark']) {
      await page.goto('/preview.html')
      await themePreview(page, theme)
      await page.evaluate(async () => {
        // Reuse the shipped preview channel rather than fabricate messages.
        // The default Goal board has an empty channel; the room fixture has one.
        const { store, TEAM } = await new Function('return import("/src/preview/harness.tsx")')()
        const snapshot = store.getSnapshot()
        const teams = new Map(snapshot.teams)
        teams.set('goal-needs-you', { ...teams.get('goal-needs-you'), channel: TEAM.channel })
        store.patch({ teams })
      })
      await page.locator('[data-frame-id="goal-roster"] [data-slot="room-stream"] [data-role="member"]').first().waitFor({ timeout: 10_000 })
      // Existing mounted screens remain live: move their DOM roots into one
      // review-only grid. No invented product, state, or transcript.
      await page.evaluate(() => {
        const stage = document.createElement('div')
        stage.id = 'type-comparison'
        stage.style.cssText = 'display:grid;grid-template-columns:240px 650px 510px;width:1400px;height:820px;gap:0;background:var(--hd-background);color:var(--hd-foreground);font-family:var(--hd-font-family)'
        for (const id of ['sidebar-column', 'goal-roster', 'conversation-composer']) {
          const content = document.querySelector(`[data-frame-id="${id}"] > div`)!
          const cell = document.createElement('div')
          cell.setAttribute('data-type-area', id)
          cell.style.cssText = 'min-width:0;height:820px;overflow:hidden;border-right:1px solid var(--hd-border)'
          cell.appendChild(content)
          stage.appendChild(cell)
        }
        document.body.prepend(stage)
      })
      await ready(page)
      const rows = await collect(page, '#type-comparison', 'composed-real-screens', theme)
      const core = {
        sidebar: rows.find(row => row.area === 'sidebar lists' && row.role === 'navigation'),
        rail: rows.find(row => row.area === 'team rail' && row.slot === 'list-row-title' && row.text === 'Alpha'),
        sender: rows.find(row => row.path.includes('room-stream') && row.role === 'member'),
        body: rows.find(row => row.path.includes('room-stream') && / > p(?::|$)/.test(row.path) && row.size === 14 && row.weight === 400),
        composer: rows.find(row => row.textKind === 'form-value-or-placeholder' && row.size === 14),
      }
      for (const [name, sample] of Object.entries(core)) expect(sample, `composed screen includes ${name}`).toBeDefined()
      const pairs: unknown[] = []
      for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
        const first = rows[a], second = rows[b]
        if (first.role === second.role) continue
        const dx = Math.max(0, Math.max(first.box.x, second.box.x) - Math.min(first.box.x + first.box.width, second.box.x + second.box.width))
        const dy = Math.max(0, Math.max(first.box.y, second.box.y) - Math.min(first.box.y + first.box.height, second.box.y + second.box.height))
        if (dx > 24 || dy > 24 || dx > 0 && dy > 0) continue
        pairs.push({ first: { role: first.role, path: first.path, text: first.text }, second: { role: second.role, path: second.path, text: second.text }, sizeDelta: second.size - first.size, weightDelta: second.weight - first.weight, xHeightRatio: first.xHeight ? second.xHeight / first.xHeight : null, sameVisualCluster: true, horizontalGap: dx, verticalGap: dy })
      }
      switches.push({ theme, core, rows, adjacentPairs: pairs, referencePairs: Object.entries(core).flatMap(([firstName, first], index, entries) => entries.slice(index + 1).map(([secondName, second]) => {
        const dx = Math.max(0, Math.max(first!.box.x, second!.box.x) - Math.min(first!.box.x + first!.box.width, second!.box.x + second!.box.width))
        const dy = Math.max(0, Math.max(first!.box.y, second!.box.y) - Math.min(first!.box.y + first!.box.height, second!.box.y + second!.box.height))
        return { first: firstName, second: secondName, sizeDelta: second!.size - first!.size, weightDelta: second!.weight - first!.weight, xHeightRatio: second!.xHeight / first!.xHeight, sameVisualCluster: dx <= 24 && dy <= 24 && (dx === 0 || dy === 0), horizontalGap: dx, verticalGap: dy }
      })) })
      await page.locator('#type-comparison').screenshot({ path: path.join(OUT, `current-${theme}.png`) })
      const softened = await page.addStyleTag({ content: '#type-comparison [data-role="member"] { font-size:14px!important;font-weight:500!important;line-height:var(--hd-line)!important }' })
      await page.locator('#type-comparison').screenshot({ path: path.join(OUT, `recommendation-${theme}.png`) })
      await softened.evaluate(node => node.remove())
      const promotedSelector = '#type-comparison aside[class*="rail_"] [class*="memberRow"] [data-slot="list-row-title"]'
      const promoted = await page.addStyleTag({ content: `${promotedSelector} { font-size:14px!important;font-weight:600!important;line-height:var(--hd-line)!important }` })
      expect(await page.locator(promotedSelector).first().evaluate(node => getComputedStyle(node).fontSize)).toBe('14px')
      await page.locator('#type-comparison').screenshot({ path: path.join(OUT, `alternative-${theme}.png`) })
      await promoted.evaluate(node => node.remove())
      await page.evaluate(() => {
        const ruled = document.createElement('div')
        ruled.id = 'type-ruled'
        ruled.style.cssText = 'width:700px;padding:24px;background:var(--hd-background);color:var(--hd-foreground);font-family:Geist'
        ruled.innerHTML = '<h2 style="font:500 14px Geist">Same word, Geist; rules mark each 32px cell</h2>' + [13, 14].flatMap(size => [400, 500, 600].map(weight => `<div style="display:flex;align-items:center;height:32px;border-bottom:1px solid var(--hd-border)"><span style="width:120px;font:400 12px Geist">${size}px / ${weight}</span><span style="font:${weight} ${size}px/21px Geist">HarnessDesk Alpha</span></div>`)).join('')
        document.body.prepend(ruled)
      })
      await page.locator('#type-ruled').screenshot({ path: path.join(OUT, `ruled-${theme}.png`) })
    }
    write('font-switch.json', switches)
  })

  test('measures trim and platform fonts in the real Electron renderer', async ({ page, baseURL }) => {
    test.setTimeout(180_000)
    test.skip(Boolean(FILTER), 'two-frame measurement mode')
    mkdirSync(OUT, { recursive: true })
    const rig = mkdtempSync(path.join(tmpdir(), 'harnessdesk-type-'))
    const require = createRequire(path.resolve('packages/desktop/package.json'))
    let browser: Browser | undefined
    let child: ReturnType<typeof spawn> | undefined
    let nativeError: string | null = null
    let versions: unknown = null
    let target = page
    try {
      child = spawn(require('electron'), ['.', '--inspect=0', '--remote-debugging-port=0', `--user-data-dir=${rig}/electron`, '--use-mock-keychain', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'], { cwd: path.resolve('packages/desktop'), env: { ...process.env, HARNESSDESK_HOME: `${rig}/home`, CODEX_HOME: `${rig}/codex`, HARNESSDESK_MENU_BAR: 'off', HARNESSDESK_NO_UPDATE_CHECK: '1', HARNESSDESK_CODEX_BINARY: path.resolve('packages/adapter-codex/test/fixtures/fake-codex.mjs') }, stdio: ['ignore', 'ignore', 'pipe'] })
      let logs = ''
      const endpoint = await new Promise<{ renderer: string; main: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Electron CDP startup: no renderer DevTools endpoint within 30s')), 30_000)
        child!.once('error', error => { clearTimeout(timeout); reject(error) })
        child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Electron exited before renderer CDP: ${code}`)) })
        child!.stderr!.on('data', bytes => {
          logs += String(bytes)
          const renderer = /DevTools listening on (ws:\/\/\S+)/.exec(logs)?.[1]
          const main = /Debugger listening on (ws:\/\/\S+)/.exec(logs)?.[1]
          if (renderer && main) { clearTimeout(timeout); resolve({ renderer, main }) }
        })
      })
      // A debugger may advertise an endpoint without answering it. Bound the
      // handshake as well as the request, including Node's inspector socket.
      const main = new WebSocket(endpoint.main)
      try {
        versions = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Electron process.versions inspector handshake/request timed out after 10s')), 10_000)
          main.onopen = () => main.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'process.versions', returnByValue: true } }))
          main.onerror = () => { clearTimeout(timeout); reject(new Error('Electron main inspector WebSocket failed')) }
          main.onmessage = event => {
            const result = JSON.parse(String(event.data))
            if (result.id !== 1) return
            clearTimeout(timeout)
            if (result.error) reject(new Error(result.error.message))
            else resolve(result.result.result.value)
          }
        })
      } finally { main.close() }
      browser = await chromium.connectOverCDP(endpoint.renderer, { timeout: 10_000 })
      console.log('[typography/native] renderer connected')
      const context = browser.contexts()[0]
      target = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 10_000 })
    } catch (error) {
      nativeError = String(error).replaceAll(rig, '<temporary-rig>').replaceAll(path.resolve('.'), '<checkout>')
      target = page
    }
    try {
      target.setDefaultTimeout(15_000)
      target.setDefaultNavigationTimeout(20_000)
      await target.setViewportSize({ width: 1440, height: 900 })
      console.log('[typography/native] viewport set')
      await target.goto(`${baseURL}/design.html?view=row`, { waitUntil: 'domcontentloaded' })
      console.log('[typography/native] fixture loaded')
      await target.evaluate(() => document.fonts.ready)
      const support = await target.evaluate(() => ({ userAgent: navigator.userAgent, trim: CSS.supports('text-box-trim', 'trim-both'), edge: CSS.supports('text-box-edge', 'cap alphabetic') }))
      await target.evaluate(async () => {
        const specimen = document.createElement('div')
        specimen.id = 'trim-specimen'
        specimen.style.cssText = 'padding:24px;width:800px;background:var(--hd-background);color:var(--hd-foreground);font-family:var(--hd-font-family)'
        for (const [id, text] of Object.entries({ latin: 'HarnessDesk Hxgj', chinese: '你好，世界', japanese: 'こんにちは世界', korean: '안녕하세요 세계', fallback: 'Alpha 😀 🧑‍💻 → ✓' })) {
          const node = document.createElement('div')
          node.id = `font-${id}`
          node.setAttribute('data-role', 'prose')
          node.style.cssText = 'font-size:14px;font-weight:400;line-height:21px;margin-bottom:12px'
          node.textContent = text
          specimen.appendChild(node)
        }
        document.body.prepend(specimen)
        const load = new Function('url', 'return import(url)')
        const [react, dom, design, tabs] = await Promise.all([
          load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
          load('/src/design/index.ts'), load('/src/design/ui/tabs.tsx'),
        ])
        const h = react.createElement ?? react.default.createElement
        const createRoot = dom.createRoot ?? dom.default.createRoot
        const controls = document.createElement('div')
        controls.id = 'trim-controls'
        controls.style.cssText = 'width:800px;padding:24px;background:var(--hd-background);color:var(--hd-foreground);font-family:var(--hd-font-family)'
        document.body.prepend(controls)
        createRoot(controls).render(h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
            ...['default', 'sm', 'chip'].map(size => h(design.Button, { key: `button:${size}`, size, variant: 'outline' }, 'Alpha 你好 あ 한 😀')),
            h(design.Chip, { variant: 'quiet' }, 'Alpha 你好 あ 한 😀')),
          h(tabs.Tabs, { defaultValue: 'one' }, h(tabs.TabsList, {}, h(tabs.TabsTrigger, { value: 'one' }, 'Alpha 你好 あ 한 😀'), h(tabs.TabsTrigger, { value: 'two' }, 'Beta'))),
          ...['default', 'compact', 'row'].map(controlSize => h(design.Input, { key: `input:${controlSize}`, controlSize, readOnly: true, value: 'Alpha 你好，世界 こんにちは世界 안녕하세요 세계 😀' })),
          ...['navigation', 'row', 'member', 'subject', 'meta', 'muted', 'prose', 'section', 'page', 'wordmark', 'figure', 'metric', 'value'].map(role => h(design.Text, { key: `role:${role}`, role, as: 'div' }, `${role}: Alpha Hxgj 你好 あ 한 😀`)),
        ))
      })
      await target.evaluate(() => document.fonts.ready)
      await target.locator('#trim-controls [data-slot="input"]').first().waitFor()
      console.log('[typography/native] specimens mounted')
      const cdp = await target.context().newCDPSession(target)
      // Native windows can be occluded by the person's desk. Capture the
      // measured rectangle over CDP without a locator's animation-frame wait.
      const capture = async (selector: string, file: string) => {
        const clip = await target.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 } })
        const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
        writeFileSync(path.join(OUT, file), Buffer.from(result.data, 'base64'))
      }
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      const { root } = await cdp.send('DOM.getDocument')
      const fonts: unknown[] = []
      for (const id of ['latin', 'chinese', 'japanese', 'korean', 'fallback']) {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#font-${id}` })
        fonts.push({ id, ...await cdp.send('CSS.getPlatformFontsForNode', { nodeId }) })
      }
      const measureTrim = () => target.evaluate(() => {
        const targets = [...document.querySelectorAll<HTMLElement>('[data-role], [data-slot="button"], [data-slot="chip"], [role="tab"], input, textarea')]
        return targets.filter(node => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 1 && box.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' }).map((node, index) => {
          const style = getComputedStyle(node), box = node.getBoundingClientRect()
          const canvas = document.createElement('canvas').getContext('2d')!
          canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
          const metrics = (text: string) => { const m = canvas.measureText(text); return { ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent, fontAscent: m.fontBoundingBoxAscent, fontDescent: m.fontBoundingBoxDescent } }
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
          let rangeRect: DOMRect | undefined
          while (walker.nextNode()) { if (!walker.currentNode.textContent?.trim()) continue; const range = document.createRange(); range.selectNodeContents(walker.currentNode); rangeRect = [...range.getClientRects()].find(rect => rect.width > 0); break }
          const cap = metrics('H'), x = metrics('x'), actual = metrics(node.textContent?.trim() || (node instanceof HTMLInputElement ? node.value || node.placeholder : 'Hx'))
          const baseline = rangeRect ? rangeRect.y + (rangeRect.height - cap.fontAscent - cap.fontDescent) / 2 + cap.fontAscent : null
          const topGap = baseline === null ? null : baseline - cap.ascent - box.top
          const bottomGap = baseline === null ? null : box.bottom - (baseline + cap.descent)
          return { index, id: node.id, slot: node.dataset.slot ?? node.tagName.toLowerCase(), role: node.dataset.role, text: node.textContent?.trim().slice(0, 80), size: style.fontSize, fontFamily: style.fontFamily, height: box.height, width: box.width, top: box.top, border: style.borderTopWidth, overflow: style.overflow, range: rangeRect ? { top: rangeRect.y, height: rangeRect.height } : null, cap, x, actual, baseline, topGap, bottomGap, gapImbalance: topGap === null || bottomGap === null ? null : topGap - bottomGap }
        })
      })
      const before = await measureTrim()
      await capture('#trim-specimen', 'trim-before.png')
      await capture('#trim-controls', 'trim-controls-before.png')
      await target.addStyleTag({ content: '[data-role], [data-slot="button"], [data-slot="chip"], [role="tab"], input, textarea { text-box-trim:trim-both; text-box-edge:cap alphabetic; }' })
      const after = await measureTrim()
      await capture('#trim-specimen', 'trim-after.png')
      await capture('#trim-controls', 'trim-controls-after.png')
      write('text-box-trim.json', { environment: target === page ? 'Chromium, not the app' : 'real Electron app renderer, fixture preview loaded into its window', nativeError, versions, support, platformFonts: fonts, method: 'Baseline estimated from Range line box and canvas font ascent/descent; cap-gap proxy, not raster glyph/clipping proof. Input Range absent => gaps null.', before, after, deltas: before.map((row, index) => ({ id: row.id, slot: row.slot, role: row.role, heightDelta: after[index].height - row.height, topDelta: after[index].top - row.top, imbalanceBefore: row.gapImbalance, imbalanceAfter: after[index].gapImbalance })) })
      console.log('[typography/native] evidence saved')
      await cdp.detach()
    } finally {
      child?.kill('SIGINT')
      await browser?.close()
      // Keep the synthetic rig local for diagnosis. Never remove a desk/profile.
    }
  })
})
