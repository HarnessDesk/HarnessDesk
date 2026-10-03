# CJK font measurement — 2026-10-03

Typography 5B, on macOS with Chromium 153.0.8010.12. Both the
catalogue's PageHead/DetailHead board and the preview's typography-cjk frame
mount the shared CjkSpecimen: real Text, Button, Chip and Input components.
No family or metric is overridden in the specimen. These are synthetic
fixtures, not a signed-in desk. This is browser rendering evidence; Windows
and the full native app were not measured.

For each language, the document lang and sample lang match. The collector
uses DOM.querySelector and CSS.getPlatformFontsForNode over CDP, with a
separate span for each glyph. Each returned glyphCount is 1. All four
surface/theme combinations agree, before and after; the table lists their
shared results. Latin stays Geist-Regular in every observation. The 14px,
400-weight, 20px reading role keeps the same computed metrics in all 16
before/after pairs. No size, weight, line or trim token changed.

| Language | Position | Glyph | Before: PostScript name | After: PostScript name |
| --- | ---: | --- | --- | --- |
| zh-Hans | 1 | 你 | PingFangSC-Regular | PingFangSC-Regular |
| zh-Hans | 2 | 好 | PingFangSC-Regular | PingFangSC-Regular |
| zh-Hans | 3 | ， | PingFangSC-Regular | PingFangSC-Regular |
| zh-Hans | 4 | 世 | PingFangSC-Regular | PingFangSC-Regular |
| zh-Hans | 5 | 界 | PingFangSC-Regular | PingFangSC-Regular |
| zh-Hant | 1 | 你 | PingFangSC-Regular | PingFangTC-Regular |
| zh-Hant | 2 | 好 | PingFangSC-Regular | PingFangTC-Regular |
| zh-Hant | 3 | ， | PingFangSC-Regular | PingFangTC-Regular |
| zh-Hant | 4 | 世 | PingFangSC-Regular | PingFangTC-Regular |
| zh-Hant | 5 | 界 | PingFangSC-Regular | PingFangTC-Regular |
| ja | 1 | こ | HiraginoSansGB-W3 | HiraginoSans-W3 |
| ja | 2 | ん | HiraginoSansGB-W3 | HiraginoSans-W3 |
| ja | 3 | に | HiraginoSansGB-W3 | HiraginoSans-W3 |
| ja | 4 | ち | HiraginoSansGB-W3 | HiraginoSans-W3 |
| ja | 5 | は | HiraginoSansGB-W3 | HiraginoSans-W3 |
| ja | 6 | 世 | PingFangSC-Regular | HiraginoSans-W3 |
| ja | 7 | 界 | PingFangSC-Regular | HiraginoSans-W3 |
| ko | 1 | 안 | AppleSDGothicNeo-Regular | AppleSDGothicNeo-Regular |
| ko | 2 | 녕 | AppleSDGothicNeo-Regular | AppleSDGothicNeo-Regular |
| ko | 3 | 하 | AppleSDGothicNeo-Regular | AppleSDGothicNeo-Regular |
| ko | 4 | 세 | AppleSDGothicNeo-Regular | AppleSDGothicNeo-Regular |
| ko | 5 | 요 | AppleSDGothicNeo-Regular | AppleSDGothicNeo-Regular |
| ko | 6 | space | Geist-Regular | Geist-Regular |
| ko | 7 | 세 | AppleSDGothicNeo-Regular | AppleSDGothicNeo-Regular |
| ko | 8 | 계 | AppleSDGothicNeo-Regular | AppleSDGothicNeo-Regular |

Japanese previously mixed Chinese faces; all seven glyphs now use Hiragino
Sans. Traditional Chinese now uses PingFang TC. Korean retains Apple SD
Gothic Neo for Hangul and Geist for its space. Computed lists also include
the owner's Windows and Noto faces; their availability and actual rendering
on Windows are unverified.

All 32 exported frames were opened and inspected, light and dark, before
and after, on both surfaces. The text and controls remain legible, with no
visible clipping or overlap. The [frames and raw CDP observations](https://github.com/HarnessDesk/HarnessDesk/tree/typography/cjk-language-stacks-frames/docs/images/typography-cjk)
are on the separate frame branch, under docs/images/typography-cjk/.
Files follow before-or-after–catalogue-or-preview–language–theme.png;
before.json and after.json carry every glyph, family, PostScript name,
glyph count and computed metric.

## Reproduce

Start Vite in this checkout, choosing a free loopback port:

```sh
pnpm --filter @harnessdesk/ui exec vite --host 127.0.0.1 --port 5837
CJK_ORIGIN=http://127.0.0.1:5837 node e2e/ui-system/cjk-font-evidence.mjs after
```

To collect before on the same specimen, restore the old --hd-font-family
literal from [the decision](../decisions.md#cjk-font-fallback-follows-the-document-language),
then run the collector with before instead of after. Restore the new token
before checking or committing. The collector writes only output/typography-cjk/.

The browser regression pins the full computed family order for default,
English, Simplified and Traditional Chinese, Japanese and Korean, including
regional subtags, in both themes. It also exercises the one-token rollback
and requires all four scripts in real controls on both surfaces.
