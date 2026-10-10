import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(path.resolve('packages/ui/package.json'))
const ts = require('typescript')
const files = [
  'components/AgentFields.tsx', 'components/AgentPage.tsx', 'components/Archive.tsx',
  'components/History.tsx', 'components/ShapeEditor.tsx', 'components/ShapeStep.tsx',
  'components/SideBySide.tsx', 'design/patterns/SettingsRowMenu.tsx',
]
const valueOf = (node, source) => ts.isJsxExpression(node) ? node.expression?.getText(source) : ts.isJsxText(node) ? JSON.stringify(node.text.replace(/\s+/g, ' ').trim()) : node.getText(source)
for (const relative of files) {
  const file = path.join('packages/ui/src', relative)
  const input = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = []
  const visit = node => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'DropdownMenuItem') {
      const attrs = node.openingElement.attributes.properties.map(p => p.getText(source)).join(' ')
      if (/\b(?:className|style|inset)=/.test(attrs)) throw new Error(`${relative}: styled item needs explicit data migration`)
      const children = node.children.filter(c => !ts.isJsxText(c) || c.text.trim())
      const leading = children[0]
      const icon = leading && ts.isJsxSelfClosingElement(leading) && /Icon$/.test(leading.tagName.getText(source)) ? leading : null
      const labels = children.slice(icon ? 1 : 0).map(c => valueOf(c, source)).filter(Boolean)
      if (labels.length === 0) throw new Error(`${relative}: empty item`)
      const label = labels.length === 1 ? labels[0] : `<>${children.slice(icon ? 1 : 0).map(c => c.getText(source)).join('')}</>`
      edits.push({ start: node.getStart(source), end: node.end, text: `<DropdownMenuItem ${attrs} label={${label}}${icon ? ` icon={${icon.getText(source)}}` : ''} />` })
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let output = input
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  fs.writeFileSync(file, output)
  process.stdout.write(`${relative}: ${edits.length} items converted\n`)
}

const rootFiles = [
  'components/Conversation.tsx', 'components/Composer.tsx', 'components/ComposerControls.tsx',
  'components/SessionTree.tsx', 'components/BrowserPane.tsx', 'components/WorkspaceMenu.tsx',
  'components/AgentFields.tsx', 'components/AgentPage.tsx', 'components/ShapeEditor.tsx',
  'components/ShapeStep.tsx', 'components/Archive.tsx', 'components/History.tsx',
  'components/SideBySide.tsx', 'components/RoomComposer.tsx', 'components/RoomComposerOptions.tsx',
  'components/Library.tsx', 'components/TeamBoardList.tsx', 'components/TeamBoardPane.tsx',
  'components/TeamsWindow.tsx', 'components/usage/shared.tsx', 'components/GitPane.tsx',
  'design/patterns/SettingsRowMenu.tsx', 'design/patterns/SeatList.tsx',
  'design/patterns/TopBar.tsx', 'design/primitives/Banner.tsx', 'design/patterns/Notices.tsx',
]
const roots = new Set(['Popover', 'ContextMenu', 'Submenu', 'DropdownMenu'])
for (const relative of rootFiles) {
  const file = path.join('packages/ui/src', relative)
  const input = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = []
  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source)
      if (roots.has(tag)) {
        const get = name => node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === name)
        // Composer Add is already migrated with a complete icon column.
        const icons = relative === 'components/Composer.tsx' ? 'all' : 'none'
        const currentWide = get('wide') || get('panelWidth')?.initializer?.getText(source) === '"wide"'
        const wide = tag === 'Submenu' || Boolean(currentWide) ||
          relative === 'components/ComposerControls.tsx' ||
          relative === 'components/AgentFields.tsx' || relative === 'components/ShapeStep.tsx'
        // Change only the popup attributes; leave opening-tag formatting and callbacks intact.
        const iconAttr = get('icons')
        if (iconAttr) {
          if (iconAttr.initializer?.getText(source) !== JSON.stringify(icons)) edits.push({ start: iconAttr.getStart(source), end: iconAttr.end, text: `icons="${icons}"` })
        } else edits.push({ start: node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1), end: node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1), text: ` icons="${icons}"` })
        const oldWidth = get('width')
        if (oldWidth) edits.push({ start: oldWidth.getStart(source), end: oldWidth.end, text: '' })
        if (wide) {
          const name = tag === 'Popover' ? 'panelWidth' : 'wide'
          const attr = get(name)
          const text = tag === 'Popover' ? 'panelWidth="wide"' : 'wide'
          if (attr) { if (attr.getText(source) !== text) edits.push({ start: attr.getStart(source), end: attr.end, text }) }
          else edits.push({ start: node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1), end: node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1), text: ` ${text}` })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let output = input
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  fs.writeFileSync(file, output)
}

const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)])
const old = walk('packages/ui/src').filter(file => /\.(?:tsx|ts|css)$/.test(file) && /\bPopoverOption(?:Mark|Body|Label|Hint|Live)?\b/.test(fs.readFileSync(file, 'utf8')))
if (old.length) throw new Error(`Retired option family remains: ${old.join(', ')}`)
