/**
 * Tracking tools (mcp-and-data §2 Track): practice outside the app, pain, asking why again, and the learner's
 * own data: export and delete are real tools that cover everything, media included (mcp-and-data §8).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LasContext } from "../context.js";
import { loadSk, LoopError } from "./common.js";
import { completeMilestone } from "./proof.js";
import { scheduleCheckins } from "./checkins.js";
import { handleEvent } from "./sessions.js";
import { startIntake } from "./intake.js";
import { loopSettings } from "./settings.js";

/**
 * log_external: practice done outside the app counts toward the time log (and so the mix and the "gone quiet"
 * clock). "I did it outside the app" (`milestoneDone`) marks the milestone done, flagged as self-reported:
 * the system trusts the learner by default (learning loop §9 step 6).
 */
export function logExternal(ctx: LasContext, sk: string, minutes: number, note = "", opts: { category?: string; milestoneDone?: boolean } = {}, now = new Date()) {
  const st = loadSk(ctx, sk);
  const e = st.enrollment.id;
  if (!(minutes >= 0)) throw new LoopError("Minutes must be a number of minutes.");
  if (minutes > 0) ctx.store.logTime(e, minutes, "external", opts.category, note.slice(0, 500));
  ctx.store.logEvent(e, "external.logged", { minutes, note, category: opts.category, milestoneDone: !!opts.milestoneDone });
  let milestone: { id: string; title: string; selfReported: boolean } | undefined;
  if (opts.milestoneDone) {
    const m = st.milestone;
    if (!m) throw new LoopError("There's no active milestone to mark done.");
    ctx.store.addProof(e, m.id, undefined, { passed: true, selfReported: true, note });
    completeMilestone(ctx, st, m, true, now);
    milestone = { id: m.id, title: m.title, selfReported: true };
  }
  if (st.enrollment.status === "active") scheduleCheckins(ctx, e, now);
  return { sk: e, minutes, note, milestone };
}

/** report_pain: lowers intensity now, schedules a follow-up, points to a professional if it lasts. */
export async function reportPain(ctx: LasContext, sk: string, area: string, level: number, now = new Date()) {
  const st = loadSk(ctx, sk);
  return handleEvent(ctx, { type: "pain.reported", sk: st.enrollment.id, area, level: Math.max(1, Math.min(5, Math.round(level))) }, now);
}

/** revisit_why: the why and six-month questions again for this skill, then the next milestone. */
export async function revisitWhy(ctx: LasContext, sk: string) {
  const st = loadSk(ctx, sk);
  ctx.store.deletePendingCheckins(st.enrollment.id, "revisit-why");
  return startIntake(ctx, st.modelId, { revisitSk: st.enrollment.id });
}

function mediaOf(ctx: LasContext, enrollmentId?: string): { attempts: string[]; files: string[] } {
  const rows = enrollmentId ? ctx.store.db.all("SELECT id, media_ref FROM attempt WHERE enrollment_id = ?", enrollmentId) : ctx.store.db.all("SELECT id, media_ref FROM attempt");
  const files: string[] = [];
  for (const r of rows) {
    if (r.media_ref) files.push(r.media_ref as string);
    const ev = join(ctx.config.mediaDir, r.id as string, "evidence.json");
    if (existsSync(ev)) files.push(ev);
  }
  return { attempts: rows.map((r) => r.id as string), files };
}

/** export_data: everything (or one skill) as one JSON file under the data folder; media files are listed, not copied. */
export function exportData(ctx: LasContext, scope: string, now = new Date()) {
  const e = scope === "all" ? undefined : loadSk(ctx, scope).enrollment.id;
  const tables = ctx.store.exportAll({ enrollmentId: e });
  const sessions = (tables.session ?? []).map((s) => s.id as string);
  tables.planner_log = sessions.length ? ctx.store.db.all(`SELECT * FROM planner_log WHERE session_id IN (${sessions.map(() => "?").join(",")})`, ...sessions) : [];
  if (e) tables.setting = tables.setting.filter((s) => String(s.key).includes(e));
  const media = mediaOf(ctx, e).files;
  const dir = join(ctx.config.dataDir, "exports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `las-export-${e ?? "all"}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ exportedAt: now.toISOString(), scope: e ?? "all", version: ctx.config.version, tables, media }, null, 2));
  return { file, scope: e ?? "all", counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), media };
}

/** delete_data: one skill or everything, media files included. Needs `confirm: true`; it can't be undone. */
export function deleteData(ctx: LasContext, scope: string, confirm: boolean) {
  if (!confirm) throw new LoopError(`Deleting ${scope === "all" ? "everything" : "this skill's data"} can't be undone, media included. Ask the learner, then call again with confirm: true (export_data first if they want a copy).`);
  const e = scope === "all" ? undefined : loadSk(ctx, scope).enrollment.id;
  const media = mediaOf(ctx, e);
  if (e) {
    const sessions = ctx.store.db.all("SELECT id FROM session WHERE enrollment_id = ?", e).map((r) => r.id as string);
    for (const s of sessions) ctx.store.db.run("DELETE FROM planner_log WHERE session_id = ?", s);
    ctx.store.db.run("DELETE FROM setting WHERE key LIKE ?", `%.${e}`);
    ctx.store.db.run("DELETE FROM setting WHERE key LIKE ?", `%.${e}.%`);
    loopSettings.clearFor(ctx, e);
    ctx.store.deleteEnrollment(e);
  } else ctx.store.deleteEverything();
  let removed = 0;
  for (const f of media.files) {
    try {
      rmSync(f, { force: true });
      removed++;
    } catch {
      /* already gone */
    }
  }
  for (const id of media.attempts) rmSync(join(ctx.config.mediaDir, id), { recursive: true, force: true });
  return { scope: e ?? "all", deleted: true, mediaFilesRemoved: removed };
}
