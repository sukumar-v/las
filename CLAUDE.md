# Learn Any Skill (LAS)

Design: `docs/DESIGN.md`. Onboarding prototype: `prototypes/onboarding/index.html` (single file, no build step).

## Rules

- **Commits:** no attribution trailers in commit messages: no `Co-Authored-By: Claude` and no `Claude-Session:` line.
- **Open source only:** every dependency must be open source and free for anyone to use, including commercially. Allowed: MIT, BSD, ISC, Apache-2.0, public domain, OFL (fonts), CC-BY (data). MPL-2.0 is allowed with care. Not allowed: GPL/AGPL linked into LAS, non-commercial, source-available (FSL/BSL), custom model licenses, and proprietary hosted services as required dependencies. Check model weights separately from code. Record every new dependency in `docs/DESIGN.md` §11.
- **Show, don't tell:** learner-facing content is visual or interactive, with no essays.
- **One flow for every skill:** skill packs fill the same slots and use only the standard answer types (`docs/DESIGN.md` §5.2, §6).
