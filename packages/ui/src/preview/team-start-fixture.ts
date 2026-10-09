import type { FlowPolicy } from '@harnessdesk/protocol'
import source0 from '../../../server/flows/alignment.yml?raw'
import source1 from '../../../server/flows/comparison.yml?raw'
import source2 from '../../../server/flows/fan-out.yml?raw'
import source3 from '../../../server/flows/fix-and-review.yml?raw'
import source4 from '../../../server/flows/independent-review.yml?raw'
import source5 from '../../../server/flows/investigation.yml?raw'
import source6 from '../../../server/flows/mechanical-contest.yml?raw'
import source7 from '../../../server/flows/review-pr.yml?raw'
import source8 from '../../../server/flows/review.yml?raw'
import source9 from '../../../server/flows/staged-relay.yml?raw'

export const TEAM_START_SOURCES: Readonly<Record<string, string>> = { "alignment": source0, "comparison": source1, "fan-out": source2, "fix-and-review": source3, "independent-review": source4, "investigation": source5, "mechanical-contest": source6, "review-pr": source7, "review": source8, "staged-relay": source9 }

// Synthesized from the shipped policy parser, with no sessions or account data.
export const TEAM_START_POLICIES = {
  "alignment": {
    "version": 2,
    "name": "Alignment",
    "description": "An agent proposes a plan; nothing beyond that proposal is admitted until a person has looked at it.",
    "summary": "An agent proposes a plan; nothing more until you look.",
    "inputs": [
      {
        "id": "task",
        "label": "Task"
      }
    ],
    "roles": [
      {
        "id": "propose",
        "kind": "agent",
        "uses": [
          "requirements-analyst"
        ],
        "seats": [],
        "isolate": false,
        "grant": "read",
        "independentOf": []
      },
      {
        "id": "align",
        "kind": "person",
        "outcomes": [
          "agreed",
          "disagree"
        ]
      },
      {
        "id": "build",
        "kind": "agent",
        "uses": [
          "implementer"
        ],
        "seats": [],
        "isolate": false,
        "grant": "edit",
        "independentOf": []
      }
    ],
    "rules": [
      {
        "id": "to-align",
        "on": "propose",
        "when": {
          "every": [
            "agreed"
          ]
        },
        "then": {
          "role": "align",
          "title": "Agree the plan before anything is built"
        }
      },
      {
        "id": "to-build",
        "on": "align",
        "when": {
          "every": [
            "agreed"
          ]
        },
        "then": {
          "role": "build",
          "title": "Build the agreed plan"
        }
      }
    ],
    "seed": {
      "role": "propose",
      "title": "{{task}}"
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 3,
      "withoutProgress": 2
    },
    "layout": {
      "frontDoor": {
        "order": 6,
        "contexts": [
          "project"
        ]
      }
    }
  },
  "comparison": {
    "version": 2,
    "name": "Side by side",
    "description": "One task, two isolated agents; a check on each, then a judge picks, then a person merges.",
    "summary": "Two agents, one task; a judge picks, you merge.",
    "inputs": [
      {
        "id": "task",
        "label": "Task"
      }
    ],
    "roles": [
      {
        "id": "competitor",
        "kind": "agent",
        "uses": [
          "implementer"
        ],
        "seats": [],
        "count": 2,
        "isolate": true,
        "grant": "edit",
        "independentOf": []
      },
      {
        "id": "verify",
        "kind": "check",
        "check": {
          "run": "pnpm verify",
          "onRequest": true,
          "timeout": 900,
          "exits": {
            "0": "pass"
          },
          "otherwise": "fail"
        }
      },
      {
        "id": "judge",
        "kind": "agent",
        "uses": [
          "judge"
        ],
        "seats": [],
        "isolate": false,
        "grant": "read",
        "independentOf": [
          "competitor"
        ]
      },
      {
        "id": "referee",
        "kind": "person",
        "outcomes": [
          "merged"
        ]
      }
    ],
    "rules": [
      {
        "id": "to-verify",
        "on": "competitor",
        "then": {
          "role": "verify",
          "title": "Check the attempt"
        }
      },
      {
        "id": "to-judge",
        "on": "verify",
        "when": {
          "any": [
            "pass"
          ]
        },
        "then": {
          "role": "judge",
          "title": "Pick the best attempt"
        }
      },
      {
        "id": "to-referee",
        "on": "judge",
        "when": {
          "every": [
            "picked"
          ],
          "evidence": [
            {
              "review": "picked"
            }
          ]
        },
        "then": {
          "role": "referee",
          "title": "Merge the picked change",
          "detail": "Merge exactly {{evidence.review.at}}, the revision the judge picked."
        }
      }
    ],
    "seed": {
      "role": "competitor",
      "title": "{{task}}"
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 4,
      "withoutProgress": 2
    },
    "layout": {
      "race": "competitor",
      "frontDoor": {
        "order": 3,
        "contexts": [
          "project"
        ]
      }
    }
  },
  "fan-out": {
    "version": 2,
    "name": "Fan-out review",
    "description": "Several reviewers read the same change at once; every one of them has to approve before it ships.",
    "summary": "Several reviewers; every one must approve.",
    "inputs": [
      {
        "id": "task",
        "label": "Task"
      }
    ],
    "roles": [
      {
        "id": "build",
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
        "id": "review",
        "kind": "agent",
        "uses": [
          "code-reviewer"
        ],
        "seats": [],
        "count": 3,
        "isolate": false,
        "grant": "read",
        "independentOf": [
          "build"
        ]
      },
      {
        "id": "ship",
        "kind": "person",
        "outcomes": [
          "shipped"
        ]
      }
    ],
    "rules": [
      {
        "id": "to-review",
        "on": "build",
        "then": {
          "role": "review",
          "title": "Review the change"
        }
      },
      {
        "id": "to-ship",
        "on": "review",
        "when": {
          "every": [
            "approve"
          ]
        },
        "then": {
          "role": "ship",
          "title": "Ship it — every reviewer approved"
        }
      }
    ],
    "seed": {
      "role": "build",
      "title": "{{task}}"
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 3,
      "withoutProgress": 2
    },
    "layout": {
      "frontDoor": {
        "order": 2,
        "contexts": [
          "project"
        ]
      }
    }
  },
  "fix-and-review": {
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
        "grant": "publish",
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
            "published"
          ]
        },
        "then": {
          "role": "reviewer",
          "title": "Review the pull request",
          "detail": "Review the pull request the fixer's context package names independently."
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
          "detail": "Answer every finding, push to the same branch, and publish again."
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
          "title": "Merge it — every reviewer approved",
          "detail": "Merging is yours; no agent in this flow may do it."
        }
      }
    ],
    "seed": {
      "role": "fixer",
      "title": "{{work}}",
      "detail": "Open a pull request for it when it is done and working."
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
  },
  "independent-review": {
    "version": 2,
    "name": "Independent review",
    "description": "A change is built, then read by several different specialists at once — security, performance and API, never the same eyes twice.",
    "summary": "Security, speed and API specialists read one change.",
    "inputs": [
      {
        "id": "task",
        "label": "Task"
      }
    ],
    "roles": [
      {
        "id": "build",
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
        "id": "specialists",
        "kind": "agent",
        "uses": [
          "security-reviewer",
          "performance-reviewer",
          "api-reviewer"
        ],
        "seats": [],
        "isolate": false,
        "grant": "read",
        "independentOf": [
          "build"
        ]
      },
      {
        "id": "ship",
        "kind": "person",
        "outcomes": [
          "shipped"
        ]
      }
    ],
    "rules": [
      {
        "id": "to-specialists",
        "on": "build",
        "then": {
          "role": "specialists",
          "title": "Review the change"
        }
      },
      {
        "id": "to-ship",
        "on": "specialists",
        "when": {
          "every": [
            "approve"
          ]
        },
        "then": {
          "role": "ship",
          "title": "Ship it — every specialist approved"
        }
      }
    ],
    "seed": {
      "role": "build",
      "title": "{{task}}"
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 3,
      "withoutProgress": 2
    },
    "layout": {
      "frontDoor": {
        "order": 1,
        "contexts": [
          "project"
        ]
      }
    }
  },
  "investigation": {
    "version": 2,
    "name": "Investigation",
    "description": "A researcher answers a question and commits its answer where the diff itself is the evidence a person reads before closing it out.",
    "summary": "One agent answers a question; you read the evidence.",
    "inputs": [
      {
        "id": "question",
        "label": "Question"
      }
    ],
    "roles": [
      {
        "id": "research",
        "kind": "agent",
        "uses": [
          "researcher"
        ],
        "seats": [],
        "isolate": false,
        "grant": "edit",
        "independentOf": []
      },
      {
        "id": "close",
        "kind": "person",
        "outcomes": [
          "closed"
        ]
      }
    ],
    "rules": [
      {
        "id": "to-close",
        "on": "research",
        "when": {
          "every": [
            "gathered"
          ],
          "evidence": [
            {
              "diff": true
            }
          ]
        },
        "then": {
          "role": "close",
          "title": "Read the committed answer"
        }
      }
    ],
    "seed": {
      "role": "research",
      "title": "{{question}}"
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 3,
      "withoutProgress": 2
    },
    "layout": {
      "frontDoor": {
        "order": 5,
        "contexts": [
          "project"
        ]
      }
    }
  },
  "mechanical-contest": {
    "version": 2,
    "name": "Mechanical contest",
    "description": "Two attempts, and a script decides between them by its exit status alone — never an agent's own prose.",
    "summary": "Two attempts; a script's exit status decides.",
    "inputs": [
      {
        "id": "task",
        "label": "Task"
      }
    ],
    "roles": [
      {
        "id": "competitor",
        "kind": "agent",
        "uses": [
          "implementer"
        ],
        "seats": [],
        "count": 2,
        "isolate": true,
        "grant": "edit",
        "independentOf": []
      },
      {
        "id": "decide",
        "kind": "check",
        "check": {
          "run": "script/flow-contest.sh",
          "cwd": ".",
          "timeout": 300,
          "exits": {
            "0": "first",
            "1": "second",
            "2": "draw"
          },
          "otherwise": "no-contest"
        }
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
        "id": "to-decide",
        "on": "competitor",
        "then": {
          "role": "decide",
          "title": "Decide between the two attempts"
        }
      },
      {
        "id": "first-wins",
        "on": "decide",
        "when": {
          "every": [
            "first"
          ]
        },
        "then": {
          "role": "referee",
          "title": "Merge the first attempt"
        }
      },
      {
        "id": "second-wins",
        "on": "decide",
        "when": {
          "every": [
            "second"
          ]
        },
        "then": {
          "role": "referee",
          "title": "Merge the second attempt"
        }
      },
      {
        "id": "drawn",
        "on": "decide",
        "when": {
          "every": [
            "draw"
          ]
        },
        "then": {
          "role": "referee",
          "title": "Pick between two equally scoring attempts"
        }
      }
    ],
    "seed": {
      "role": "competitor",
      "title": "{{task}}"
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 3,
      "withoutProgress": 2
    },
    "layout": {
      "frontDoor": {
        "contexts": [
          "project"
        ]
      }
    }
  },
  "review-pr": {
    "version": 2,
    "name": "Review, then a person merges",
    "description": "A fix is read by two independent specialists in one blind round, a script checks it mechanically, and a person merges once the pull request the review judged is still exactly what it was — never an automatic merge.",
    "summary": "Two blind reviews and a script check; you merge.",
    "inputs": [
      {
        "id": "task",
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
          "code-reviewer",
          "security-reviewer"
        ],
        "seats": [],
        "isolate": false,
        "grant": "read",
        "independentOf": []
      },
      {
        "id": "gate",
        "kind": "check",
        "check": {
          "run": "true",
          "onRequest": true,
          "cwd": ".",
          "timeout": 300,
          "exits": {
            "0": "passed"
          },
          "otherwise": "failed"
        }
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
        "id": "to-review",
        "on": "fixer",
        "then": {
          "role": "reviewer",
          "title": "Review the fix"
        }
      },
      {
        "id": "again",
        "on": "reviewer",
        "when": {
          "any": [
            "request-changes"
          ]
        },
        "then": {
          "role": "fixer",
          "title": "Repair the findings"
        }
      },
      {
        "id": "to-gate",
        "on": "reviewer",
        "when": {
          "every": [
            "approve"
          ]
        },
        "then": {
          "role": "gate",
          "title": "Run the mechanical check"
        }
      },
      {
        "id": "to-referee",
        "on": "gate",
        "when": {
          "every": [
            "passed"
          ],
          "evidence": [
            {
              "pr": "open"
            }
          ]
        },
        "then": {
          "role": "referee",
          "title": "Merge the reviewed pull request"
        }
      }
    ],
    "seed": {
      "role": "fixer",
      "title": "{{task}}",
      "detail": "Commit the card's work with commit_work. The tool adds the desk's co-author credit; supply only your message."
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 9,
      "withoutProgress": 2
    },
    "layout": {
      "frontDoor": {
        "contexts": [
          "project"
        ]
      }
    }
  },
  "review": {
    "version": 2,
    "name": "Review",
    "description": "Three specialists — security, performance and API — read one change at the commit it was when you started, each in a checkout of its own, and none of them can change it.",
    "summary": "Three specialists read a change; none can edit it.",
    "inputs": [
      {
        "id": "head",
        "label": "Commit to review",
        "default": "the uncommitted work in this checkout"
      },
      {
        "id": "base",
        "label": "Compared with",
        "default": "the commit it was based on, which this start did not name"
      },
      {
        "id": "pr",
        "label": "Pull request",
        "default": "none"
      }
    ],
    "roles": [
      {
        "id": "specialists",
        "kind": "agent",
        "uses": [
          "security-reviewer",
          "performance-reviewer",
          "api-reviewer"
        ],
        "seats": [],
        "isolate": false,
        "grant": "read",
        "independentOf": []
      },
      {
        "id": "decide",
        "kind": "person",
        "outcomes": [
          "done"
        ]
      }
    ],
    "rules": [
      {
        "id": "to-decide",
        "on": "specialists",
        "then": {
          "role": "decide",
          "title": "Read the three reviews"
        }
      }
    ],
    "seed": {
      "role": "specialists",
      "title": "Review {{head}}",
      "detail": "Compare it with {{base}}. Pull request: {{pr}}. Read only: report what you find, and change nothing."
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 2,
      "withoutProgress": 1
    },
    "layout": {
      "frontDoor": {
        "order": 1,
        "contexts": [
          "branch",
          "pull-request",
          "diff",
          "working-diff"
        ],
        "bindings": [
          {
            "input": "head",
            "value": "head"
          },
          {
            "input": "base",
            "value": "base"
          },
          {
            "input": "pr",
            "value": "pr"
          }
        ]
      }
    }
  },
  "staged-relay": {
    "version": 2,
    "name": "Staged relay",
    "description": "Work passes through a fixed relay of specialists, one stage at a time, each handing to the next only once its own answer says to.",
    "summary": "A fixed line of specialists, one stage at a time.",
    "inputs": [
      {
        "id": "task",
        "label": "Task"
      }
    ],
    "roles": [
      {
        "id": "analyze",
        "kind": "agent",
        "uses": [
          "requirements-analyst"
        ],
        "seats": [],
        "isolate": false,
        "grant": "read",
        "independentOf": []
      },
      {
        "id": "build",
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
        "id": "test_review",
        "kind": "agent",
        "uses": [
          "test-reviewer"
        ],
        "seats": [],
        "isolate": false,
        "grant": "read",
        "independentOf": [
          "build"
        ]
      },
      {
        "id": "ship",
        "kind": "person",
        "outcomes": [
          "shipped"
        ]
      }
    ],
    "rules": [
      {
        "id": "to-build",
        "on": "analyze",
        "when": {
          "every": [
            "agreed"
          ]
        },
        "then": {
          "role": "build",
          "title": "Build what was agreed"
        }
      },
      {
        "id": "to-test-review",
        "on": "build",
        "then": {
          "role": "test_review",
          "title": "Read the tests for the change"
        }
      },
      {
        "id": "to-ship",
        "on": "test_review",
        "when": {
          "every": [
            "approve"
          ]
        },
        "then": {
          "role": "ship",
          "title": "Ship it"
        }
      },
      {
        "id": "back-to-build",
        "on": "test_review",
        "when": {
          "every": [
            "request-changes"
          ]
        },
        "then": {
          "role": "build",
          "title": "Fix what the test review found"
        }
      }
    ],
    "seed": {
      "role": "analyze",
      "title": "{{task}}"
    },
    "messaging": "board-only",
    "wait": 240,
    "budget": {
      "rounds": 8,
      "withoutProgress": 2
    },
    "layout": {
      "frontDoor": {
        "order": 4,
        "contexts": [
          "project"
        ]
      }
    }
  }
} satisfies Readonly<Record<string, FlowPolicy>>
