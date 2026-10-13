import { z } from "zod";

const hex = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, "a hex color like #2F5D8A");

export const FONT_LICENSES = ["OFL-1.1", "Apache-2.0", "MIT", "UFL-1.0", "CC0-1.0", "public-domain", "system"] as const;

export const FontSchema = z.object({
  family: z.string().min(1).max(60),
  fallback: z.string().min(1).max(120),
  weight: z.number().int().min(100).max(900).optional(),
  license: z.enum(FONT_LICENSES),
  /** where to fetch the family for the local cache; omitted for system fonts */
  source: z.string().url().optional()
});
export type ThemeFont = z.infer<typeof FontSchema>;

export const ColorTokensSchema = z.object({
  bg: hex,
  surface: hex,
  ink: hex,
  muted: hex,
  line: hex,
  accent: hex,
  on_accent: hex,
  good: hex,
  warn: hex,
  bad: hex,
  focus: hex,
  /** chart and overlay series, 3 to 8 */
  data: z.array(hex).min(3).max(8)
});
export type ColorTokens = z.infer<typeof ColorTokensSchema>;

export const TypeTokensSchema = z.object({
  display: FontSchema,
  body: FontSchema,
  mono: FontSchema,
  /** 6 sizes in px, ascending: small, body, lead, h3, h2, h1 */
  scale: z.array(z.number().min(10).max(80)).length(6),
  line_height: z.number().min(1.1).max(1.9).default(1.45)
});

export const TokensSchema = z.object({
  color: ColorTokensSchema,
  type: TypeTokensSchema,
  /** 6 spacing steps in px, ascending */
  space: z.array(z.number().min(0).max(96)).length(6),
  radius: z.object({ sm: z.number().min(0).max(40), md: z.number().min(0).max(40), lg: z.number().min(0).max(64), pill: z.number().min(0).max(999) }),
  border: z.object({ width: z.number().min(0).max(6), style: z.enum(["solid", "dashed", "dotted", "double"]).default("solid") }),
  shadow: z.object({ card: z.string().max(200), raised: z.string().max(200) }),
  density: z.enum(["compact", "comfortable", "roomy"]).default("comfortable")
});

/** The fixed menu of component variants. A theme picks one per component and can't add CSS of its own. */
export const COMPONENT_VARIANTS = {
  card: ["flat", "outlined", "raised", "hard-shadow", "glass"],
  button: ["pill", "rounded", "square", "underline"],
  chip: ["filled", "outlined", "tag"],
  tile: ["flat", "outlined", "raised", "hard-shadow"],
  progress: ["bar", "dots", "steps"],
  route: ["ladder", "path", "map", "timeline"],
  meter: ["bar", "ring", "ticks"]
} as const;
export type ComponentName = keyof typeof COMPONENT_VARIANTS;

export const ComponentsSchema = z.object({
  card: z.enum(COMPONENT_VARIANTS.card),
  button: z.enum(COMPONENT_VARIANTS.button),
  chip: z.enum(COMPONENT_VARIANTS.chip),
  tile: z.enum(COMPONENT_VARIANTS.tile),
  progress: z.enum(COMPONENT_VARIANTS.progress),
  route: z.enum(COMPONENT_VARIANTS.route),
  meter: z.enum(COMPONENT_VARIANTS.meter)
});

export const MotionSchema = z.object({
  personality: z.enum(["none", "subtle", "snappy", "springy"]).default("subtle"),
  duration_ms: z.number().min(0).max(1000).default(180),
  easing: z.string().max(80).default("ease-out")
});

export const FiguresSchema = z.object({
  stroke: z.number().min(0.5).max(8).default(2),
  corner: z.enum(["round", "square", "bevel"]).default("round"),
  fill: z.enum(["flat", "hatched", "outline"]).default("flat"),
  /** which color roles overlays use */
  overlay: z
    .object({
      good: z.string().default("good"),
      attention: z.string().default("warn"),
      reference: z.string().default("data.0"),
      neutral: z.string().default("muted")
    })
    .prefault({})
});

export const TextureSchema = z.object({
  kind: z.enum(["none", "grain", "grid", "dots", "gradient"]).default("none"),
  strength: z.number().min(0).max(1).default(0)
});

export const ThemeModeSchema = z.enum(["light", "dark"]);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

export const ThemeSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().optional(),
  name: z.string().min(1).max(60),
  source: z.object({ kind: z.enum(["prompt", "description", "image", "tokens", "base", "edit"]), note: z.string().max(200).optional() }).default({ kind: "description" }),
  modes: z.array(ThemeModeSchema).min(1).max(2).default(["light"]),
  tokens: TokensSchema,
  /** tokens for the second mode; anything missing falls back to `tokens` */
  dark: z.object({ color: ColorTokensSchema.partial(), shadow: z.object({ card: z.string(), raised: z.string() }).partial().optional() }).optional(),
  components: ComponentsSchema,
  motion: MotionSchema.prefault({}),
  figures: FiguresSchema.prefault({}),
  texture: TextureSchema.prefault({}),
  /** picks a built-in copy set; never writes new copy */
  voice: z.enum(["plain", "warm", "playful", "terse"]).default("plain")
});
export type Theme = z.infer<typeof ThemeSchema>;
export type ThemeInput = z.input<typeof ThemeSchema>;

/** A partial theme: what the agent drafts; anything missing falls back to the base theme. */
export const ThemePatchSchema = z.record(z.string(), z.unknown());
type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ThemePatch = DeepPartial<Theme>;
