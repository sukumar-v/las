/** Screens the snapshot route draws with fixture data, for the layout and contrast checks in e2e/snapshots.spec.ts. */
export const SNAPSHOT_SCREENS = [
  "onboarding-look",
  "onboarding-why",
  "onboarding-picture",
  "onboarding-probe",
  "onboarding-quiz",
  "onboarding-place",
  "onboarding-time",
  "onboarding-around",
  "onboarding-milestone",
  "onboarding-plan",
  "today-first-day",
  "today-missed",
  "today-proof-ready",
  "today-paused",
  "lesson",
  "recording-movement",
  "recording-audio",
  "recording-code",
  "feedback",
  "progress",
  "widget-today",
  "widget-feedback"
] as const;

export type SnapshotScreen = (typeof SNAPSHOT_SCREENS)[number];
