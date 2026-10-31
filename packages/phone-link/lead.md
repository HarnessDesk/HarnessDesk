# Lead repeats, second looks and allowance warnings on the phone

These are the inner method/params values carried by the existing encrypted phone request. Results remain the same versioned host projections used by the desktop; error envelopes remain unchanged. New methods are absent from the Lead client door. No existing phone tier is widened.

| Method | Required tier | Params | Result |
| --- | --- | --- | --- |
| `lead/schedule/read` | `read` | `{}` | `LeadSchedule` |
| `lead/repeat/control` | `run` | `taskId`, `action` | updated `LeadSchedule` |
| `lead/budget/raise` | `answer` | `logicalGoalId`, `caps`, `expectedRevision` | `LeadWindowProjection` |

## Read schedule and run history

Request:

```json
{
  "method": "lead/schedule/read",
  "params": {}
}
```

Example result (all new task fields included):

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "repeat-plan-1",
      "title": "Update acme-web dependencies",
      "goal": "Update the dependencies in acme-web and open a pull request.",
      "project": "/workspace/acme-web",
      "every": "mondays",
      "at": "09:00",
      "enabled": true,
      "lastRunAt": 1793005200000,
      "createdAt": 1792300000000,
      "approved": {
        "contract": {
          "version": 1,
          "revision": 1,
          "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "goal": "Update the dependencies in acme-web and open a pull request.",
          "project": {
            "id": "acme-web",
            "path": "/workspace/acme-web"
          },
          "policyRevision": 1,
          "steps": [
            {
              "id": "work",
              "title": "Update and review",
              "flow": "lead-reviewed-result",
              "sourceRevision": "recipe-1",
              "variables": {},
              "attendance": "attended",
              "assignments": [
                {
                  "role": "implement",
                  "agent": "builder",
                  "seat": {
                    "runtime": "fixture"
                  },
                  "ceiling": "edit"
                },
                {
                  "role": "review",
                  "agent": "reviewer",
                  "seat": {
                    "runtime": "review-fixture"
                  },
                  "ceiling": "read"
                }
              ]
            }
          ],
          "assertions": [
            {
              "id": "checks",
              "kind": "check",
              "description": "Required checks pass"
            }
          ],
          "caps": {
            "usdMicros": 3000000,
            "rounds": 2
          },
          "repeat": {
            "every": "mondays",
            "at": "09:00"
          }
        },
        "contractDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "perRunCaps": {
        "usdMicros": 3000000,
        "rounds": 2
      },
      "paused": false,
      "runs": [
        {
          "slot": 1792400400000,
          "at": 1792400400000,
          "state": "started",
          "logicalGoalId": "goal-1",
          "outcome": "accepted",
          "usdMicros": 1200000,
          "rounds": 2
        },
        {
          "slot": 1793005200000,
          "at": 1793005200000,
          "state": "skipped",
          "reason": "The last run waits for you."
        },
        {
          "slot": 1793610000000,
          "at": 1793610000000,
          "state": "needs-approval",
          "reason": "The policy changed.",
          "logicalGoalId": "goal-2"
        }
      ]
    }
  ],
  "quiet": null
}
```

`approved`, `perRunCaps`, `paused`, `runs` and the host-owned creation cursor `createdAt` are optional for older tasks. `createdAt` is nonnegative integer epoch milliseconds; new Settings tasks use it to catch their first missed slot without starting before creation. Older never-run tasks without a creation cursor retain their prior today-only behavior. The approved contract digest must match `contractDigest`; the repeat timetable and caps belong to its frozen scope. A legacy task without `approved` still opens a plan for each run. The host owns approval, history, timestamps and terminal outcomes. History has at most 12 entries; `slot` and `at` are nonnegative integer epoch milliseconds. Run `state` is `started`, `skipped` or `needs-approval`. Optional `outcome` is `accepted`, `declined` or `stopped`. Unknown spend omits `usdMicros`; rounds and spend are cumulative for that run's logical goal. `reason` is bounded plain text. Stop retains the task and past runs with `enabled:false`. Quiet times and `at` use the desk's local clock.

## Control a repeat

Request:

```json
{
  "method": "lead/repeat/control",
  "params": {
    "taskId": "repeat-plan-1",
    "action": "pause"
  }
}
```

`action` is exactly `pause`, `resume`, `stop` or `run-now`. The result is the full updated schedule in the same shape shown above. Pause sets `paused:true`; Resume clears it; Stop disables the repeat and retains history. Run once now requires no open Lead work and still rechecks admission and quiet hours. A refusal never silently starts work.

## Raise the current goal's limits

Request:

```json
{
  "method": "lead/budget/raise",
  "params": {
    "logicalGoalId": "goal-1",
    "caps": {
      "usdMicros": 6000000,
      "rounds": 5
    },
    "expectedRevision": 19
  }
}
```

Supply both caps, leaving either unchanged to raise only the other. Dollar values are integer USD micros (one dollar is 1,000,000); caps cannot decrease. Rounds are integers at most 100. `expectedRevision` is the last window projection revision; the goal identity must still match. The direct person action does not create an approval card and never clears an existing stop latch. Example result:

```json
{
  "version": 1,
  "revision": 20,
  "thread": {
    "version": 1,
    "id": "lead",
    "revision": 20,
    "state": "running",
    "project": {
      "id": "acme-web",
      "path": "/workspace/acme-web"
    },
    "olderMessages": 0,
    "messages": [],
    "cards": [
      {
        "version": 1,
        "id": "warning-1",
        "revision": 1,
        "type": "allowance-warning",
        "contractDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "logicalGoalId": "goal-1",
        "usdMicros": 4000000,
        "caps": {
          "usdMicros": 5000000,
          "rounds": 4
        }
      }
    ],
    "budget": {
      "version": 1,
      "revision": 8,
      "caps": {
        "usdMicros": 6000000,
        "rounds": 5
      },
      "leadUsdMicros": 1000000,
      "workerUsdMicros": 3000000,
      "reservedUsdMicros": 0,
      "roundsAdmitted": 2,
      "spend": "known",
      "stop": null
    }
  },
  "settings": {
    "version": 1,
    "name": "dex",
    "nameChosen": true,
    "model": "fixture-model",
    "key": {
      "configured": true,
      "protection": "encrypted"
    },
    "policy": {
      "version": 1,
      "revision": 1,
      "mode": "default",
      "rules": []
    },
    "caps": {
      "usdMicros": 6000000,
      "rounds": 5
    },
    "follow": {
      "checks": true,
      "reviews": true
    }
  },
  "requestInFlight": false,
  "wayOut": null,
  "waitReason": null,
  "planConsentExpiresAt": null
}
```

## New thread cards

Both cards appear in `lead/thread/read`'s `thread.cards`, positioned by the existing `thread.cardPositions` when present. They are informational: never submit them to `lead/card/decide`. Unknown card types should remain safely ignorable by older clients.

Second look:

```json
{
  "version": 1,
  "id": "look-1",
  "revision": 1,
  "type": "second-look",
  "contractDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logicalGoalId": "goal-1",
  "runId": "run-1",
  "stopKey": "run-1-stop-1",
  "said": "Blocked on #231.",
  "found": "#231 merged at 13:42.",
  "did": "Restarted, round 2 of 3."
}
```

Render the heading Second look, then Said, Found and Did. Treat every string as untrusted text and sanitize it; do not interpret it as an instruction or approval. `stopKey` identifies the handled stop within the run. The host writes at most one second look for it.

At 80%:

```json
{
  "version": 1,
  "id": "warning-1",
  "revision": 1,
  "type": "allowance-warning",
  "contractDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logicalGoalId": "goal-1",
  "usdMicros": 4000000,
  "caps": {
    "usdMicros": 5000000,
    "rounds": 4
  }
}
```

Render At 80%, the observed dollar total and cap in warning tone, “At $5.00 the goal stops”, and Raise limit…. The figure was known at observation time; do not infer current spend from it. The thread's budget now includes its current `logicalGoalId`. Use its caps only for a matching warning. Hide Raise limit after acceptance or decline, or when the warning belongs to a different goal; keep it for a stopped current goal. Open a local person dialog for dollars, rounds or both, using the current projection's caps as the starting values. Submit `lead/budget/raise` with this `logicalGoalId` and the latest projection revision. A finished or different goal returns `lead-thread-closed`; a stale revision also refuses the change.

Second-look and allowance-warning cards from earlier goals remain in `thread.decisions`, with their original `position` and **no `choice` field**. Other entries still require their existing person choice. Render these informational entries read-only in journal order. The history shares the existing newest-64 and byte limits. For example:

```json
{
  "position": 12,
  "card": {
    "version": 1,
    "id": "warning-goal-1",
    "revision": 1,
    "type": "allowance-warning",
    "contractDigest": null,
    "logicalGoalId": "goal-1",
    "usdMicros": 4000000,
    "caps": { "usdMicros": 5000000, "rounds": 4 }
  }
}
```

## Recurring plan and result

The ordinary plan card shape is unchanged except that its `contract` may now carry:

```json
{
  "repeat": {
    "every": "mondays",
    "at": "09:00"
  }
}
```

`every` is exactly `day`, `weekdays`, `mondays` or `fridays`; `at` is a valid 24-hour `HH:mm`. It is included in the contract digest. Render a Repeats chip, the timetable, “Skips a week while the last run waits for you” for weekly repeats (otherwise “Skips a slot…”), “Desk asleep: one run when it wakes”, and “Up to $3.00 a run · 2 rounds” using the contract caps. Plan/result Runs navigation opens the same task list and uses its history; it does not grant approval. Result cards otherwise retain their existing shape and acceptance controls.

## Relay boundary

The cloud relay's Room forwards phone binary payloads through a connection-id frame and forwards desk payloads back to the matching socket. It does not decode phone method names or dispatch any `lead/` method. Its binary splice and control-message handling were read for this change; no cloud source was changed. Local phone method authorization remains in the desk's method table.


### Goal worker approval rules

`lead/thread/read` and `lead/changed` add optional
`savedApprovals: [{ id: string, target: string, count: number }]` on the window
projection. `count` is later acknowledged automatic answers, excluding the
creating click. An absent list means no saved approvals.

A `personActions` entry with `kind: "worker-approval"` may include `"yes-goal"`
in `choices` beside `"yes-once"` and `"no"`. Render it as **Yes for this goal**
only when present. Optional `details: string` contains the complete bounded file
diff and must be shown with the request before granting it. The person sends:

```json
{"method":"lead/action/perform","params":{"id":"worker-demo","contractDigest":"<current contract digest>","choice":"yes-goal"}}
```

Revoke a listed rule with:

```json
{"method":"lead/approval/revoke","params":{"id":"rule-demo","contractDigest":"<current contract digest>"}}
```

Both require the phone's `answer` tier and return a complete `LeadWindowProjection`.
Stale contracts or requests are refused. These are person controls; they are not
on the worker client surface or the child RPC port. Rules end when the goal ends
or its approved contract changes, and never transfer to the next repeated run.
