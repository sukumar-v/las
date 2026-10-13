import type { Theme } from "./schema.js";

/**
 * The one neutral, accessible base theme. Used before the learner chooses, for anything a
 * theme leaves out, and whenever validation fails. Deliberately plain: system fonts, grays,
 * one accent, no texture. It is a fallback, not a house style.
 */
export const BASE_THEME: Theme = {
  schemaVersion: 1,
  id: "base",
  name: "Base",
  source: { kind: "base", note: "LAS neutral base theme" },
  modes: ["light", "dark"],
  tokens: {
    color: {
      bg: "#F4F4F5",
      surface: "#FFFFFF",
      ink: "#18181B",
      muted: "#52525B",
      line: "#C4C4CC",
      accent: "#1D4ED8",
      on_accent: "#FFFFFF",
      good: "#15803D",
      warn: "#B45309",
      bad: "#B91C1C",
      focus: "#1D4ED8",
      data: ["#1D4ED8", "#B45309", "#0F766E", "#7E22CE", "#52525B"]
    },
    type: {
      display: { family: "system-ui", fallback: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", weight: 700, license: "system" },
      body: { family: "system-ui", fallback: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", license: "system" },
      mono: { family: "ui-monospace", fallback: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", license: "system" },
      scale: [13, 16, 18, 21, 26, 32],
      line_height: 1.45
    },
    space: [4, 8, 12, 16, 24, 32],
    radius: { sm: 4, md: 8, lg: 12, pill: 999 },
    border: { width: 1, style: "solid" },
    shadow: { card: "none", raised: "0 2px 8px rgba(0,0,0,0.12)" },
    density: "comfortable"
  },
  dark: {
    color: {
      bg: "#111113",
      surface: "#1C1C20",
      ink: "#F4F4F5",
      muted: "#B4B4BC",
      line: "#3F3F46",
      accent: "#93B4FF",
      on_accent: "#0B1020",
      good: "#4ADE80",
      warn: "#FBBF24",
      bad: "#F87171",
      focus: "#93B4FF",
      data: ["#93B4FF", "#FDBA74", "#2DD4BF", "#F9A8D4", "#A1A1AA"]
    },
    shadow: { card: "none", raised: "0 2px 8px rgba(0,0,0,0.5)" }
  },
  components: { card: "outlined", button: "rounded", chip: "outlined", tile: "outlined", progress: "bar", route: "ladder", meter: "bar" },
  motion: { personality: "subtle", duration_ms: 160, easing: "ease-out" },
  figures: { stroke: 2, corner: "round", fill: "flat", overlay: { good: "good", attention: "warn", reference: "data.0", neutral: "muted" } },
  texture: { kind: "none", strength: 0 },
  voice: "plain"
};
