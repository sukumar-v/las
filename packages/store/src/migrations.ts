/** Schema migrations, applied in order. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE learner (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', timezone TEXT NOT NULL DEFAULT 'UTC',
  quiet_hours TEXT NOT NULL DEFAULT '{"start":22,"end":8}', nudge_limits TEXT NOT NULL DEFAULT '{"perDay":1,"perWeek":4}',
  created_at TEXT NOT NULL
);
CREATE TABLE skill_model (
  id TEXT PRIMARY KEY, skill TEXT NOT NULL, source TEXT NOT NULL, based_on_pack TEXT, pack_version TEXT,
  version INTEGER NOT NULL DEFAULT 1, json TEXT NOT NULL, validated_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX skill_model_skill ON skill_model(skill);
CREATE TABLE enrollment (
  id TEXT PRIMARY KEY, learner_id TEXT NOT NULL REFERENCES learner(id), skill_model_id TEXT NOT NULL REFERENCES skill_model(id),
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE theme (
  id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, name TEXT NOT NULL, source_kind TEXT NOT NULL, json TEXT NOT NULL,
  validated_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE theme_scope (
  learner_id TEXT NOT NULL, enrollment_id TEXT NOT NULL DEFAULT '', theme_id TEXT NOT NULL REFERENCES theme(id),
  PRIMARY KEY (learner_id, enrollment_id)
);
CREATE TABLE intake (
  id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, skill_model_id TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}',
  step TEXT NOT NULL DEFAULT 'why', placement TEXT, enrollment_id TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE intent (enrollment_id TEXT PRIMARY KEY, why TEXT NOT NULL, afterwards TEXT NOT NULL DEFAULT '', revisited_at TEXT);
CREATE TABLE constraints (
  enrollment_id TEXT PRIMARY KEY, minutes_per_week INTEGER NOT NULL DEFAULT 180, deadline TEXT, access TEXT NOT NULL DEFAULT '[]',
  injuries TEXT NOT NULL DEFAULT '[]', schedule TEXT NOT NULL DEFAULT '{}', location TEXT
);
CREATE TABLE milestone (
  id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, title TEXT NOT NULL, ladder_step INTEGER NOT NULL, proof TEXT NOT NULL,
  target_date TEXT, status TEXT NOT NULL DEFAULT 'active', achieved_at TEXT, self_reported INTEGER NOT NULL DEFAULT 0,
  kind TEXT, estimate_weeks INTEGER, feasibility TEXT, created_at TEXT NOT NULL
);
CREATE TABLE node_mastery (
  enrollment_id TEXT NOT NULL, node_id TEXT NOT NULL, p_known REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (enrollment_id, node_id)
);
CREATE TABLE review_card (
  id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, node_id TEXT NOT NULL, fsrs_state TEXT NOT NULL, due_at TEXT NOT NULL
);
CREATE INDEX review_card_due ON review_card(enrollment_id, due_at);
CREATE TABLE session (
  id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, planned_at TEXT, started_at TEXT, ended_at TEXT, plan TEXT NOT NULL,
  location TEXT, minutes REAL, summary TEXT, status TEXT NOT NULL DEFAULT 'planned'
);
CREATE INDEX session_enrollment ON session(enrollment_id, planned_at);
CREATE TABLE attempt (
  id TEXT PRIMARY KEY, session_id TEXT, enrollment_id TEXT NOT NULL, drill_id TEXT, milestone_id TEXT, kind TEXT NOT NULL,
  engine TEXT NOT NULL, spec_id TEXT, attempt_no INTEGER NOT NULL DEFAULT 1, media_ref TEXT, analysis TEXT, spec TEXT,
  prompt TEXT, created_at TEXT NOT NULL, analyzed_at TEXT
);
CREATE INDEX attempt_enrollment ON attempt(enrollment_id, created_at);
CREATE TABLE mistake_state (
  enrollment_id TEXT NOT NULL, mistake_id TEXT NOT NULL, state TEXT NOT NULL, last_seen_at TEXT, disputed_count INTEGER NOT NULL DEFAULT 0,
  clean_streak INTEGER NOT NULL DEFAULT 0, seen_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (enrollment_id, mistake_id)
);
CREATE TABLE checkin (
  id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, kind TEXT NOT NULL, due_at TEXT NOT NULL, sent_at TEXT, answered_at TEXT,
  answer TEXT, payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX checkin_due ON checkin(enrollment_id, due_at);
CREATE TABLE plan_change (id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, reason TEXT NOT NULL, option TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, enrollment_id TEXT, type TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE planner_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE time_log (id INTEGER PRIMARY KEY AUTOINCREMENT, enrollment_id TEXT NOT NULL, minutes REAL NOT NULL, category TEXT, source TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE pairing (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, used_at TEXT, device TEXT, expires_at TEXT NOT NULL);
CREATE TABLE push_subscription (id TEXT PRIMARY KEY, learner_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE dispute (id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, attempt_id TEXT NOT NULL, mistake_id TEXT NOT NULL, metrics TEXT NOT NULL, consent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE proof (id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, milestone_id TEXT NOT NULL, attempt_id TEXT, result TEXT NOT NULL, clip_ref TEXT, created_at TEXT NOT NULL);
CREATE TABLE metric_history (id INTEGER PRIMARY KEY AUTOINCREMENT, enrollment_id TEXT NOT NULL, metric_id TEXT NOT NULL, value REAL NOT NULL, attempt_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX metric_history_idx ON metric_history(enrollment_id, metric_id, created_at);
`
  }
];
