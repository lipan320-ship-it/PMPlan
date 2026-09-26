# Quarter Subtask Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to drag a whole subtask bar in the quarter overview to shift its date range by whole days while preserving its duration.

**Architecture:** Reuse the existing date-only manipulation helpers and `BoardPage` persistence path. Add a focused Pointer Events interaction to the compact quarter bar with a 4px movement threshold, a minimum hit target for narrow bars, a date preview during movement, and click-through editing when no drag occurs. Keep edge resizing out of quarter mode.

**Tech Stack:** React 19, TypeScript, Vitest, React Testing Library, existing Tauri/SQLite storage gateway.

## Global Constraints

- Quarter mode remains transient UI state and does not change the persisted `ViewMode` or data schema.
- Dragging shifts both `startDate` and `endDate` by the same whole-day offset; a null `endDate` remains null.
- A pointer movement below 4px remains a normal click and opens the existing edit dialog.
- Quarter bars must not start outer timeline panning while they are being dragged.
- Existing week, biweek, month, pan, resize, dependency, and JSON behaviors remain unchanged.

---

### Task 1: Add quarter drag interaction coverage

**Files:**
- Modify: `src/features/board/quarterOverview.test.tsx`

**Interfaces:**
- Exercise the existing `MemoryStorageGateway` through `App`; identify the quarter bar with `data-testid="quarter-subtask-<id>"`.

- [x] Add a test that sends a pointer down/move/up equivalent to two quarter days and verifies both task dates shift together in storage.
- [x] Add a test that sends a sub-threshold pointer gesture and verifies the existing edit dialog still opens.
- [x] Add a test for a single-day task that verifies the quarter bar exposes a drag hit target wider than its visual marker.
- [x] Run `npx.cmd vitest run src/features/board/quarterOverview.test.tsx` and confirm the new tests fail before implementation.

### Task 2: Implement the compact quarter drag behavior

**Files:**
- Modify: `src/features/board/QuarterTimeline.tsx`
- Modify: `src/features/board/BoardPage.tsx:2199-2212`
- Modify: `src/styles.css` near the quarter bar rules

**Interfaces:**
- Add `onDirectUpdate: (mother: MotherTask, subTask: SubTask, update: DateRangeUpdate) => void` to quarter row props.
- Use `moveSubTask` and `pixelsToDayOffset` from `directManipulation.ts`.

- [x] Pass `handleDirectUpdate` from `BoardPage` into `QuarterTimelineRows`.
- [x] Add a local quarter interaction ref storing `pointerId`, initial x, movement flag, and day offset.
- [x] Capture the pointer on the bar, update a preview using `moveSubTask`, and commit only after a moved pointer is released.
- [x] Suppress the following click after a drag; preserve normal click-to-edit behavior otherwise.
- [x] Render the preview dates as an accessible status element and update the title to explain drag-to-shift behavior.
- [x] Add an invisible or padded hit target so single-day bars remain draggable without changing their 6px visual marker.
- [x] Keep the bar marked with `data-no-pan="true"` and use `touch-action: none` during the direct interaction.
- [x] Run the focused quarter tests and confirm they pass.

### Task 3: Document and verify the delivered behavior

**Files:**
- Modify: `docs/iterations/2026-09-23-quarter-overview.md`
- Modify: `CHANGELOG.md`

- [x] Update the quarter overview scope and completion notes from read-only task bars to whole-bar date shifting with click-to-edit fallback.
- [x] Record the narrow-bar hit target and the intentional omission of edge resizing.
- [x] Run `npm.cmd run typecheck`, `npx.cmd eslint src`, the full Vitest suite, `npm.cmd run build`, and `git diff --check`.
- [x] Inspect the final diff and confirm no Rust/SQLite/schema changes were introduced.
