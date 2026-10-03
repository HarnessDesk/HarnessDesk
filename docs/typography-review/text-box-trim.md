# Text-box-trim in the native renderer

Environment: **real Electron app renderer, fixture preview loaded into its window**. Electron 42.11.8; Chromium 148.0.7778.280. The app launched from packages/desktop with a debugger and a temporary user-data directory, isolated HARNESSDESK_HOME/CODEX_HOME, mock Keychain and the fake-agent binary. The real app’s window then loaded the fixture catalogue. This is native engine evidence over real design components; it is not a full app workflow or a Windows test.

Both feature checks returned true: trim-both=True; cap alphabetic=True. A later implementation must still use CSS feature detection and retain today’s layout when unsupported.

## Fonts actually used

| Sample | Platform fonts reported by CDP |
|---|---|
| latin | Geist-Regular (16 glyphs) |
| chinese | PingFangSC-Regular (5 glyphs) |
| japanese | HiraginoSansGB-W3 (5 glyphs), PingFangSC-Regular (2 glyphs) |
| korean | Geist-Regular (1 glyphs), AppleSDGothicNeo-Regular (7 glyphs) |
| fallback | .SFNS-Regular_wdth_opsz110000_GRAD_wght (2 glyphs), Geist-Regular (9 glyphs), AppleColorEmoji (2 glyphs) |

Japanese mixes Hiragino Sans GB and PingFang SC on this Mac. Korean already resolves to Apple SD Gothic Neo. Emoji also uses Apple Color Emoji, with SF NS for two fallback glyphs. A computed font-family string alone would have hidden those differences.

## Bordered controls

81 sampled control boxes: 0 shrank. This includes catalogue chrome as well as the explicit multilingual specimen. The specimen covers three Button sizes, Chip, two Tabs triggers, and default/compact/row Input.

| Slot | Before heights | Height deltas | Count |
|---|---|---|---:|
| button | 24, 28, 30, 42, 44, 45, 59, 66, 67, 67.5px | 0px | 74 |
| chip | 22px | 0px | 1 |
| tabs-trigger | 23px | 0px | 2 |
| input | 24, 30px | 0px | 4 |

## Text roles and cap-gap proxy

| Role | Before height | After delta | Cap-gap imbalance before → after |
|---|---:|---:|---|
| navigation | 20px | -10.773px | -0.23 → -0.003px |
| row | 20px | -10.773px | -0.23 → -0.003px |
| member | 20px | -10.062px | 0.06 → -0.002px |
| meta | 16px | -7.477px | -1.02 → -0.497px |
| prose | 20px | -10.062px | 0.06 → -0.002px |

This is a geometric proxy: baseline is estimated from Range rectangles and canvas font ascent/descent; cap and x metrics are measured separately. It is not pixel segmentation or a proof of unclipped CJK. Inputs have no text Range, so their gap values are null. Text roles in mixed-script strings use Latin cap metrics even when fallback glyphs exceed that box.

## Recommendation

Do not ship this blanket injection. Outer control heights remain intact, but the natural Text boxes shrink substantially (13px navigation: 20px → approximately 9.23px; 14px member: 20px → approximately 9.94px). The multilingual Inputs visibly cut glyphs in trim-controls-after.png, while the before image keeps them whole. A fixed outer box alone does not satisfy the acceptance condition.

Keep current rhythm; investigate trimming an inner Latin label where a measured error warrants it, preserve the control’s outer height, and explicitly test CJK/fallback text. Use an @supports guard; document the exact rule and update boards in that later PR. The present proxy sees approximately 0.23px imbalance for 13px Text and 1.02px for the 12px Chip, not enough evidence for a system-wide density change.

[Before controls](trim-controls-before.png) · [After controls](trim-controls-after.png) · [Before language sample](trim-before.png) · [After language sample](trim-after.png)

## Execution limits

The first Playwright Electron launch stalled and exceeded 180s; a second inspector helper had an unbounded WebSocket handshake. Those attempts were stopped. A later repeated run stalled waiting for native page navigation and exceeded 180s; its three browser checks passed, but that full run failed. A subsequent focused native run passed in 8.6s. The instrument now bounds navigation, waits for DOM content plus actual fonts/specimens, and interrupts its owned child before disconnecting the browser. Native launch/navigation remains an environment-sensitive part of reproduction. The successful instrument launches Electron directly, bounds inspector/CDP startup, and uses CDP capture of measured rectangles to avoid animation-frame waits in occluded native windows. Those failures did not supply any numbers in this report. Native values above are from the successful saved run in text-box-trim.json.
