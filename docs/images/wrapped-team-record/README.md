# Wrapped Team records

Source commit: `1e7593490ee05cb73d7c05d16dee716b9e321faf`.

These 54 frames use the real Team pane, Overview, Run view, conversations, dialogs and sidebar with synthetic preview data. Both membership lists are empty; receipt links keep the conversations readable. The older receipt uses answer links and keeps an unlinked Seat visible. No frame comes from a real desk.

Every frame was inspected in its theme. Narrow receipt and rail frames are 384 pixels wide; catalogue narrow frames show the same width. The first 46 frames were captured from `7de39b51e42c94519ebb0cf0d298900f057d3dce`. The source commit above changes only two things a frame can show: a wrapped Team that never had a Run now opens on its Receipt in a narrow pane, and a sidebar group lists all of its Seats without a conversation in one nested list. Both are in the eight frames added here, so the 46 stand. To check that, the Wrapped receipt, Narrow receipt, Narrow rail, Catalogue narrow and Wrapped sidebar group (a conversation seated twice) frames were captured again from the source commit, and all are byte-identical to the earlier capture. The Wrapped sidebar group frames were captured again too: they differ from the earlier capture by anti-aliasing alone (13 pixels in each theme, none by more than 12 of 255 levels), and capturing them with the sidebar code from `7de39b51` gives the same bytes as the new code.

A Team that never had a Run opens on the same Receipt as one a Run wrapped, so its two receipt frames are byte-identical to Narrow receipt and Catalogue narrow. What differs is the rail behind it, which has no Run row.

| Scene | Light | Dark |
| --- | --- | --- |
| Wrapped receipt | [light](wrapped-light.png) | [dark](wrapped-dark.png) |
| Older receipt | [light](older-light.png) | [dark](older-dark.png) |
| A conversation seated twice, listed once | [light](shared-light.png) | [dark](shared-dark.png) |
| Older receipt, every Seat without a conversation | [light](unlinked-light.png) | [dark](unlinked-dark.png) |
| No kept Seats | [light](empty-light.png) | [dark](empty-dark.png) |
| Overview with an unlinked Seat | [light](overview-light.png) | [dark](overview-dark.png) |
| Run timeline | [light](run-light.png) | [dark](run-dark.png) |
| Kept conversation | [light](conversation-light.png) | [dark](conversation-dark.png) |
| Conversation menu: Compact now refused | [light](menu-compact-light.png) | [dark](menu-compact-dark.png) |
| Branch menu: Review uncommitted changes refused | [light](menu-review-light.png) | [dark](menu-review-dark.png) |
| Wrapped sidebar group | [light](sidebar-light.png) | [dark](sidebar-dark.png) |
| Wrapped sidebar group, a conversation seated twice | [light](sidebar-shared-light.png) | [dark](sidebar-shared-dark.png) |
| Wrapped sidebar group, two Seats without a conversation | [light](sidebar-unlinked-light.png) | [dark](sidebar-unlinked-dark.png) |
| Narrow receipt | [light](narrow-light.png) | [dark](narrow-dark.png) |
| Narrow rail | [light](narrow-rail-light.png) | [dark](narrow-rail-dark.png) |
| Never had a Run: narrow receipt, where it opens | [light](person-light.png) | [dark](person-dark.png) |
| Never had a Run: narrow rail, one tap behind it | [light](person-rail-light.png) | [dark](person-rail-dark.png) |
| Open when the Run ends: Seat an Agent | [light](dialog-seat-light.png) | [dark](dialog-seat-dark.png) |
| Open when the Run ends: Add work | [light](dialog-add-work-light.png) | [dark](dialog-add-work-dark.png) |
| Open when the Run ends: Stop a card | [light](dialog-stop-light.png) | [dark](dialog-stop-dark.png) |
| Catalogue: wrapped | [light](catalogue-wrapped-light.png) | [dark](catalogue-wrapped-dark.png) |
| Catalogue: older | [light](catalogue-older-light.png) | [dark](catalogue-older-dark.png) |
| Catalogue: seated twice | [light](catalogue-shared-light.png) | [dark](catalogue-shared-dark.png) |
| Catalogue: no conversation kept | [light](catalogue-unlinked-light.png) | [dark](catalogue-unlinked-dark.png) |
| Catalogue: empty | [light](catalogue-empty-light.png) | [dark](catalogue-empty-dark.png) |
| Catalogue: narrow | [light](catalogue-narrow-light.png) | [dark](catalogue-narrow-dark.png) |
| Catalogue: never had a Run | [light](catalogue-person-light.png) | [dark](catalogue-person-dark.png) |
