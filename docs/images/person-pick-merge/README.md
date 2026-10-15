# Person comparison pick previews

Evidence for #1627 and PR #1679. Images live on
`fix/1627-person-pick-merge-frames`, separate from the code branch.

The headless preview uses synthetic Alpha/Beta attempts, placeholder revisions
and the existing comparison fixture. The chooser fixture declares the real
`merged` outcome and “Choose and merge an attempt” title. No agent or Git merge
runs during capture.

Before frames render `PersonStepDialog` and `ComparisonActions` from
`f30379ec0e904760b854eddddd77ae1090d0f85f`; after frames render
`0597b73fc5be62ce68414a4702090903071b64f8`. Both use the same current preview
shell and synthetic inputs, so this comparison isolates the changed components.
The viewport is 1280 × 900 at scale 1; comparison frames crop to the whole Team
pane. Both themes were checked for chooser actions, person attribution, browser
errors and publishable text/attributes, then every image was inspected.

| Surface | Before | After |
| --- | --- | --- |
| Chooser, light | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/chooser-before-light.png" width="360" alt="Light chooser before: repeated task titles and Record answer"> | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/chooser-after-light.png" width="360" alt="Light chooser after: Attempt A/B, Show diff, merge and manual verification actions"> |
| Chooser, dark | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/chooser-before-dark.png" width="360" alt="Dark chooser before"> | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/chooser-after-dark.png" width="360" alt="Dark chooser after"> |
| Person pick, light | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/comparison-before-light.png" width="360" alt="Light comparison before: The judge picked A"> | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/comparison-after-light.png" width="360" alt="Light comparison after: You picked A"> |
| Person pick, dark | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/comparison-before-dark.png" width="360" alt="Dark comparison before"> | <img src="https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/fix/1627-person-pick-merge-frames/docs/images/person-pick-merge/comparison-after-dark.png" width="360" alt="Dark comparison after"> |
