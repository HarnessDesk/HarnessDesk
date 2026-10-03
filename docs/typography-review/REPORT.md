# Typography review — 2026-10-02

Read [the three maps side by side](comparison.html) first, then the five-area table below. [The ruled word](ruled-light.png) makes size and weight easier to judge without the screen around them. [Native trim results](text-box-trim.md) are a separate decision.

I recommend keeping navigable lists at **13/400**, body and composer text at **14/400**, and trying **14/500 for names inside content**, including chat senders and inline MemberName. Keep page/section headings and readout roles unchanged. No product code changes in this branch; all alternatives are injected styles on fixture screens.

The app is not switching its Latin font between those places. It is changing size and weight within Geist. Whether that contrast *feels* like a font change is a visual judgement; the metrics do not prove a reader’s perception. In the exported frames I find the lighter sender easier to read beside the quiet rail, while the face and position still identify the speaker. This is a recommendation for the owner, not a settled new rule.

## Five areas first

| Area | Current size/weight | Line | x height | Treatment |
|---|---|---|---|---|
| sidebar | 13/400 | 20px | 6.89px | navigation |
| rail | 13/400 | 20px | 6.89px | unnamed |
| sender | 14/600 | 20px | 7.476px | member |
| body | 14/400 | 20px | 7.42px | unnamed |
| composer | 14/400 | 20px | 7.42px | unnamed |

These are from `composed-real-screens` in [font-switch.json](font-switch.json), in both themes. The source screens are `sidebar-column`, `goal-roster` and `conversation-composer`. The room was populated using the existing `TEAM.channel` fixture so its sender/body could actually be compared. Original empty-room measurements remain in [samples.json](samples.json).

Rail → sender is **+1px, +200 weight and 1.085× x height**. Sender and body have the same 14px size and 20px line; their x heights differ by 0.056px. The same size split is used by the composer. The recommended 500 sender reduces the weight jump to +100; the ruled specimens and recommendation images show the choice. These deltas compare roles; [font-switch.md](font-switch.md) also records which actual boxes are adjacent within 24px.

## What is inconsistent

- **The same agent name has different weights inside content.** `Alpha` and `Beta` are 14/500 subjects in `dashboard-overview`, 14/600 members in `goal-roster`’s inline status and `coverage-notice-room-board`’s chat; they are also 13/500 row names in `side-by-side-two`/`side-by-side-four`. The source roles explain those numbers, but “a person beside its face” does not currently get one treatment everywhere. Aligning content names at 500 would reduce this particular difference. Lists can retain their smaller navigation role because they serve a different reading task.
- **The rail still has no declared title role on this head.** `goal-roster`’s `list-row-title` computes 13/400, but is unnamed. #1231 would declare navigation without changing pixels; these measurements support that structural declaration independently of the owner’s choice about #1220. The issue’s old 13/500 description is not today’s computed result.
- **The written rule contradicts the rendered role map.** `docs/design.md`’s Weight paragraph says 600 is reserved for the app/page name; its Named text roles/Names paragraphs and `Settings.tsx` also use 600 for section/member. `goal-roster`, `board:channel` and `dashboard-overview` expose this difference. It also still lists 18px/21px line pairs; current Desk tokens and the five-area measurement use 20px for both 13px and 14px. This report leaves those product guidelines unchanged for the owner’s decision.
- **“Unnamed” is a coverage gap, not a defect verdict.** The audit flags every text owner without an explicit role or an unambiguous role-class match. Buttons, chips, code, row anatomy and board explanations often have their own primitive contract. A role is never guessed from a matching size/weight pair or from the words. `board:button`, `board:row`, `goal-roster`, and `conversation-composer` are examples. Full paths and every flagged frame are in [flags.json](flags.json).
- **Off-scale values have identifiable causes.** 12.25px inline code in `conversation-composer` is Markdown’s 0.875em of 14px. 21px headings in `library-option-e`/`library-option-e-applied` are Markdown’s document scale. 12.88px in `board:tool-pane` is the named 0.92em inline-code token. Record these exceptions; do not call the whole count accidental size drift. [source-type.txt](source-type.txt) finds the explicit Markdown ratio; the strict audit reports rawType=0. It also prints 21 existing single-area primitive advisories, without failing strict mode.

[Per-area tables](area-tables.md) cover sidebar lists, Team rail, chat, composer, menus, Settings, dashboard, dialogs, right panel and other boards/frames. [Flags and component families](flags.md) list the multiple size/weight clusters, with every frame id for each treatment. [Literal name weights](name-weights.md) separately lists every exact-name candidate measured at both 500 and 600. The full JSON includes paths and examples; read a family as a review queue, not as proof that a button, heading and readout should share one pair.

## One map and two alternatives

| Role/use | Recommendation | Keep today | Promote rail members |
|---|---|---|---|
| Sidebar/navigation names | 13/400 | 13/400 | 13/400 |
| Team rail member names | 13/400 | 13/400 | 14/600 |
| Content person/agent names (`member`) | 14/500 | 14/600 | 14/600 |
| Content subject names | 14/500 | 14/500 | 14/500 |
| Body/composer | 14/400 | 14/400 | 14/400 |
| Group labels | 13/400 secondary | same | same |
| Meta | 12/400 muted | same | same |
| Buttons/row labels | existing 13/500, small 12/500 | same | same |
| Section/page/wordmark | 16/600, 20/600, 20/600 | same | same |
| Figure/metric/value | existing 36/600, 16/600, 14/400 | same | same |

Only `member` changes in the recommended injection. Only Team member rows change in the heavier-rail alternative; Board/Chat/Findings navigation stays quiet. Every map keeps the current Desk line tokens and font family. No font fallback or trim proposal is applied to these A/B frames.

| Theme | Current / keep today | Recommendation | Promote rail members |
|---|---|---|---|
| Light | [current](current-light.png) | [recommended](recommendation-light.png) | [rail alternative](alternative-light.png) |
| Dark | [current](current-dark.png) | [recommended](recommendation-dark.png) | [rail alternative](alternative-dark.png) |

The local comparison HTML is the private offline Artifact, with theme and zoom controls; it makes no network requests. Its branch copy contains only the same fixture frames required by the brief. No external Artifact service or Page was selected.

## Five decisions for the owner

1. **Keep the lists 13/400, or give Team member rows 14/600?** The current sidebar and rail have the same 13/400/20px treatment; senders have 14/600/20px and 1.085× x height. See the three composed maps above. I favour retaining navigation size/weight, keeping the chrome/content distinction. The family string is the same; perception remains yours to judge.
2. **Is a content name 600 or 500?** `Alpha` is already 14/500 in dashboard content, 14/600 in inline room status, and 13/500 on a tile’s header. The recommendation brings content names nearer the subject treatment; the ruled image includes all six 13/14 × 400/500/600 combinations. I favour 500 for content names, subject to the owner’s reading of the frames.
3. **Exactly two running sizes, with 12 for meta only?** The five main areas do use 13px chrome and 14px reading text. Current small buttons/chips also use 12px, so “meta only” would change existing control proportions; headings and readouts still need their named larger roles. I favour two *default* running sizes, with 12px for compact facts **and existing compact controls**, plus the explicit heading/readout/document exceptions.
4. **Trim all roles and controls, or only measured imbalances?** Electron 42.11.8 / Chromium 148.0.7778.280 supports both properties. 81 sampled control boxes did not shrink, but the specimen Text boxes lost roughly 5–14px and multilingual Inputs show clipped glyphs after the blanket injection. The cap-gap proxy is about 0.23px for 13px Text and 1.02px for the 12px Chip; inputs have no Range-derived gap. I favour a targeted inner-label experiment, preserving outer height and current spacing, after CJK/fallback proof. See [native before/after](text-box-trim.md); the tested blanket rule does **not** meet acceptance.
5. **Explicit Japanese/Korean stack entries or platform fallback?** CDP reports Japanese using Hiragino Sans GB for five glyphs and PingFang SC for two; Korean uses Apple SD Gothic Neo for seven, plus Geist for the space. Emoji uses Apple Color Emoji and some SF NS fallback. I favour a later language-aware Japanese stack proposal, leaving Korean’s working macOS fallback in place until cross-platform evidence exists. Simply appending font names to the present Chinese-first fallback order is not validated by this audit. Windows and other systems were not measured.

## Scope and reproduction

Measured base: `ccc4e99a5c0e403ce1b14fe87f727f9be5ee11d1`. Desk interface, default foundation, 1440×900 browser viewport, light/dark. All 308 frame/theme observations are listed in [coverage.json](coverage.json); there are 99 preview frame ids and 55 catalogue board ids. The four dial-gated literal frames are included. There is no Team Overview screen on this source head; the future Table-based Overview is not represented as if it had landed.

The audit records 15,276 direct-text/form owners. Hidden/aria-hidden/screen-reader-only nodes and preview captions are excluded. Scrolled/off-viewport mounted text is retained; this is coverage of mounted specimens, not a claim that every row appears in the exported screenshot. Form values/placeholders are supplemental because input text is not a DOM text node. Paths are frame-scoped data-slot/data-region chains with sibling ordinals, diagnostic paths rather than executable CSS selectors. All samples include computed size, weight, line, tracking, family, colour, resolved ink tokens and role provenance. Ambiguous reverse matches stay unnamed. Every area table is grouped by size/weight/line/ink, split by theme.

The collector mutates a known navigation element to 15px/600 and proves it records the off-scale size and changed weight. It never guesses that a matching numeric pair implies a role. An owner can reproduce two frames without overwriting the full census:

```sh
TYPE_AUDIT=1 pnpm exec playwright test -c playwright.ui-system.config.ts typography-audit.spec.ts
TYPE_AUDIT=1 TYPE_AUDIT_FRAMES=sidebar-column,goal-roster pnpm exec playwright test -c playwright.ui-system.config.ts typography-audit.spec.ts
```

Outputs are written to `output/typography/`. This folder’s JSON/Markdown/images are copied from that run. [spot-comparison.json](spot-comparison.json) records the independent two-frame rerun comparison. The private failed-run traces/logs are not published: they contain fixture developer-path diagnostics. Published sample path text uses a synthetic user segment; the numeric measurements are untouched.

Native trim evidence is a fixture-loaded real Electron renderer, with actual platform fonts read over CDP. It is not a whole app interaction test, a raster glyph-gap study or a Windows/Japanese usability study. All exported frames were opened and inspected; they contain placeholder agents and the project’s permitted public demo persona, never a real desk.

`pnpm verify` ran unpiped and printed **All checks passed.** The final opt-in audit and two-frame comparison results are recorded in [validation.json](validation.json). Briefs 2/3 and the vertical-centering backlog remain queued: no composer-notice, census baseline or product typography change belongs to this report branch. #1231/#1220 still need the owner’s typography decision.

[MANIFEST.md](MANIFEST.md) lists every handoff file. The detailed brief says push `typography-review` and never open a PR; that specific rule controls this branch, despite the board’s generic PR boilerplate. The report is for review and an owner decision, not a product change to merge.
