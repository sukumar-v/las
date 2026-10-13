# Learn Any Skill (LAS)

Design: `docs/DESIGN.md`, starting with `docs/design/any-skill.md`. Clickable prototype: `prototypes/app/index.html` (single file, no build step): onboarding, the first session, Today and Progress. It shows flows, not a visual style, and it hard-codes four example skills to show the UX; the product generates that content for any skill. Evaluator results in it are samples.

## Rules

- **Commits:** no attribution trailers in commit messages: no `Co-Authored-By: Claude` and no `Claude-Session:` line.
- **Open source only:** every dependency must be open source and free for anyone to use, including commercially. Allowed: MIT, BSD, ISC, Apache-2.0, public domain, OFL (fonts), CC-BY (data). MPL-2.0 is allowed with care. GPL tools are allowed only as optional external tools the learner installs, called as a separate process with a fallback. Not allowed: GPL/AGPL bundled or linked into LAS, non-commercial, source-available (FSL/BSL), custom model licenses, and proprietary hosted services as required dependencies. Check model weights separately from code. Record every new dependency in `docs/DESIGN.md` §11.
- **No fixed design language:** every color, font, radius, shadow, component treatment and figure style comes from the learner's theme (`docs/design/theming.md`). Never hard-code them. The prototype's look is a demo, not the product's style.
- **Show, don't tell:** learner-facing content is visual or interactive, with no essays.
- **General first:** never write code for a single skill. Per-skill content is a skill model (data) the agent writes at runtime; engines are general-purpose and configured by specs. Curated packs are optional. Every skill uses the same screens and standard answer types (`docs/design/any-skill.md`, `docs/DESIGN.md` §5.2, §6).
