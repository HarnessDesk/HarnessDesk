import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every place the source draws someone, held to one rule.
 *
 * A face is someone (an agent at work, a person) and takes its corner from
 * `--hd-face-radius`, so a person who chooses round faces gets round faces
 * everywhere (`docs/design.md` § "Shapes say what a mark is"). What kept that
 * true was review, and review kept finding one more place that drew an agent in
 * a fixed corner: the side-by-side tile, a board's assignees, the Agents
 * panel's rows, a notice's face, the Activity panel's rows.
 *
 * This reads the whole UI source, so it reaches the screens a browser page
 * cannot mount (the Agents panel only draws a row once a session has
 * delegated). Three things are refused:
 *
 *   An `IconTile` that holds an agent's mark (`BrandMark`, `RuntimeMark`,
 *   `AgentIcon`) and is not a `face`: a `square` or `round` tile does not
 *   follow the setting, so it would be the one face that ignores it.
 *
 *   An `AvatarStack` that is not a face. Its members are someone.
 *
 *   An `IconTile` whose shape is decided at run time. A mark can arrive
 *   through a prop (`AgentCard`'s `subject.mark`), which this cannot see
 *   inside, so a shape it cannot read has to be named; the entry says what
 *   pins it instead.
 *
 * What it does not see: a mark passed in a prop to a tile whose shape is a
 * literal that is not `face`. The browser half finds that one if the screen is
 * mounted.
 *
 * The browser half is `e2e/ui-system/faces.spec.ts`: it measures what the
 * mounted faces compute under each setting, and finds a face this scan cannot,
 * because it was drawn without an `IconTile` (and declares itself with
 * `data-shape`).
 *
 * An entry in the exception list is a claim that what the tile holds is not
 * someone, or that another test pins its shape, and it names why. An entry that
 * matches nothing fails, so the list cannot outlive the thing it excuses.
 */
const AGENT_MARKS = new Set(['BrandMark', 'RuntimeMark', 'AgentIcon'])

type Finding = { readonly file: string; readonly line: number; readonly tag: string; readonly shape: string }

const tagName = (node: ts.JsxElement | ts.JsxSelfClosingElement): string =>
  (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText()

const attributesOf = (node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes =>
  (ts.isJsxElement(node) ? node.openingElement : node).attributes

/**
 * What shape a tile says it is, as the set of shapes it can take: a literal is
 * one, a conditional of two literals is both, anything else is `dynamic` (and
 * so has to be named).
 */
const shapeOf = (node: ts.JsxElement | ts.JsxSelfClosingElement, fallback: string): string => {
  const attribute = attributesOf(node).properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === 'shape',
  )
  if (!attribute) return fallback
  const initializer = attribute.initializer
  if (initializer && ts.isStringLiteral(initializer)) return initializer.text
  const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined
  if (expression && ts.isStringLiteralLike(expression)) return expression.text
  if (expression && ts.isConditionalExpression(expression)
    && ts.isStringLiteralLike(expression.whenTrue) && ts.isStringLiteralLike(expression.whenFalse)) {
    return [expression.whenTrue.text, expression.whenFalse.text].sort().join('|')
  }
  return 'dynamic'
}

const holdsAgentMark = (node: ts.Node): boolean => {
  let found = false
  const visit = (child: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) && AGENT_MARKS.has(child.tagName.getText())) found = true
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

/** The tiles in `source` that draw someone in a shape that is not a face. */
const scanFaces = (file: string, source: string): Finding[] => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Finding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagName(node)
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      if (tag === 'IconTile') {
        const shape = shapeOf(node, 'square')
        // An agent's mark in a tile that is not a face, or a shape this cannot
        // read at all: what such a tile holds may arrive through a prop.
        if ((holdsAgentMark(node) && shape !== 'face') || shape === 'dynamic') found.push({ file, line, tag, shape })
      }
      if (tag === 'AvatarStack') {
        const shape = shapeOf(node, 'face')
        if (shape !== 'face') found.push({ file, line, tag, shape })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/**
 * Tiles that hold an agent's mark and are deliberately not a face. Keyed by the
 * file and the shape the tile can take; each says why it is not someone.
 */
const NOT_SOMEONE: readonly { readonly file: string; readonly shape: string; readonly why: string }[] = [
  {
    file: 'components/SetupDesk.tsx',
    shape: 'square',
    why: 'a harness the desk found on this Mac is a thing, so it is a square: a face is an agent at work, and nothing here is working yet',
  },
  {
    file: 'design/patterns/AgentCard.tsx',
    shape: 'dynamic',
    why: 'the crest follows what its subject is (a harness a square, an account a ring, a session or a member a face), and its mark arrives as a prop; AgentCard.test.tsx pins the shape of each kind',
  },
  {
    file: 'components/Activity.tsx',
    shape: 'face|square',
    why: 'a row whose agent is known wears its mark as a face; the square branch is an event\'s own glyph, which is not someone',
  },
]

/* Every `.tsx` the app ships, as text: Vite reads them, so this needs no
   filesystem and cannot drift from what the build sees. Tests are not shipped,
   and the preview harness and the design catalogue are not the app: the
   catalogue draws every shape on purpose, to show what each one means. */
const SOURCES = import.meta.glob<string>(
  ['../**/*.tsx', '!../**/*.test.tsx', '!../preview/**', '!../design/explorer/**', '!../design/showcase/**'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
)

/** A glob key (relative to this file's folder) as a path under `src/`. */
const fromSrc = (key: string): string => new URL(key, 'file:///src/design/').pathname.replace(/^\/src\//, '')

describe('faces: every tile that draws someone is a face', () => {
  const findings = Object.entries(SOURCES).flatMap(([path, source]) =>
    scanFaces(fromSrc(path), source),
  )
  const excused = (finding: Finding) =>
    NOT_SOMEONE.some((entry) => entry.file === finding.file && entry.shape === finding.shape)

  it('draws no agent in a fixed shape, outside the named exceptions', () => {
    expect(findings.filter((finding) => !excused(finding))).toEqual([])
  })

  it('keeps no exception that excuses nothing', () => {
    const stale = NOT_SOMEONE.filter(
      (entry) => !findings.some((finding) => finding.file === entry.file && finding.shape === entry.shape),
    )
    expect(stale).toEqual([])
  })

  // A check needs a control that could fail (a scan that finds nothing passes
  // by default): each shape the rule refuses, and the ones it allows.
  it('refuses an agent mark in a tile that is not a face', () => {
    const square = scanFaces('x.tsx', 'const a = <IconTile><BrandMark brand="codex" /></IconTile>')
    const round = scanFaces('x.tsx', 'const a = <IconTile shape="round"><AgentIcon /></IconTile>')
    const unknown = scanFaces('x.tsx', 'const a = <IconTile shape={shape}><RuntimeMark runtime={r} /></IconTile>')
    expect([square[0]?.shape, round[0]?.shape, unknown[0]?.shape]).toEqual(['square', 'round', 'dynamic'])
  })

  it('refuses a tile whose shape is decided at run time unless it is named, whatever it holds', () => {
    // A mark can arrive through a prop (`AgentCard`'s `subject.mark`), which the
    // scan cannot see inside; a shape it cannot read is therefore the thing to name.
    const prop = scanFaces('x.tsx', 'const a = <IconTile shape={SHAPES[kind]}>{subject.mark}</IconTile>')
    expect(prop.map((finding) => finding.shape)).toEqual(['dynamic'])
    expect(scanFaces('x.tsx', 'const a = <IconTile shape="face">{subject.mark}</IconTile>')).toEqual([])
  })

  it('refuses an AvatarStack that is not a face', () => {
    expect(scanFaces('x.tsx', 'const a = <AvatarStack members={m} shape="round" />')).toHaveLength(1)
    expect(scanFaces('x.tsx', 'const a = <AvatarStack members={m} shape="square" />')).toHaveLength(1)
  })

  it('allows a face, a default AvatarStack, and a tile that holds no agent', () => {
    expect(scanFaces('x.tsx', 'const a = <IconTile shape="face"><BrandMark brand="codex" /></IconTile>')).toEqual([])
    expect(scanFaces('x.tsx', 'const a = <AvatarStack members={m} />')).toEqual([])
    expect(scanFaces('x.tsx', 'const a = <IconTile shape="round"><AlertIcon /></IconTile>')).toEqual([])
  })

  it('reads the whole UI source, not a sample', () => {
    // The scan must reach the places the issue was found in.
    const reached = new Set(findings.map((finding) => finding.file))
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100)
    expect(reached.has('components/SetupDesk.tsx')).toBe(true)
  })
})
