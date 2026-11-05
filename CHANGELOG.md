# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] — 2026-11-05

### Fixed

- The queue row above the composer renders this plugin's text slot with
  whitespace collapsed and a single-line ellipsis. The queued copy now stays a
  flat preview with the storage markers stripped, instead of growing quote
  blocks inside a one-line container.

## [1.0.1] — 2026-11-05

### Changed

- A long multi-quote message now shows its first two groups and folds the rest
  behind a `显示更多（还有 N 组）` control, the way Claude shows a long paste.
  Messages with one or two groups are unchanged.

## [1.0.0] — 2026-11-04

### Added

- Selection pill (`引用文本` / `Quote Text`) over any transcript selection.
- Reply popover with quote preview, unlimited input, `Enter` to add.
- 76×76 block tiles above the composer: two quote lines with a quote rule,
  two bottom-aligned answer lines, hover edit/remove.
- Compose-on-send: blocks become `│ quote / answer` pairs, your own typing last.
- Real quote rules in the transcript through a registered `text` renderer.
- Per-session queues; a session switch keeps every queue and the composer.
- Chinese and English copy that follows the DSH locale live.
- Headless jsdom suite (154 checks, six of them seeded property tests) and a
  Playwright suite against a real engine.

### Fixed

- Read the composer draft from `InputState.draft`: the previous field name never
  existed on the host, so the plugin silently fell back to DOM text.
- The send button is no longer taken over while a turn runs with an empty
  composer — that click is the host's Stop.
- Quote rules in the transcript are drawn with an inline-level box, matching the
  slot's inline contract (pixel-identical to the previous block layout).
- Declared `sessions` and `locale` in `inject`; a late-loading service used to
  route sends through the composer fallback without saying so.
- `engines.dsh` now names the 0.2.x host instead of an impossible 1.x range.
- ESLint config merges `js.configs.recommended`; the custom `rules` block had
  been replacing it wholesale, which hid `no-dupe-keys`.
