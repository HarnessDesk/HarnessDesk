// New Team's edit-first specimen, synthesized from the shipped shape.
// The old team-start specimen remains the before case. No account data.
import type { FlowPolicy } from '@harnessdesk/protocol'

export const EDIT_TEAM_START_POLICY: FlowPolicy = {
  "version": 2,
  "name": "Write and review",
  "description": "One writer and a fresh independent reviewer, with at most three reviews before a person takes over.",
  "summary": "One writes, a fresh reviewer reads, up to three rounds.",
  "inputs": [
    {
      "id": "work",
      "label": "Task"
    }
  ],
  "roles": [
    {
      "id": "fixer",
      "kind": "agent",
      "uses": [
        "implementer"
      ],
      "seats": [],
      "isolate": false,
      "grant": "edit",
      "independentOf": []
    },
    {
      "id": "reviewer",
      "kind": "agent",
      "uses": [
        "code-reviewer"
      ],
      "seats": [],
      "isolate": false,
      "grant": "read",
      "independentOf": [
        "fixer"
      ]
    },
    {
      "id": "referee",
      "kind": "person",
      "outcomes": [
        "merged",
        "dropped"
      ]
    }
  ],
  "rules": [
    {
      "id": "review-it",
      "on": "fixer",
      "when": {
        "every": [
          "committed"
        ]
      },
      "then": {
        "role": "reviewer",
        "title": "Review the committed change",
        "detail": "Review the committed branch and revision the fixer's context package names independently."
      }
    },
    {
      "id": "fix-again",
      "on": "reviewer",
      "when": {
        "any": [
          "request-changes"
        ]
      },
      "then": {
        "role": "fixer",
        "title": "Answer the reviews",
        "detail": "Answer every finding and commit the repair on the same branch for another review."
      }
    },
    {
      "id": "hand-to-the-person",
      "on": "reviewer",
      "when": {
        "every": [
          "approve"
        ],
        "evidence": [
          {
            "review": "approve"
          }
        ]
      },
      "then": {
        "role": "referee",
        "title": "Approve publishing the reviewed change",
        "detail": "Review and approve publishing revision {{evidence.review.at}} from the branch named in the writer’s context package. You decide whether to push that branch and open a pull request, then merge after its checks pass, or drop the change. No agent in this Team may push or merge."
      }
    }
  ],
  "complete": {
    "referee": [
      "merged",
      "dropped"
    ]
  },
  "seed": {
    "role": "fixer",
    "title": "{{work}}",
    "detail": "Commit the finished work on your own branch and hand over its branch and revision for review. Do not push or open a pull request."
  },
  "messaging": "board-only",
  "wait": 240,
  "budget": {
    "rounds": 7,
    "withoutProgress": 2
  },
  "layout": {
    "frontDoor": {
      "order": 0,
      "contexts": [
        "project"
      ]
    },
    "positions": {
      "fixer": {
        "x": 40,
        "y": 40
      },
      "reviewer": {
        "x": 300,
        "y": 40
      },
      "referee": {
        "x": 560,
        "y": 40
      }
    }
  }
}
