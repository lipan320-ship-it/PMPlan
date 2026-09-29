# 项目规划文件与最近打开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PMPlan 以每个 JSON 为独立项目，启动恢复上次项目，支持最近 8 个项目，并把当前项目的规划修改自动回写到对应 JSON。

**Architecture:** Rust `Storage` 继续维护当前项目的 SQLite 工作缓存和事务校验，新增项目会话元数据、路径索引、文件指纹及原子 JSON 写入；所有规划数据变更通过统一保存包装回写活动 JSON。React 只通过 `StorageGateway` 调用项目命令，打开项目与导入 JSON 保持两套明确流程。

**Tech Stack:** React 19 + TypeScript、Tauri 2、Rust 2021、rusqlite、serde/serde_json、Vitest、Rust `cargo test`。

## Global Constraints

- 项目 JSON 继续使用当前 `version: "1.x"` 规划数据结构；不把视图设置加入 JSON。
- 最近项目最多保留 8 个规范化绝对路径；移除记录不删除源文件。
- 打开项目是切换独立 JSON；导入 JSON 仍是当前项目的覆盖/合并数据交换；导出 JSON 仍是另存副本。
- 任务、子任务、依赖、排序和展开状态修改成功后自动回写活动 JSON；保存失败不得显示保存成功。
- 写入前检查文件修改时间和内容哈希；外部修改、删除、只读和写入失败进入明确的未保存/冲突状态。
- 视图设置按项目路径保存；持久化 `ViewMode` 仍只有 `week | biweek | month`，季度总览仍为临时状态。
- 首次升级发现旧 SQLite 数据且没有活动路径时，保留未命名工作区并提供另存为 JSON 迁移。
- 不实现云同步、账号、多用户协作、JSON 历史版本或操作日志。

---

### Task 1: Add project-file primitives and SQLite metadata migration

**Files:**
- Create: `src-tauri/src/project_file.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/domain.rs`
- Modify: `src-tauri/src/storage.rs`
- Test: `src-tauri/src/project_file.rs` (unit tests)
- Test: `src-tauri/src/storage.rs` (migration and metadata tests)

**Interfaces:**
- Produces `FileFingerprint { modified_ns: i128, size: u64, content_hash: String }`.
- Produces `normalize_project_path(path: &Path) -> Result<PathBuf, ProjectFileError>` with Windows case-insensitive comparison handled by a normalized key.
- Produces `read_project_file(path: &Path) -> Result<(String, FileFingerprint), ProjectFileError>` and `write_project_file(path: &Path, content: &[u8], expected: Option<&FileFingerprint>) -> Result<FileFingerprint, ProjectFileError>`.
- Produces serializable domain types `ProjectState`, `RecentProject`, `ProjectSaveStatus` and `RecentProjectStatus` using camelCase keys.

- [ ] **Step 1: Write file primitive tests**

  Add tests that create a temporary `.json`, read a BOM-prefixed file, compute a stable fingerprint, reject a changed file when an expected fingerprint is supplied, and verify the replacement file contains the new UTF-8 JSON content.

- [ ] **Step 2: Run the focused Rust tests and verify failure**

  Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-rust.ps1 -Action test` after adding the test names. Expected result before implementation: compile failures for the missing file module and types.

- [ ] **Step 3: Implement normalized paths, fingerprints, and same-directory replacement**

  Add a BOM-tolerant reader, a deterministic FNV-1a content hash, metadata extraction for modification time and size, and a temp-file write in the target directory followed by replacement. Return a project-conflict error when the current fingerprint differs from `expected`.

- [ ] **Step 4: Add schema version 4 metadata tables**

  Extend `apply_migrations` in `storage.rs` with a repeatable migration that creates:

  ```sql
  CREATE TABLE project_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      active_path TEXT,
      workspace_mode TEXT NOT NULL DEFAULT 'unnamed_legacy',
      save_status TEXT NOT NULL DEFAULT 'saved',
      last_error TEXT,
      modified_ns TEXT,
      file_size INTEGER,
      content_hash TEXT
  );
  INSERT INTO project_state(singleton_id) VALUES (1);

  CREATE TABLE recent_projects (
      path TEXT PRIMARY KEY NOT NULL,
      last_opened_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      last_error TEXT,
      modified_ns TEXT,
      file_size INTEGER,
      content_hash TEXT
  );

  CREATE TABLE project_view_settings (
      path TEXT PRIMARY KEY NOT NULL,
      view_mode TEXT NOT NULL CHECK (view_mode IN ('week', 'biweek', 'month')),
      anchor_date TEXT NOT NULL,
      show_dependencies INTEGER NOT NULL CHECK (show_dependencies IN (0, 1)),
      task_column_width INTEGER NOT NULL,
      mother_sort_mode TEXT NOT NULL CHECK (mother_sort_mode IN ('manual', 'tag'))
  );
  ```

  Keep the existing singleton `view_settings` for the active runtime and unnamed workspace. Set `LATEST_SCHEMA_VERSION` to `4` and reject databases newer than that version.

- [ ] **Step 5: Run focused Rust tests and commit**

  Run `cargo test --manifest-path src-tauri/Cargo.toml project_file storage::tests::initializes_an_empty_board -q` and `git diff --check`. Commit with `feat(storage): add project metadata and file primitives`.

### Task 2: Implement project session, switching, auto-save, and legacy migration

**Files:**
- Modify: `src-tauri/src/storage.rs`
- Modify: `src-tauri/src/transfer.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/storage.rs`
- Test: `src-tauri/src/transfer.rs`
- Test: `src-tauri/src/commands.rs`

**Interfaces:**
- Adds `Storage::project_state() -> Result<ProjectState, StorageError>`.
- Adds `Storage::open_project(path: &Path) -> Result<ProjectState, StorageError>`.
- Adds `Storage::create_project(path: &Path) -> Result<ProjectState, StorageError>`.
- Adds `Storage::save_active_project() -> Result<ProjectState, StorageError>` and `Storage::save_as_project(path: &Path) -> Result<ProjectState, StorageError>`.
- Adds `Storage::remove_recent_project(path: &Path) -> Result<(), StorageError>`.
- Adds Tauri commands `get_project_state`, `open_project`, `create_project`, `save_active_project`, `save_as_project`, and `remove_recent_project`.

- [ ] **Step 1: Write switching and isolation tests**

  Add Rust tests that write two valid JSON files A and B, open A, create a task, assert A changed, open B, create a different task, assert B contains only B's task and A remains unchanged, reopen the `Storage` instance, and assert the last active path is B.

- [ ] **Step 2: Write failure and migration tests**

  Add tests for invalid JSON leaving the current board unchanged, an external file change producing a project conflict, a failed save retaining the current cache with `save_status = unsaved/error`, MRU capping at eight normalized paths, per-path view settings, and an old SQLite board that can be saved as a first JSON project without deleting the original tasks.

- [ ] **Step 3: Add `Storage` project-session state**

  Extend `Storage` with the active normalized path and baseline fingerprint. On initialization, read `project_state.active_path`; if it exists, attempt to validate and load that JSON into the cache. Record invalid/missing status without clearing the legacy cache or silently creating a replacement project.

- [ ] **Step 4: Implement project open/create/save operations**

  `open_project` must read and fully validate the JSON before beginning a transaction, replace current tasks through the existing overwrite preparation path, load the path-specific view settings or the current defaults, update the active metadata and MRU order, and return the new state. `create_project` must write a valid empty JSON before switching. `save_as_project` must export the current board, atomically write the new path, then change the active path and MRU entry. `remove_recent_project` only deletes metadata.

- [ ] **Step 5: Wrap every planning mutation with automatic persistence**

  After the existing SQL mutation commits, call one shared `persist_active_project` helper from mother-task CRUD, sub-task CRUD, reorder methods, dependency updates, and import application. The helper checks the baseline fingerprint, writes the full exported board to the active JSON, updates metadata on success, and records a save error on failure. Unnamed legacy workspaces continue to persist only in SQLite until a save-as operation.

- [ ] **Step 6: Bind view settings to project paths**

  Update `save_view_settings` to upsert `project_view_settings` when a named project is active while preserving the runtime singleton row. `open_project` loads the matching row, and missing rows use current defaults without changing the JSON document.

- [ ] **Step 7: Register Tauri commands and run Rust tests**

  Register all project commands in `src-tauri/src/lib.rs`, map project conflict/save errors to stable command error codes, and run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-rust.ps1 -Action test`. Commit with `feat(storage): bind mutations to active project files`.

### Task 3: Extend TypeScript domain and storage gateways

**Files:**
- Create: `src/storage/projectTypes.ts`
- Modify: `src/storage/gateway.ts`
- Modify: `src/storage/tauriGateway.ts`
- Modify: `src/storage/memoryGateway.ts`
- Modify: `src/storage/memoryGateway.test.ts`
- Modify: `src/domain/models.ts` only if shared save-status types are needed

**Interfaces:**
- `ProjectState` has `activePath: string | null`, `activeName: string | null`, `workspaceMode`, `saveStatus`, `lastError`, and `recent: RecentProject[]`.
- `RecentProject` has `path`, `name`, `parentPath`, `status`, `lastError`.
- `StorageGateway` adds `getProjectState`, `openProject`, `createProject`, `saveActiveProject`, `saveAsProject`, and `removeRecentProject`.

- [ ] **Step 1: Add gateway contract tests**

  Extend `memoryGateway.test.ts` with an A/B project test, MRU cap test, per-path view setting test, and save-status error test using temporary in-memory project documents.

- [ ] **Step 2: Implement Memory gateway project behavior**

  Keep browser tests deterministic by storing named projects in a `Map<string, BoardSnapshot>` keyed by normalized path, returning the same `ProjectState` shape, and treating project saves as successful in memory. Existing content-based browser import remains unchanged.

- [ ] **Step 3: Implement Tauri gateway invocations**

  Add typed `invoke` calls for all project commands. Path arguments must be passed only through gateway methods; no component may construct filesystem commands or write files directly.

- [ ] **Step 4: Run TypeScript tests and typecheck**

  Run `npm.cmd test -- --run src/storage/memoryGateway.test.ts` and `npm.cmd run typecheck`. Commit with `feat(gateway): expose project session operations`.

### Task 4: Add project selector, startup state, and save-status UI

**Files:**
- Modify: `src/features/board/BoardPage.tsx`
- Modify: `src/styles.css`
- Modify: `src/App.test.tsx`
- Create: `src/features/board/ProjectMenu.tsx` only if extracting the selector keeps `BoardPage` focused

**Interfaces:**
- `BoardPage` loads `gateway.getProjectState()` beside `gateway.loadBoard()`.
- Project actions call only the gateway methods from Task 3.
- Existing `ImportDialog` remains the only UI for overwrite/merge import.

- [ ] **Step 1: Add failing UI tests**

  Add tests for displaying the active file name, opening a recent project without invoking import overwrite/merge, creating a project through a save path, showing eight recent entries at most, and rendering a save error/foreign-change status without claiming success.

- [ ] **Step 2: Add project menu and toolbar actions**

  Replace the static planner header title with a project selector showing the JSON file name and parent path. Add `打开项目`, `新建项目`, recent entries, and `移除最近记录`; keep `导入 JSON` and `导出 JSON` labels and behavior unchanged.

- [ ] **Step 3: Add Tauri dialogs and browser fallbacks**

  Use the existing Tauri `open` dialog for project opening and `save` dialog for new/save-as. In browser tests, project commands use the memory gateway and the existing file input continues to serve content import.

- [ ] **Step 4: Synchronize board after project actions and save failures**

  After a successful open/create/save-as, reload the board and project state. When a mutation command returns a save or conflict error after the SQL change, reload the board before showing the error so the UI does not revert committed cache data. Add actions for retry, reload external file, and save-as where the state requires them.

- [ ] **Step 5: Add compact status styling and run UI tests**

  Add styles for project menu, recent item status, and `已保存/保存中/未保存/外部已修改` states without changing the existing timeline layout. Run `npm.cmd test -- --run src/App.test.tsx` and `npm.cmd run lint`.

- [ ] **Step 6: Commit the UI slice**

  Run `git diff --check` and commit with `feat(ui): add recent project selector and save status`.

### Task 5: Update requirements, ADRs, guide, and acceptance evidence

**Files:**
- Modify: `docs/requirements/planning-board-prd.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/requirements/v0.1-acceptance-matrix.md`
- Modify: `docs/decisions/ADR-0001-local-first-tauri-desktop.md`
- Modify: `docs/decisions/ADR-0002-rust-sqlite-storage-boundary.md`
- Create: `docs/decisions/ADR-0003-project-file-persistence.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the authoritative PRD**

  Add project identity, recent list, startup recovery, automatic source-file writeback, external file conflict handling, legacy migration, and the explicit distinction between open/import/export. Preserve the current overwrite/merge import requirements.

- [ ] **Step 2: Update user-facing instructions**

  Explain how to open, create, switch, remove a recent entry, recover an invalid path, handle unsaved/conflict states, and distinguish import from opening a project.

- [ ] **Step 3: Add ADR-0003 and supersession notes**

  Record JSON as the user-visible project file, SQLite as the active transactional cache, same-directory atomic write, fingerprint checks, and the fact that the old single-database/direct-JSON decision is superseded only for named project persistence.

- [ ] **Step 4: Extend the acceptance matrix and changelog**

  Add the A/B isolation, MRU, startup restore, view-setting isolation, save failure, external modification, and legacy migration rows. Mark desktop permission/visual checks Pending when the environment cannot provide evidence.

- [ ] **Step 5: Run markdown checks and commit docs**

  Run `npm.cmd run lint:md` and `git diff --check`. Record pre-existing markdown failures separately, then commit with `docs: document project file persistence`.

### Task 6: Full verification and closeout

**Files:**
- Modify only files required by failing verification; do not alter unrelated `.agents` or `.codebuddy` markdown.

- [ ] **Step 1: Run focused Rust and TypeScript suites**

  Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-rust.ps1 -Action test`, `npm.cmd test`, and `npm.cmd run typecheck`.

- [ ] **Step 2: Run lint, build, and diff checks**

  Run `npm.cmd run lint`, `npm.cmd run build`, `npm.cmd run lint:md`, `git diff --check`, and `git status --short --branch`.

- [ ] **Step 3: Perform the file-level A/B smoke test**

  In a temporary data directory, create A and B JSON files, open A, modify and save, open B, modify and save, reopen the application storage, and compare parsed JSON contents. Confirm A and B contain only their own modifications and the last active path is B.

- [ ] **Step 4: Review the final diff**

  Confirm no source path is hard-coded in UI code, no quarter `ViewMode` migration was introduced, import overwrite/merge tests still pass, and no user source file is removed by recent-item cleanup.

- [ ] **Step 5: Commit the verified closeout**

  Commit any final test-only or evidence changes with a focused message and report exact commands, passes, pre-existing failures, and any desktop visual checks that remain Pending.
