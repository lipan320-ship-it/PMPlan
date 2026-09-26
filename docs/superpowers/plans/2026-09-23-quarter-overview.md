# Continuous Quarter Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a transient, screenshot-inspired 90–92-day overview to the planning board while keeping the existing day-precision views and task data unchanged.

**Architecture:** Keep `ViewMode` and persisted `ViewSettings` limited to `week | biweek | month`. Add pure quarter-range/coordinate helpers, then render a read-only semantic timeline branch inside the existing board shell. The overview uses month bands and weekly ticks, maps bars by continuous date distance, and opens the existing date editor rather than enabling low-resolution drag/resize.

**Tech Stack:** React 19, TypeScript, Vitest, React Testing Library, existing date-only utilities and CSS.

## Global Constraints

- The authoritative task dates remain `YYYY-MM-DD` date-only values; switching overview must not mutate tasks, dependencies, ordering, or JSON transfer data.
- The overview window preserves the current arbitrary `anchorDate` and spans 90–92 inclusive days (three-calendar-month anniversary, clamped to that range).
- Existing week/biweek/month rendering, day snapping, panning, persistence, and dependency behavior must remain unchanged.
- New behavior is local-only and must pass the repository web checks; no Rust/SQLite schema migration is included.

---

### Task 1: Quarter range and coordinate primitives

**Files:**
- Create: `src/features/board/quarterOverview.ts`
- Create: `src/features/board/quarterOverview.test.ts`
- Modify: `src/domain/dateOnly.ts` only if a reusable date-only helper is required (prefer existing `addMonths`, `daysInMonth`, `addDays`, and `diffDays`)

**Interfaces:**
- Produce `QUARTER_MIN_DAYS`, `QUARTER_MAX_DAYS`, `getQuarterOverviewRange(anchorDate)`, `buildQuarterMonthBands(range)`, `buildQuarterWeekTicks(range)`, `getQuarterBarGeometry(startDate, endDate, range, pixelsPerDay)`, and `getQuarterDateAtOffset(offset, range, pixelsPerDay)`.
- Month bands expose `key`, `label`, `startOffset`, and `dayCount`; week ticks expose `date` and `dayOffset`.

- [x] **Step 1: Write failing pure tests** for 90/91/92-day rolling windows, cross-year and leap-month boundaries, month proportions, Monday weekly ticks, date-to-pixel geometry/clipping, minimum single-day marker width, and x-to-date clamping.
- [x] **Step 2: Run the focused test** and confirm the implementation now passes.
- [x] **Step 3: Implement the helpers** using date-only arithmetic. Preserve the supplied anchor; derive a three-month anniversary with day clamping, then clamp the inclusive window length to 90–92 days. Never use local-time `Date` parsing for task dates.
- [x] **Step 4: Run the focused test again** and confirm all range/geometry tests pass.

### Task 2: Read-only semantic quarter renderer

**Files:**
- Create: `src/features/board/QuarterTimeline.tsx`
- Modify: `src/features/board/BoardPage.tsx:68-72,445-461,523-536,1115-1285,1455-2065`
- Modify: `src/styles.css` near the timeline header/grid/bar rules

**Interfaces:**
- `QuarterTimelineRows` consumes the existing `BoardRow[]`, `ViewRange`, `pixelsPerDay`, `timelineWidth`, focus callbacks, task edit/quick-add callbacks, and the existing dependency layer’s coordinate contract.
- It produces month-band/week-tick headers and row backgrounds with no per-day grid cells. Subtask bars are selectable/read-only; exact editing delegates to the existing dialog.

- [x] **Step 1: Add a failing RTL test** that toggles `季度总览`, expects a 90–92-day period, month-band labels, weekly tick labels, and a date-proportional bar; also assert clicking a quarter subtask opens the existing editor and does not change stored dates.
- [x] **Step 2: Run the focused RTL test** and confirm the overview control/markup is absent before wiring.
- [x] **Step 3: Add transient `quarterOverview` state** in `BoardPage`, calculate an active range/pixels-per-day, use the active day count for period paging and “今天”, and add a `季度总览` toggle without changing persisted `ViewMode`.
- [x] **Step 4: Implement `QuarterTimelineRows`** with month bands, weekly ticks, today marker, continuous bar geometry, single-day minimum markers, exact titles/ARIA labels, mother-row double-click date mapping, and read-only subtask buttons that open the current editor.
- [x] **Step 5: Keep the existing detail branch intact** and use a distinct overview CSS namespace. Ensure the outer pan/wheel handlers use pixels-per-day and do not start from quarter bars.
- [x] **Step 6: Add responsive styles** so a measured wide viewport shows the full range without horizontal overflow, while narrow layouts retain readable labels and allow the existing board scroll container to handle overflow.
- [x] **Step 7: Run the focused RTL test and existing timeline tests**; fix any regressions before moving on.

### Task 3: Regression, documentation, and verification

**Files:**
- Modify: `src/features/board/timelinePan.test.tsx` or create `src/features/board/quarterOverview.test.tsx` for integration coverage
- Modify: `docs/iterations/README.md` or add `docs/iterations/2026-09-23-quarter-overview.md`
- Modify: `CHANGELOG.md` with the user-facing behavior change

- [x] **Step 1: Add regression cases** for switching back to a detail mode, preserving the anchor and task snapshot, cross-month bars, no daily cells in overview, and existing detail behavior.
- [x] **Step 2: Run `npm.cmd run typecheck`, focused/full Vitest suites, `npx.cmd eslint src`, and `npm.cmd run build`**; record the pre-existing markdown-lint limitation explicitly.
- [x] **Step 3: Run `git diff --check` and inspect the final diff** for accidental persisted-schema changes or unrelated edits.
- [x] **Step 4: Document the delivered scope and verification evidence** in the iteration note, requirements, user guide, and changelog.

## Self-review

- The design covers the confirmed continuous 90–92-day requirement without adding a fourth persisted Rust enum value.
- Geometry and interaction use separate overview coordinates; existing day-based direct manipulation is not reused with weekly widths.
- Tests cover month/year/leap boundaries, clipping, navigation, rendering, and no data mutation.
- No unresolved placeholders or unrelated refactors are included.
