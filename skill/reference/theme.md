# Turning what the learner brings into a theme

LAS has no fixed visual design language. The learner picks the look; you turn it into a theme (data), LAS validates it and applies it to every screen, widget, figure and overlay.

## What they can bring

| Input | What you do |
|---|---|
| A design prompt pasted from a gallery or a DESIGN.md | `draft_theme({prompt})`. The prompt may be long and specific: read its palette, type, radii, shadows, motion and density and set the tokens yourself where the draft missed them. Never bundle or quote third-party prompts anywhere else. |
| A description ("cozy, like a paper notebook") | `draft_theme({description})`. If the draft's `questions` come back, ask at most one or two short visual questions. |
| A screenshot | Look at it yourself. Call `draft_theme({image_notes})` with what you see: the main background and surface colors (as hex if you can), text color, accent, font feel (serif, mono, rounded sans), corner radius, shadows, density, mood. LAS never sees the pixels. If your model is text-only, say so and ask for a description instead, or use a local vision model from `get_capabilities` if one is listed. |
| A tokens file (W3C design tokens JSON, CSS custom properties, a Tailwind config) | `draft_theme({tokens})`. Roles are mapped by name (background, foreground, primary, border, success, warning, error, font-*, radius). Check the result. |
| Nothing | Skip. The base theme is used. |

## The theme spec, in short

```json
{
  "name": "Paper Notebook",
  "modes": ["light"],
  "tokens": {
    "color": { "bg": "#F7F3EA", "surface": "#FFFDF7", "ink": "#22201C", "muted": "#6B655A", "line": "#D9D1C1", "accent": "#2F5D8A", "on_accent": "#FFFFFF", "good": "#2E7D4F", "warn": "#B4541E", "bad": "#A3262B", "focus": "#2F5D8A", "data": ["#2F5D8A", "#C07A1E", "#4E8F5B", "#8C4A7A", "#5E6B78"] },
    "type": { "display": { "family": "Fraunces", "fallback": "Georgia, serif", "weight": 600, "license": "OFL-1.1", "source": "https://fonts.googleapis.com/css2?family=Fraunces&display=swap" }, "body": { "family": "Literata", "fallback": "Georgia, serif", "license": "OFL-1.1", "source": "https://fonts.googleapis.com/css2?family=Literata&display=swap" }, "mono": { "family": "IBM Plex Mono", "fallback": "ui-monospace, monospace", "license": "OFL-1.1", "source": "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&display=swap" }, "scale": [13, 15, 17, 21, 27, 34] },
    "space": [4, 8, 12, 16, 24, 32],
    "radius": { "sm": 2, "md": 4, "lg": 8, "pill": 999 },
    "border": { "width": 1.5, "style": "solid" },
    "shadow": { "card": "none", "raised": "2px 2px 0 #22201C" },
    "density": "comfortable"
  },
  "components": { "card": "outlined", "button": "square", "chip": "outlined", "tile": "outlined", "progress": "steps", "route": "path", "meter": "ticks" },
  "motion": { "personality": "subtle", "duration_ms": 180, "easing": "ease-out" },
  "figures": { "stroke": 2, "corner": "round", "fill": "flat", "overlay": { "good": "good", "attention": "warn", "reference": "data.0" } },
  "texture": { "kind": "grain", "strength": 0.04 },
  "voice": "plain"
}
```

- Colors are roles. Components only reference roles, so any palette works everywhere, including overlays and charts.
- Variants come from a fixed menu: card `flat | outlined | raised | hard-shadow | glass`; button `pill | rounded | square | underline`; chip `filled | outlined | tag`; tile `flat | outlined | raised | hard-shadow`; progress `bar | dots | steps`; route `ladder | path | map | timeline`; meter `bar | ring | ticks`. A theme can't add CSS.
- Motion personality: `none | subtle | snappy | springy`. Texture: `none | grain | grid | dots | gradient` (CSS only). Voice picks a built-in copy set: `plain | warm | playful | terse`.
- Partial themes are fine: anything left out falls back to the base theme. A dark-only theme uses `modes: ["dark"]` with dark colors in `tokens`; a two-mode theme puts the dark colors under `dark.color`.
- Fonts: each family needs an allowed license (OFL-1.1, Apache-2.0, MIT, UFL-1.0, CC0-1.0, public-domain) and a `source` URL so LAS can cache it locally, or `license: "system"` to use the fallback stack. Check the font's own license before claiming one.

## Validate, preview, apply

- `validate_theme` checks WCAG AA contrast in every mode, that `good`/`warn`/`bad` reach 3:1, that the `data` series stay distinguishable for the common kinds of color blindness, the focus ring, touch targets, motion caps, font licenses and assets. Every failure comes with a suggested fix; `apply_fixes: true` stores the fixed theme when it passes. A theme that never passes is never applied.
- `preview_theme` shows the learner's own Today, a lesson card and a feedback card in the candidate theme. Show it before applying.
- `set_theme` applies it everywhere (`scope: "all"`) or to one skill (`scope: <sk>`). A learner can keep one look or give each skill its own.

## Edits

"Make it warmer", "less rounded", "bigger text": call `draft_theme` with the request as `description` and the current theme id as `base`, then validate and apply. Keep edits small; don't redesign.
