# Content names — 14/500

These light and dark frames render the real components at source commit
`5eab4b5f913e7b152540dcb133acee14e53c23c6`, using the preview rig and catalogue.
Every frame was opened and inspected. No real desk or account was captured.

| Surface | Light | Dark |
| --- | --- | --- |
| Goal roster, inline status and populated chat | [light](goal-roster-light.png) | [dark](goal-roster-dark.png) |
| Room chat beside the board and notices | [light](coverage-notice-room-board-light.png) | [dark](coverage-notice-room-board-dark.png) |
| MemberName beside row and navigation specimens | [light](catalogue-member-name-light.png) | [dark](catalogue-member-name-dark.png) |
| ChannelMessage catalogue | [light](catalogue-channel-light.png) | [dark](catalogue-channel-dark.png) |

Computed in both themes: content member names are 14px/500, row names
13px/500 and navigation names 13px/400. The browser regression also checks
Desk and Studio, and verifies that setting `--hd-member-weight` to `600`
restores the former content-name weight.

Reproduce with the preview at `preview.html` and
`preview.html?notice-placement`, and the catalogue at
`design.html?view=dialog` and `design.html?view=channel`.
