import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '@typescript/typescript6'

const retired = new Set(['PopoverOption', 'PopoverOptionMark', 'PopoverOptionBody', 'PopoverOptionLabel', 'PopoverOptionHint', 'PopoverOptionLive', 'PopoverMark', 'PopoverBody', 'PopoverLabel', 'PopoverHint', 'PopoverLive', 'PopoverContent'])
const rows = new Set(['MenuItem', 'MenuToggle', 'DropdownMenuItem'])
const plates = new Set(['Popover', 'PopoverSurface', 'InfoCard', 'HoverCardContent', 'WideMenu', 'Submenu', 'ContextMenu', 'DropdownMenuContent', 'DropdownMenuSubContent', 'SelectContent'])
export const popupContractFindings = (text, file) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings = []
  const bindings = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const entry of statement.importClause.namedBindings.elements) bindings.set(entry.name.text, entry.propertyName?.text ?? entry.name.text)
  }
  const report = (node, reason) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    findings.push(`${file}:${line}: ${reason}`)
  }
  const visit = node => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node
      const local = opening.tagName.getText(source)
      const tag = bindings.get(local) ?? local
      if (retired.has(tag)) report(node, `retired popup API ${tag}`)
      const attributes = opening.attributes.properties.filter(ts.isJsxAttribute)
      if (rows.has(tag) || plates.has(tag)) {
        for (const attribute of attributes) {
          const name = attribute.name.getText(source)
          if (['className', 'style', 'bleed', 'layout'].includes(name)) report(attribute, `popup ${tag} geometry must come from the design contract`)
        }
      }
      if (rows.has(tag) && ts.isJsxElement(node) && node.children.some(child => !ts.isJsxText(child) || child.text.trim())) report(node, `${tag} takes row data, not child anatomy`)
      if (tag === 'HoverCardContent' && ts.isJsxElement(node)) {
        const controls = new Set(['button', 'a', 'input', 'select', 'textarea', 'Button', 'MenuItem', 'MenuToggle', 'Switch', 'Segmented'])
        const findControls = child => {
          if (ts.isJsxElement(child) && controls.has(child.openingElement.tagName.getText(source)) || ts.isJsxSelfClosingElement(child) && controls.has(child.tagName.getText(source))) report(child, 'info cards contain facts only')
          ts.forEachChild(child, findControls)
        }
        node.children.forEach(findControls)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}
export const scanPopupContracts = root => {
  const base = path.join(root, 'packages/ui/src')
  const findings = []
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !file.includes(`${path.sep}design${path.sep}ui${path.sep}`)) {
        const relative = path.relative(root, file).split(path.sep).join('/')
        findings.push(...popupContractFindings(fs.readFileSync(file, 'utf8'), relative))
      }
    }
  }
  walk(base)
  return findings.sort()
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const findings = scanPopupContracts(root)
  if (findings.length) { process.stderr.write(`${findings.join('\n')}\n`); process.exitCode = 1 }
  else process.stdout.write('Popup caller contract: 0 violations\n')
}
