# PR 748: sidebar and layout repair evidence

Product source: fba694c269e8cc721207df5576f43e2ecc12c446.
Original comparison source: 9f2d6dec (before the UI migration).
Before comparison source: 285e7d52. The Dashboard before capture includes the footer-only repair, not the Dashboard or segmented-control repair.

58 selected, personally inspected images. Each PNG has an adjacent computed-style metrics JSON. All frames are 1440 by 900 CSS pixels at 2x. Geist is the interface font, with the normal system fallbacks. Measurements are CSS pixels.

The after directory contains the current Settings destinations, Dashboard, footer open/expanded states, and actual workspace/session hover states in both themes. They are built Electron captures; the supplementary Settings and hover sweep used the locally packaged macOS arm64 app. The original/before builds used the same synthetic content and driver. Time labels and runtime catalogs can differ as fixture metadata.

Only the project's public demo identities and invented repositories are shown. No user-supplied desktop screenshot is included. A separate candidate native sweep was rejected because its history list picked up local metadata; those candidate conversation/Git/editor images are NOT in this set. The screenshot-rig isolation follow-up is tracked separately in the PR.

## Reading the comparisons

- Footer: 232x36 originally, 181.34x36 broken, 232x36 repaired. The full-width trigger returns to 4px side insets within a 240px sidebar. Name remains 14px / 21px, weight 500. Avatar and agent badge stay 24px; agent glyph 13px; status dot 6px; gap 8px.
- Footer popup: original 228x304 with 12px-offset/32px-blur/22%-black shadow. Broken outer popup was 180x8 around an independently positioned 160x305 inner panel. Repaired single popup is 288.84x305 with 8px-offset/28px-blur/18%-black shadow and one inset hairline; radius 10px and padding 4px. Its greater content-driven width accommodates account labels. The concrete fix is one positioned, hittable surface, not a claim that lighter shadows are always better.
- Dashboard account row: 219x34 originally, 219x16 broken, 219x30 repaired for the first metered row. Original 14px regular / 21px line-height; migrated/repaired 13px medium / 13px line-height. Repair restores 4px vertical / 8px horizontal padding and a 4px row gap. Cards still use the 1120px maximum and auto-fill minimum 320px columns; at this viewport both original and repaired render three 365.33px columns with 12px gaps. First card height moves 315 to 322 as padding moves 14px 15px 11px to 16px 16px 12px; body 14px / 21px and heading 20px / 26px remain. No card shadow is added.
- Permissions: use intrinsic segment width instead of equal-width shrinking. Repaired Desk labels are 12px medium / 18px, height 26px, 12px horizontal padding. You / Automatic review / Guardian sub-agent are 44.27 / 121.41 / 135.09px wide. Selected segment retains the small 0 1px 2px 8%-black shadow; there is no new panel elevation.
- Workspace/session hover: reserve a right-hand action area in the row layout so pin/count/worktree/deleted-folder marks do not sit under the action buttons. Workspace/session label sizes remain 13px/14px. The pin is a status indicator; Pin/Unpin is operated through Actions. Long titles have slightly less width, an explicit tradeoff for independent visible controls.
- Library versus Plugins: the original already selected the wide page contract only for Library (1120px maximum), while Plugins used the standard 780px maximum. This width difference is inherited, not introduced or changed by this repair.

The PR body contains inline old/before/after previews and separate per-surface explanations. Earlier evidence commits remain available for the preceding migration repair and unaffected pages. Neither these frames nor passing tests claim real-vendor sign-in/execution or a human VoiceOver session.

