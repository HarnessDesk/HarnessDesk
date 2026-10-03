# Font-switch measurements

Baseline from a 1400px review grid in the 1440×900 browser viewport. Sidebar and the mounted Goal rail/chat are beside the existing conversation and its composer. The Goal receives the harness’s existing TEAM.channel entries; no transcript is invented. The same geometry is used for each injected map.

## Five areas first

| Area | Size | Weight | Line | Canvas x height | Declared role |
|---|---:|---:|---|---:|---|
| sidebar | 13 | 400 | 20px | 6.89px | navigation |
| rail | 13 | 400 | 20px | 6.89px | unnamed |
| sender | 14 | 600 | 20px | 7.476px | member |
| body | 14 | 400 | 20px | 7.42px | unnamed |
| composer | 14 | 400 | 20px | 7.42px | unnamed |

Font-family is identical across these five Latin samples. These are computed stack strings, not proof that all scripts use Geist. Native platform-font evidence is in text-box-trim.md.

## Reference comparisons

Pairs are in reading order; deltas are second minus first. An x-height ratio is second divided by first. Same cluster means overlapping row or column boxes with no more than 24px between them; a false value is retained, not inferred as an adjacent pair.

| Pair | Size delta | Weight delta | x ratio | Same cluster | Gaps x/y |
|---|---:|---:|---:|---|---|
| sidebar → rail | 0 | 0 | 1 | False | 206.109/141.5px |
| sidebar → sender | 1 | 200 | 1.085 | False | 467.109/0px |
| sidebar → body | 1 | 0 | 1.077 | False | 467.109/0px |
| sidebar → composer | 1 | 0 | 1.077 | False | 66.109/80.5px |
| rail → sender | 1 | 200 | 1.085 | False | 125/148px |
| rail → body | 1 | 0 | 1.077 | False | 125/106px |
| rail → composer | 1 | 0 | 1.077 | False | 108/37px |
| sender → body | 0 | -200 | 0.993 | True | 0/2px |
| sender → composer | 0 | -200 | 0.993 | False | 369/87px |
| body → composer | 0 | 0 | 1 | False | 369/45px |

## Every adjacent role pair

The full paths, text examples, deltas, ratios and geometry are in font-switch.json. This table groups the measured adjacent occurrences; unnamed is deliberately retained.

### light

| Roles | Size delta | Weight delta | x ratio range | Occurrences |
|---|---:|---:|---|---:|
| member → meta | -2 | -200 | 0.851–0.851 | 3 |
| member → unnamed | -2 | -200 | 0.851–0.851 | 1 |
| member → unnamed | -1 | -200 | 0.922–0.922 | 1 |
| member → unnamed | -1 | -100 | 0.925–0.925 | 1 |
| member → unnamed | 0 | -200 | 0.993–0.993 | 8 |
| meta → member | 2 | 200 | 1.175–1.175 | 3 |
| meta → unnamed | 0 | 0 | 1–1 | 7 |
| meta → unnamed | 0 | 100 | 1.004–1.004 | 1 |
| meta → unnamed | 1 | 0 | 1.083–1.083 | 3 |
| meta → unnamed | 1 | 100 | 1.087–1.087 | 1 |
| meta → unnamed | 2 | 0 | 1.167–1.167 | 5 |
| muted → prose | 1 | 0 | 1.077–1.077 | 3 |
| muted → prose | 1 | 200 | 1.085–1.085 | 2 |
| navigation → unnamed | 0 | 0 | 1–1 | 1 |
| navigation → unnamed | 1 | 0 | 1.077–1.077 | 1 |
| row → meta | -1 | -100 | 0.92–0.92 | 1 |
| subject → meta | -2 | -100 | 0.854–0.854 | 3 |
| subject → unnamed | -2 | -100 | 0.854–0.854 | 2 |
| subject → unnamed | -2 | 0 | 0.857–0.857 | 1 |
| subject → unnamed | -1 | -100 | 0.925–0.925 | 1 |
| unnamed → member | 0 | 200 | 1.008–1.008 | 5 |
| unnamed → member | 2 | 200 | 1.175–1.175 | 3 |
| unnamed → meta | -2 | 0 | 0.857–0.857 | 6 |
| unnamed → meta | -1 | 0 | 0.923–0.923 | 4 |
| unnamed → meta | 0 | -100 | 0.996–0.996 | 1 |
| unnamed → meta | 0 | 0 | 1–1 | 8 |
| unnamed → muted | 0 | 0 | 1–1 | 1 |
| unnamed → muted | 1 | 0 | 1.083–1.083 | 2 |
| unnamed → navigation | -1 | 0 | 0.929–0.929 | 1 |
| unnamed → navigation | 0 | 0 | 1–1 | 2 |
| unnamed → subject | 0 | 100 | 1.004–1.004 | 3 |
| wordmark → unnamed | -7 | -200 | 0.645–0.645 | 1 |

### dark

| Roles | Size delta | Weight delta | x ratio range | Occurrences |
|---|---:|---:|---|---:|
| member → meta | -2 | -200 | 0.851–0.851 | 3 |
| member → unnamed | -2 | -200 | 0.851–0.851 | 1 |
| member → unnamed | -1 | -200 | 0.922–0.922 | 1 |
| member → unnamed | -1 | -100 | 0.925–0.925 | 1 |
| member → unnamed | 0 | -200 | 0.993–0.993 | 8 |
| meta → member | 2 | 200 | 1.175–1.175 | 3 |
| meta → unnamed | 0 | 0 | 1–1 | 7 |
| meta → unnamed | 0 | 100 | 1.004–1.004 | 1 |
| meta → unnamed | 1 | 0 | 1.083–1.083 | 3 |
| meta → unnamed | 1 | 100 | 1.087–1.087 | 1 |
| meta → unnamed | 2 | 0 | 1.167–1.167 | 5 |
| muted → prose | 1 | 0 | 1.077–1.077 | 3 |
| muted → prose | 1 | 200 | 1.085–1.085 | 2 |
| navigation → unnamed | 0 | 0 | 1–1 | 1 |
| navigation → unnamed | 1 | 0 | 1.077–1.077 | 1 |
| row → meta | -1 | -100 | 0.92–0.92 | 1 |
| subject → meta | -2 | -100 | 0.854–0.854 | 3 |
| subject → unnamed | -2 | -100 | 0.854–0.854 | 2 |
| subject → unnamed | -2 | 0 | 0.857–0.857 | 1 |
| subject → unnamed | -1 | -100 | 0.925–0.925 | 1 |
| unnamed → member | 0 | 200 | 1.008–1.008 | 5 |
| unnamed → member | 2 | 200 | 1.175–1.175 | 3 |
| unnamed → meta | -2 | 0 | 0.857–0.857 | 6 |
| unnamed → meta | -1 | 0 | 0.923–0.923 | 4 |
| unnamed → meta | 0 | -100 | 0.996–0.996 | 1 |
| unnamed → meta | 0 | 0 | 1–1 | 8 |
| unnamed → muted | 0 | 0 | 1–1 | 1 |
| unnamed → muted | 1 | 0 | 1.083–1.083 | 2 |
| unnamed → navigation | -1 | 0 | 0.929–0.929 | 1 |
| unnamed → navigation | 0 | 0 | 1–1 | 2 |
| unnamed → subject | 0 | 100 | 1.004–1.004 | 3 |
| wordmark → unnamed | -7 | -200 | 0.645–0.645 | 1 |
