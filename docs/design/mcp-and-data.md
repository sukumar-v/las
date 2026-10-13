# MCP tools, agent behavior and data

How the agent, the LAS server and the studio talk to each other: the tool contracts, the rules the agent follows, events, and the stored data.

Related: [learning loop](learning-loop.md) · [evaluation](evaluation.md) · [skill packs](skill-packs.md) · [overview](../DESIGN.md)

---

## 1. How the pieces talk

```mermaid
sequenceDiagram
  participant L as Learner
  participant A as Agent + LAS skill
  participant S as LAS server
  participant U as Studio (widget or PWA)
  L->>A: "Let's practice"
  A->>S: next_session(skill)
  S-->>A: SessionPlan + widget
  A->>U: show widget inline, or a studio link
  L->>U: does the session
  U->>S: events (drill.outcome, attempt.analyzed, …)
  S->>S: update mastery, reviews, mistakes, schedule
  A->>S: get_session_summary(session)
  S-->>A: summary + one fix
  A->>L: a few words + a visual (render_* tools)
```

- **Inline when possible:** if the client renders MCP Apps, sessions, drills and progress appear inside the chat. Otherwise tools return a studio link (`http://localhost:4711/s/<id>`, or the hosted URL).
- **The server is the source of truth.** The agent never keeps learner state in its own memory; it reads it back through tools and resources.

## 2. Tools

Inputs and outputs, simplified. `sk` = a learner's enrollment in one skill (a learner can learn several skills).

### Onboarding
| Tool | Input | Output |
|---|---|---|
| `start_intake` | `skill: string` | `{intakeId, pack, whyOptions, widget}` |
| `record_answer` | `intakeId, field, value` | `{next, options}`: options already ranked for this learner |
| `place_learner` | `intakeId` | `{step, evidence}` |
| `suggest_milestones` | `intakeId` | `Suggestion[]` (quick win, toward your picture, stretch) |
| `check_feasibility` | `intakeId, milestone` | `{verdict, weeks, steppingStone?}` |
| `set_milestone` | `intakeId, milestone` | `{sk, route, firstSession}` |

### Plan
| Tool | Input | Output |
|---|---|---|
| `get_today` | `sk` | `TodayView` (next session, reviews due, milestone, check-in) |
| `next_session` | `sk, minutes?, location?` | `SessionPlan` (blocks, each with a reason) + widget |
| `reschedule` | `sessionId, when \| "skip"` | Updated schedule |
| `replan` | `sk, option` | New route and dates (options come from a check-in) |

### Teach
| Tool | Input | Output |
|---|---|---|
| `render_lesson` | `LessonSpec` (cards, 25-word budget) | Widget. **Rejects specs over budget** |
| `render_mechanism` | `concept` | anatomy figure (cached) |
| `render_diagram` | `DiagramSpec` (mermaid, d3, notation, code trace) | Widget |
| `explain_mistake` | `mistakeId, attemptId?` | The mistake's explanation visual, using the learner's own frame when there is one |

### Practice
| Tool | Input | Output |
|---|---|---|
| `start_drill` | `drillId, difficulty?` | Widget |
| `review_cards` | `sk, n?` | Widget with due FSRS cards |

### Evaluate
| Tool | Input | Output |
|---|---|---|
| `request_capture` | `attemptSpec` | Recording widget or studio link (opens on the phone if paired) |
| `get_analysis` | `attemptId` | `Analysis` ([evaluation §1](evaluation.md#1-evaluator-contract)) + key frames |
| `run_proof_check` | `milestoneId` | Recording flow, then `ProofResult` |

### Track
| Tool | Input | Output |
|---|---|---|
| `get_progress` | `sk` | Progress widget + data |
| `get_session_summary` | `sessionId` | What changed, one fix, next session |
| `log_external` | `sk, minutes, note` | Logs practice done outside the app |
| `report_pain` | `sk, area, level` | Lowers intensity now, schedules a follow-up |
| `revisit_why` | `sk` | Why and six-month questions again |
| `export_data` / `delete_data` | `scope` | A file / confirmation |

## 3. Resources and prompts

- **Resources (read-only):**
  - `las://learner/profile`
  - `las://skills/{sk}/route`
  - `las://skills/{sk}/progress`
  - `las://skills/{sk}/mistakes`
  - `las://packs/{pack}`
- **Prompts:**
  - `/las-start`: learn something new
  - `/las-session`: today's session
  - `/las-weekly-review`
  - `/las-stuck`: plateau or motivation conversation

## 4. Agent rules (in the skill)

1. **Visuals first.** Before explaining anything, call a `render_*` tool. No more than 2 sentences of prose between visuals. No headings or bullet lists explaining a concept.
2. **Never grade raw recordings.** Grade only from `get_analysis`, and quote its evidence.
3. **One fix at a time,** plus one thing done well.
4. **No silent plan changes.** Offer `replan` options and let the learner choose.
5. **Pain means stop:** call `report_pain`, lower intensity, and suggest a professional if it continues. Never diagnose.
6. **Talk to the learner's why,** not to guilt. No countdowns or "you broke your streak".
7. **Unsure means ask** for a better recording, never guess.

## 5. Events

The studio sends events to the server. The server updates models and schedules; the agent reads the results.

| Event | Payload | Server reaction |
|---|---|---|
| `session.started` / `session.completed` | session id, minutes | Time log, adjust the next session |
| `block.completed` | block, duration | Mix tracking |
| `drill.outcome` | nodes, success, score, metrics, mistakes | Update BKT mastery, in-session difficulty, mistake states |
| `review.graded` | card, grade | FSRS schedule |
| `attempt.captured` / `attempt.analyzed` | attempt id, `Analysis` | Mistakes, proof criteria, before-and-after |
| `pain.reported` | area, level | Lower intensity, injury rules, follow-up |
| `checkin.answered` | check-in, option | Re-plan, reschedule, pause |

## 6. Data model (SQLite)

```
learner(id, name, timezone, quiet_hours, nudge_limits, created_at)
enrollment(id, learner_id, pack_id, pack_version, status[active|paused|done], created_at)
intent(enrollment_id, why_json, afterwards, revisited_at)
constraint(enrollment_id, minutes_per_week, deadline, access_json, injuries_json)
milestone(id, enrollment_id, title, ladder_step, proof_json, target_date, status, achieved_at, self_reported)
node_mastery(enrollment_id, node_id, p_known, attempts, updated_at)           -- BKT
review_card(id, enrollment_id, node_id, fsrs_state_json, due_at)               -- FSRS
session(id, enrollment_id, planned_at, started_at, ended_at, plan_json, location)
attempt(id, session_id, drill_id, kind, media_ref, analysis_json, created_at)  -- media_ref points to a file on the device
mistake_state(enrollment_id, mistake_id, state, last_seen_at, disputed_count)
checkin(id, enrollment_id, kind, due_at, sent_at, answered_at, answer)
plan_change(id, enrollment_id, reason, option, created_at)                      -- every re-plan, logged
```

Media files stay on the device under `~/.las/media/<attempt>`. The database only stores references and derived data.

## 7. Sync and multiple devices

- **Local mode:** one SQLite file is the source of truth.
- **Hosted mode:** self-hosted sync (ElectricSQL or libSQL) of the tables above. **Media is never synced** unless the learner turns it on for a specific proof clip.
- **Phone paired with a computer:** the phone sends events and analyses to the computer's server over the pairing link. The phone keeps its own copy of the raw media.

## 8. Security

- The local server listens only on `127.0.0.1`. Phone pairing adds a single-use QR token and HTTPS from mkcert.
- Hosted mode uses OAuth for MCP clients and per-learner row-level access.
- Export and delete are real tools that cover everything, media included.
