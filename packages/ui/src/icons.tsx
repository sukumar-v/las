/** Small inline icons drawn with currentColor; shapes only, no style. */
const P: Record<string, string> = {
  check: "M5 12l4 4L19 7",
  back: "M15 5l-7 7 7 7",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  play: "M8 5v14l11-7z",
  cam: "M4 8h3l2-2h6l2 2h3v10H4z M12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M6 11a6 6 0 0 0 12 0 M12 17v4",
  code: "M8 8l-4 4 4 4 M16 8l4 4-4 4 M14 5l-4 14",
  flag: "M5 21V4h11l-1.5 3L16 10H5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2",
  repeat: "M4 10a8 8 0 0 1 14-4l2 2 M20 14a8 8 0 0 1-14 4l-2-2 M18 4v4h-4 M6 20v-4h4",
  heart: "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  care: "M12 21s-8-5-8-11a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 6-8 11-8 11z M9 11h6 M12 8v6",
  spark: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  speech: "M4 5h16v10H9l-5 4z",
  pencil: "M4 20l4-1 11-11-3-3L5 16z M13 6l3 3",
  people: "M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M2 20a6 6 0 0 1 12 0 M12 20a6 6 0 0 1 10 0",
  book: "M4 5h7a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z M20 5h-7a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h7z",
  look: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  warn: "M12 3l10 18H2z M12 10v5 M12 18v.5",
  x: "M6 6l12 12 M18 6L6 18",
  dumbbell: "M3 10v4 M6 8v8 M18 8v8 M21 10v4 M6 12h12",
  music: "M9 18V6l10-2v12 M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M19 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  pause: "M8 5v14 M16 5v14",
  phone: "M7 3h10v18H7z M11 18h2"
};

export function Icon({ name, size = "ic" }: { name: string; size?: "ic" | "sm" }) {
  const d = P[name] ?? P.spark;
  return (
    <svg class={`las-ic${size === "sm" ? " sm" : ""}`} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d={d} />
    </svg>
  );
}
export const ICON_NAMES = Object.keys(P);
