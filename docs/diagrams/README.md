# Diagrams

Source-of-truth JSON, and the self-contained HTML rendered from it.

Each diagram is a typed [Archify](https://github.com/tt-a1i/archify) IR
document (`*.architecture.json`) plus the single HTML file it renders to. The
JSON is what to edit and what a reviewer reads; the HTML is a build artifact
that happens to be committed, because it is self-contained and because the
alternative — a binary image — cannot be reviewed at all.

## What is here, and why there are three of them

| | |
| --- | --- |
| `*.architecture.json` | The source. Edit this; a reviewer reads this. |
| `*-light.png` / `*-dark.png` | What the docs embed, so a reader sees a diagram. |
| `*.html` | The interactive one — search, trace, present, export. |

The pictures and the page are both generated from the JSON, so none of them is
a second copy to keep in step: if two ever disagree it is because somebody
skipped a regenerate, which is louder and cheaper to fix than two
hand-maintained diagrams drifting apart. The one exception is seven lines of
the page's stylesheet, written by hand after rendering: [Regenerating](#regenerating)
says which, and a test fails when a regenerate takes them away.

Three exist because no one of them does the whole job. **GitHub renders a
committed `.html` as source, not as a page** — checked, not assumed, and the
`#gh-dark-mode-only` fallback that used to help has been removed from GitHub's
stylesheets entirely. So the HTML alone would be a link that opens seven
hundred kilobytes of markup at somebody who wanted a diagram. The PNGs are what
a reader actually sees, in the theme they are reading in; the HTML is what is
worth opening when a static picture is not enough.

## Regenerating

Archify is not a dependency of this repository — it is a standalone renderer
run once, by hand, when a diagram changes. Nothing here builds it, and `pnpm
verify` checks one thing about what it produces — the toolbar colours below.

```bash
git clone --depth 1 https://github.com/tt-a1i/archify.git /tmp/archify
node /tmp/archify/archify/bin/archify.mjs validate architecture \
  docs/diagrams/architecture.architecture.json --quality showcase
node /tmp/archify/archify/bin/archify.mjs deliver architecture \
  docs/diagrams/architecture.architecture.json docs/diagrams/architecture.html \
  --quality showcase
node script/diagram-export.mjs docs/diagrams/architecture.html
```

**Then put the toolbar colours back.** Archify's Signal Flow preset gives the
toolbar three of its five colours in the dark theme and none in the light one
(`archify/assets/template.html` upstream, at c1443b3), so under that preset the
toolbar fell back to the generic slate (#93). Both pages here carry the missing
declarations — `--toolbar-text` and `--toolbar-hover` in the dark block, all
five in the light one — added after rendering, and `deliver` rewrites the whole
stylesheet, so a regenerate drops them. `script/diagram-pages.test.mjs` fails
when it does: copy the two `[data-preset="signal-flow"]` blocks back from the
previous commit before committing the new page, or drop the patch once Archify
declares the colours itself.

`validate` is worth running on its own first: it checks that every label
actually fits inside its box at a legible size and that no edge label overlaps
a component, and it names the offender and suggests a fix. It caught four
overflowing sublabels and one collision in the first draft of this diagram.

Archify is MIT-licensed. Nothing from it is vendored here — only the JSON we
wrote and the HTML it produced.
