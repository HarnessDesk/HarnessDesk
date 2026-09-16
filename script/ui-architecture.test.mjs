import assert from 'node:assert/strict'
import test from 'node:test'

import { scanUiArchitecture } from './ui-architecture.mjs'

test('rejects legacy Kit imports and non-Base headless primitives', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import { Btn } from '../design/primitives/Kit'\nimport { Dialog } from 'radix-ui'",
    },
  ])

  assert.deepEqual(findings.map((finding) => finding.rule), [
    'legacy-design-api',
    'nonpublic-design-import',
    'feature-headless-import',
    'alternate-headless-foundation',
  ])
})

test('allows Base UI only inside canonical primitives', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/design/ui/dialog.tsx',
      source: "import { Dialog } from '@base-ui/react/dialog'",
    },
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import { Dialog } from '@base-ui/react/dialog'",
    },
  ])

  assert.deepEqual(findings, [
    {
      path: 'packages/ui/src/components/Bad.tsx',
      rule: 'feature-headless-import',
      detail: '@base-ui/react/dialog',
    },
  ])
})

test('cannot bypass a retired API through a re-export', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/design/compat.ts',
      source: "export { Btn } from './primitives/Kit'",
    },
  ])
  assert.equal(findings[0]?.rule, 'legacy-design-api')
})

test('allows canonical menu patterns but rejects retired sibling modules', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/design/index.ts',
      source: "export { Menu } from './patterns/Menu'",
    },
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import { Menu } from './Menu'",
    },
  ])

  assert.deepEqual(findings, [
    {
      path: 'packages/ui/src/components/Bad.tsx',
      rule: 'legacy-design-api',
      detail: './Menu',
    },
  ])
})

test('rejects direct design internals and raw stylesheet APIs from production features', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import { Button } from '../design/ui'\nimport { Dialog } from '../design/patterns/ModalDialog'",
    },
    {
      path: 'packages/ui/src/components/Panel.tsx',
      source: 'const styles = {}\nexport { styles as panel }',
    },
  ])

  assert.deepEqual(findings.map((finding) => finding.rule), [
    'nonpublic-design-import',
    'nonpublic-design-import',
    'raw-style-export',
  ])
})

test('rejects private platform tokens and raw controls independent of their class name', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.module.css',
      source: '.button { color: var(--hdp-alias-label-primary); }',
    },
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: '<button className={styles.footLink}>Save</button>',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), [
    'private-platform-token',
    'screen-generic-control',
  ])
})

test('rejects every native form control outside the canonical primitive boundary', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: '<><input className={styles.search} /><textarea /><select><option>One</option></select></>',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), [
    'screen-generic-control',
    'screen-generic-control',
    'screen-generic-control',
  ])
})

test('rejects nullable Button variants and feature-owned menu roles', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: '<><Button variant={null} size={null}>Save</Button><div role="menu">Menu</div></>',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), [
    'nullable-button-contract',
    'screen-owned-menu',
  ])
})

test('rejects a renamed feature class that copies the canonical Button shape', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.module.css',
      source: '.saveThing { height: var(--hd-btn-h); padding: var(--hd-btn-padding); border-radius: var(--hd-btn-radius); background: var(--hd-btn-fill); }',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), ['duplicate-button-styling'])
})

test('connects canonical control className usage to feature CSS regardless of token spelling', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import styles from './Bad.module.css'\nexport const Bad = () => <><Button className={styles.navThing}>Go</Button><Input className={styles.findThing} /></>",
    },
    {
      path: 'packages/ui/src/components/Bad.module.css',
      source: '.navThing { height: var(--hd-nav-h); padding: var(--hd-nav-padding); border-radius: var(--hd-radius); background: none; } .navThing:hover { background: var(--hd-hover); } .findThing { height: 24px; border: none; border-radius: 6px; background: transparent; }',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), [
    'canonical-control-visual-override',
    'canonical-control-visual-override',
  ])
})

test('rejects literal and static cn utilities that redraw canonical controls', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: `
        export const Bad = () => <>
          <Button className="h-20 rounded-full bg-red-500 p-8">Go</Button>
          <Input className={cn('h-16 border-0', true && 'bg-transparent px-0')} />
        </>
      `,
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), [
    'canonical-control-visual-override',
    'canonical-control-visual-override',
  ])
})

test('rejects arbitrary visual utilities and unresolved className values', () => {
  const findings = scanUiArchitecture([{
    path: 'packages/ui/src/components/Bad.tsx',
    source: `
      const CONTROL_OVERRIDE = '[height:80px]'
      export const Bad = () => <>
        <Button className="[height:80px] [background:red] [border-radius:999px]">Go</Button>
        <Input className={cn("size-20 ring-4 opacity-20")} />
        <Textarea className={CONTROL_OVERRIDE} />
      </>
    `,
  }])
  assert.deepEqual(findings.map((finding) => finding.rule), [
    'canonical-control-visual-override',
    'canonical-control-visual-override',
    'unknown-canonical-control-classname',
  ])
})

test('does not mistake a canonical control ancestor for the styled subject', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Good.tsx',
      source: "import styles from './Good.module.css'\nexport const Good = () => <Button className={styles.row}><span className={styles.label}>Go</span></Button>",
    },
    {
      path: 'packages/ui/src/components/Good.module.css',
      source: '.row { display: flex; } .row[data-active] .label { color: var(--hd-foreground); font-weight: 600; }',
    },
  ])
  assert.deepEqual(findings, [])
})

test('rejects non-layout CSS-module declarations on canonical controls', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import styles from './Bad.module.css'\nexport const Bad = () => <Button className={styles.layout}>Go</Button>",
    },
    {
      path: 'packages/ui/src/components/Bad.module.css',
      source: '.layout { opacity: 0; filter: blur(2px); transform: scale(2); appearance: none; letter-spacing: 1em; all: unset; }',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), ['canonical-control-visual-override'])
})

test('cannot hide control visuals behind comments, property case, or CSS nesting', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import styles from './Bad.module.css'\nexport const Bad = () => <Button className={styles.layout}>Go</Button>",
    },
    {
      path: 'packages/ui/src/components/Bad.module.css',
      source: '.layout { /* visually hidden */ OPACITY: 0; &:hover { filter: blur(2px); } }',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), ['canonical-control-visual-override'])
  assert.match(findings[0].detail, /opacity: 0/)
  assert.match(findings[0].detail, /filter: blur\(2px\)/)
})

test('cannot hide control visuals in nested conditional at-rules', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/Bad.tsx',
      source: "import styles from './Bad.module.css'\nexport const Bad = () => <Button className={styles.layout}>Go</Button>",
    },
    {
      path: 'packages/ui/src/components/Bad.module.css',
      source: '.layout { @media (hover: hover) { opacity: 0; } @supports (backdrop-filter: blur(1px)) { filter: blur(2px); } }',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), ['canonical-control-visual-override'])
  assert.match(findings[0].detail, /opacity: 0/)
  assert.match(findings[0].detail, /filter: blur\(2px\)/)
})

test('rejects hand-rolled feature overlays and portal engines', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/components/NewSurface.tsx',
      source: 'const view = <div role="dialog">Unsafe</div>\ncreatePortal(view, document.body)',
    },
  ])
  assert.deepEqual(findings.map((finding) => finding.rule), [
    'screen-owned-overlay',
    'screen-owned-overlay',
  ])
})

test('does not let global app styles bypass the private token boundary', () => {
  const findings = scanUiArchitecture([
    {
      path: 'packages/ui/src/styles/app.css',
      source: 'body { --hdp-screen-copy: red; color: var(--hdp-alias-label-primary); }',
    },
  ])
  assert.equal(findings[0]?.rule, 'private-platform-token')
})
