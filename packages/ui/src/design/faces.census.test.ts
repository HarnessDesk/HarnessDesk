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
 * someone, or that another test pins its shape, and it names why. It records
 * the tile's identity as well as its shape, so a different tile in the same
 * file needs its own entry. It also says how many matching tiles it excuses,
 * and fails when that count is wrong or below one, so the list cannot outlive
 * the thing it excuses.
 */
const AGENT_MARKS = new Set(['BrandMark', 'RuntimeMark', 'AgentIcon'])

type Finding = {
  readonly file: string
  readonly line: number
  readonly tag: string
  readonly shape: string
  readonly identity: string
}

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

/** What this tile holds, or the shape expression when its mark arrives by prop. */
const identityOf = (node: ts.JsxElement | ts.JsxSelfClosingElement): string => {
  const marks: string[] = []
  const visit = (child: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) && AGENT_MARKS.has(child.tagName.getText())) {
      marks.push(child.getText())
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  if (marks.length) return marks.join('|')

  const shape = attributesOf(node).properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === 'shape',
  )
  const initializer = shape?.initializer
  const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer
  return `${tagName(node)}:${expression?.getText() ?? 'default'}`
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
        if ((holdsAgentMark(node) && shape !== 'face') || shape === 'dynamic') {
          found.push({ file, line, tag, shape, identity: identityOf(node) })
        }
      }
      if (tag === 'AvatarStack') {
        const shape = shapeOf(node, 'face')
        if (shape !== 'face') found.push({ file, line, tag, shape, identity: identityOf(node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

type Exception = {
  readonly file: string
  readonly shape: string
  readonly identity: string
  readonly tiles: number
  readonly why: string
}

/**
 * Tiles that hold an agent's mark and are deliberately not a face. Keyed by the
 * file, the shape the tile can take, and what it holds (or its shape expression
 * when the mark arrives by prop), then by how many matching tiles it excuses (a
 * second one in the same file is a new claim, so it is a finding until named);
 * each says why it is not someone.
 */
const NOT_SOMEONE: readonly Exception[] = [
  {
    file: 'design/patterns/AgentCard.tsx',
    shape: 'dynamic',
    identity: 'IconTile:CREST_SHAPE[subject.kind]',
    tiles: 1,
    why: 'the crest follows what its subject is (a runtime, session or member a face, an account a ring), and its mark arrives as a prop; AgentCard.test.tsx pins the shape of each kind',
  },
  {
    file: 'components/Activity.tsx',
    shape: 'face|square',
    identity: '<RuntimeMark runtime={info} size={12} />',
    tiles: 1,
    why: 'a row whose agent is known wears its mark as a face; the square branch is an event\'s own glyph, which is not someone',
  },
]

/**
 * What no exception covers, and the exceptions whose count is not what the
 * source holds: each one excuses its own tiles in turn, so an extra tile in the
 * same file is unnamed, and an exception that excuses fewer than it says (or
 * none) is wrong.
 */
const settle = (findings: readonly Finding[], exceptions: readonly Exception[]) => {
  const used = new Map<Exception, number>()
  const unnamed: Finding[] = []
  for (const finding of findings) {
    const entry = exceptions.find(
      (one) => one.file === finding.file && one.shape === finding.shape && one.identity === finding.identity
        && (used.get(one) ?? 0) < one.tiles,
    )
    if (entry) used.set(entry, (used.get(entry) ?? 0) + 1)
    else unnamed.push(finding)
  }
  return {
    unnamed,
    wrong: exceptions.filter((entry) => entry.tiles < 1 || (used.get(entry) ?? 0) !== entry.tiles),
  }
}

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
  it('draws no agent in a fixed shape, outside the named exceptions', () => {
    expect(settle(findings, NOT_SOMEONE).unnamed).toEqual([])
  })

  it('keeps no exception that excuses nothing', () => {
    expect(settle(findings, NOT_SOMEONE).wrong).toEqual([])
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

  it('excuses exactly the tiles an exception names, and no others in its file', () => {
    const tile = (line: number): Finding => ({
      file: 'a.tsx', line, tag: 'IconTile', shape: 'dynamic', identity: 'IconTile:shape',
    })
    const entry: Exception = { file: 'a.tsx', shape: 'dynamic', identity: 'IconTile:shape', tiles: 1, why: 'x' }
    // One entry for one tile: a second dynamic tile in the same file is a finding, not a free pass.
    expect(settle([tile(3), tile(9)], [entry]).unnamed.map((finding) => finding.line)).toEqual([9])
    expect(settle([tile(3)], [entry])).toEqual({ unnamed: [], wrong: [] })
    // An entry that says two and finds one, or finds none, is out of date.
    expect(settle([tile(3)], [{ ...entry, tiles: 2 }]).wrong).toHaveLength(1)
    expect(settle([], [entry]).wrong).toHaveLength(1)
    // Zero cannot describe a useful claim, even if the scan found no tiles.
    expect(settle([], [{ ...entry, tiles: 0 }]).wrong).toHaveLength(1)
  })

  it('binds an exception to the tile it names, not another tile of the same shape', () => {
    const oldTile = {
      file: 'a.tsx',
      line: 3,
      tag: 'IconTile',
      shape: 'square',
      identity: '<BrandMark brand="codex" />',
    } as Finding
    const replacement = {
      ...oldTile,
      line: 7,
      identity: '<RuntimeMark runtime={runtime} />',
    }
    const entry = {
      file: 'a.tsx',
      shape: 'square',
      tiles: 1,
      identity: '<BrandMark brand="codex" />',
      why: 'x',
    } as Exception

    expect(settle([replacement], [entry]).unnamed).toEqual([replacement])
    expect(settle([replacement], [entry]).wrong).toEqual([entry])
  })

  it('records the mark a tile holds as its identity', () => {
    const finding = scanFaces(
      'a.tsx',
      'const a = <IconTile shape="square"><BrandMark brand="codex" /></IconTile>',
    )[0]
    expect(finding?.identity).toBe('<BrandMark brand="codex" />')
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
    const reached = new Set(Object.keys(SOURCES).map(path => path.replace('../', '')))
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100)
    expect([...reached].some(path => path.endsWith('components/SetupDesk.tsx'))).toBe(true)
  })
})
