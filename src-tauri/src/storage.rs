use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use thiserror::Error;
use time::{format_description::well_known::Iso8601, Date, OffsetDateTime};
use uuid::Uuid;

use crate::domain::{
    BoardSnapshot, CreateSubTaskInput, MotherSortMode, MotherTask, ProjectSaveStatus, ProjectState,
    RecentProject, RecentProjectStatus, SubTask, UpdateSubTaskInput, ViewMode, ViewSettings,
    WorkspaceMode,
};
use crate::project_file::{
    normalize_project_path, read_project_file, write_project_file, FileFingerprint,
    ProjectFileError,
};

const INITIAL_MIGRATION: &str = r#"
CREATE TABLE mother_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    expanded INTEGER NOT NULL DEFAULT 1 CHECK (expanded IN (0, 1)),
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_mother_tasks_sort_order ON mother_tasks(sort_order, id);

CREATE TABLE sub_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    mother_task_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    start_date TEXT NOT NULL,
    end_date TEXT,
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mother_task_id) REFERENCES mother_tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_sub_tasks_mother_sort ON sub_tasks(mother_task_id, sort_order, id);

CREATE TABLE dependencies (
    task_id TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id),
    FOREIGN KEY (task_id) REFERENCES mother_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES mother_tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_dependencies_source ON dependencies(depends_on_task_id, task_id);

CREATE TABLE view_settings (
    singleton_id INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton_id = 1),
    view_mode TEXT NOT NULL DEFAULT 'biweek' CHECK (view_mode IN ('week', 'biweek', 'month')),
    anchor_date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
    show_dependencies INTEGER NOT NULL DEFAULT 1 CHECK (show_dependencies IN (0, 1))
);

INSERT INTO view_settings(singleton_id) VALUES (1);
"#;
const LATEST_SCHEMA_VERSION: i64 = 4;
const MOTHER_TAG_MAX_LENGTH: usize = 40;
const DEFAULT_TASK_COLUMN_WIDTH: i64 = 348;
const MIN_TASK_COLUMN_WIDTH: i64 = 240;
const MAX_TASK_COLUMN_WIDTH: i64 = 600;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Migration(String),
    #[error("database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("local data directory could not be prepared: {0}")]
    Io(#[from] std::io::Error),
    #[error("project file conflict: {0}")]
    ProjectConflict(String),
    #[error("project file operation failed: {0}")]
    ProjectFile(String),
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation_error",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "dependency_conflict",
            Self::Migration(_) => "migration_error",
            Self::Database(_) => "database_error",
            Self::Io(_) => "io_error",
            Self::ProjectConflict(_) => "project_conflict",
            Self::ProjectFile(_) => "project_file_error",
        }
    }
}

pub struct Storage {
    pub(crate) connection: Connection,
    pub(crate) suspend_persistence: bool,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let connection = Connection::open(path)?;
        let mut storage = Self::initialize(connection)?;
        storage.restore_active_project();
        Ok(storage)
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> Result<Self, StorageError> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn initialize(mut connection: Connection) -> Result<Self, StorageError> {
        connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
        )?;
        apply_migrations(&mut connection)?;
        Ok(Self {
            connection,
            suspend_persistence: false,
        })
    }

    pub fn load_board(&self) -> Result<BoardSnapshot, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, tag, expanded, sort_order FROM mother_tasks ORDER BY sort_order, id",
        )?;
        let mother_rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;

        let mut tasks = Vec::new();
        for mother_row in mother_rows {
            let (id, name, tag, expanded, sort_order) = mother_row?;
            tasks.push(MotherTask {
                depends_on: self.load_dependencies(&id)?,
                sub_tasks: self.load_sub_tasks(&id)?,
                id,
                name,
                tag,
                expanded,
                sort_order,
            });
        }

        Ok(BoardSnapshot {
            tasks,
            view_settings: self.load_view_settings()?,
        })
    }

    pub fn project_state(&self) -> Result<ProjectState, StorageError> {
        let (active_path, workspace_mode, save_status, last_error): (
            Option<String>,
            String,
            String,
            Option<String>,
        ) = self.connection.query_row(
            "SELECT active_path, workspace_mode, save_status, last_error
             FROM project_state WHERE singleton_id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let recent = self
            .connection
            .prepare(
                "SELECT path, status, last_error
                 FROM recent_projects ORDER BY last_opened_order DESC, path",
            )?
            .query_map([], |row| {
                let path: String = row.get(0)?;
                let status: String = row.get(1)?;
                let last_error: Option<String> = row.get(2)?;
                Ok((path, status, last_error))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let recent = recent
            .into_iter()
            .map(|(path, status, last_error)| {
                let path_value = PathBuf::from(&path);
                Ok(RecentProject {
                    name: path_value
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(&path)
                        .to_owned(),
                    parent_path: path_value
                        .parent()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_owned(),
                    path,
                    status: parse_recent_status(&status)?,
                    last_error,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;

        let active_path_value = active_path.clone().map(PathBuf::from);
        Ok(ProjectState {
            active_name: active_path_value.as_ref().and_then(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_owned)
            }),
            parent_path: active_path_value.as_ref().and_then(|path| {
                path.parent()
                    .and_then(|value| value.to_str())
                    .map(str::to_owned)
            }),
            active_path,
            workspace_mode: parse_workspace_mode(&workspace_mode)?,
            save_status: parse_save_status(&save_status)?,
            last_error,
            recent,
        })
    }

    pub fn open_project(&mut self, path: &Path) -> Result<ProjectState, StorageError> {
        let normalized = normalize_project_path(path).map_err(project_file_error)?;
        let (content, fingerprint) = match read_project_file(&normalized) {
            Ok(value) => value,
            Err(error) => {
                let status = if !normalized.exists() {
                    RecentProjectStatus::Missing
                } else {
                    classify_recent_failure(&error)
                };
                self.mark_recent_failure(&normalized, status)?;
                return Err(project_file_error(error));
            }
        };

        self.suspend_persistence = true;
        let imported = crate::transfer::ImportMode::Overwrite;
        let result = self.apply_import_content(&content, imported);
        self.suspend_persistence = false;
        if let Err(error) = result {
            self.mark_recent_failure(&normalized, RecentProjectStatus::Invalid)?;
            return Err(error);
        }

        self.set_active_project(&normalized, &fingerprint, ProjectSaveStatus::Saved, None)?;
        let settings = self
            .load_project_view_settings(&normalized)?
            .unwrap_or_else(default_view_settings);
        self.save_runtime_view_settings(&settings)?;
        self.project_state()
    }

    pub fn create_project(&mut self, path: &Path) -> Result<ProjectState, StorageError> {
        let normalized = normalize_project_path(path).map_err(project_file_error)?;
        if normalized.exists() {
            return Err(StorageError::ProjectConflict(
                "project file already exists; choose a new path or use Save As".to_owned(),
            ));
        }
        let content = crate::transfer::empty_project_json()?;
        let fingerprint =
            write_project_file(&normalized, &content, None).map_err(project_file_error)?;
        self.suspend_persistence = true;
        let result = self.apply_import_content(&content, crate::transfer::ImportMode::Overwrite);
        self.suspend_persistence = false;
        result?;
        self.set_active_project(&normalized, &fingerprint, ProjectSaveStatus::Saved, None)?;
        self.project_state()
    }

    pub fn save_active_project(&mut self) -> Result<ProjectState, StorageError> {
        let active_path = self.active_project_path()?.ok_or_else(|| {
            StorageError::Validation("no active project file; use Save As first".to_owned())
        })?;
        self.persist_project_at(&active_path)?;
        self.project_state()
    }

    pub fn save_as_project(&mut self, path: &Path) -> Result<ProjectState, StorageError> {
        let normalized = normalize_project_path(path).map_err(project_file_error)?;
        let board = self.load_board()?;
        let content = crate::transfer::export_board(&board)?;
        let fingerprint =
            write_project_file(&normalized, &content, None).map_err(project_file_error)?;
        self.set_active_project(&normalized, &fingerprint, ProjectSaveStatus::Saved, None)?;
        self.project_state()
    }

    pub fn remove_recent_project(&mut self, path: &Path) -> Result<(), StorageError> {
        let normalized = normalize_project_path(path).map_err(project_file_error)?;
        self.connection.execute(
            "DELETE FROM recent_projects WHERE path = ?1",
            [normalized.to_string_lossy().as_ref()],
        )?;
        Ok(())
    }

    pub fn persist_active_project(&mut self) -> Result<(), StorageError> {
        if self.suspend_persistence {
            return Ok(());
        }
        let Some(path) = self.active_project_path()? else {
            return Ok(());
        };
        self.persist_project_at(&path)
    }

    fn persist_project_at(&mut self, path: &Path) -> Result<(), StorageError> {
        let board = self.load_board()?;
        let content = crate::transfer::export_board(&board)?;
        let expected = self.project_fingerprint()?.ok_or_else(|| {
            StorageError::ProjectConflict("project baseline fingerprint is unavailable".to_owned())
        })?;
        self.set_save_status(ProjectSaveStatus::Saving, None)?;
        match write_project_file(path, &content, Some(&expected)) {
            Ok(fingerprint) => {
                self.update_project_fingerprint(&fingerprint, ProjectSaveStatus::Saved, None)?;
                Ok(())
            }
            Err(error) => {
                let status = if matches!(error, ProjectFileError::ExternalChange) {
                    ProjectSaveStatus::Conflict
                } else {
                    ProjectSaveStatus::Error
                };
                self.set_save_status(status, Some(error.to_string()))?;
                if matches!(error, ProjectFileError::ExternalChange) {
                    self.touch_recent(
                        &path.to_string_lossy(),
                        RecentProjectStatus::Conflict,
                        Some("project file changed outside PMPlan".to_owned()),
                    )?;
                }
                Err(project_file_error(error))
            }
        }
    }

    fn restore_active_project(&mut self) {
        let Ok(Some(path)) = self.active_project_path() else {
            return;
        };
        let result = self.open_project(&path);
        if let Err(error) = result {
            let status = classify_storage_failure(&error);
            let _ = self.mark_recent_failure(&path, status);
            let _ = self.set_save_status(ProjectSaveStatus::Error, Some(error.to_string()));
        }
    }

    fn active_project_path(&self) -> Result<Option<PathBuf>, StorageError> {
        self.connection
            .query_row(
                "SELECT active_path FROM project_state WHERE singleton_id = 1",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .map(|path| path.map(PathBuf::from))
            .map_err(Into::into)
    }

    fn project_fingerprint(&self) -> Result<Option<FileFingerprint>, StorageError> {
        self.connection
            .query_row(
                "SELECT modified_ns, file_size, content_hash
                 FROM project_state WHERE singleton_id = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?.map(|value| value as u64),
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map(|(modified_ns, size, hash)| {
                modified_ns
                    .zip(size)
                    .zip(hash)
                    .and_then(|((modified_ns, size), content_hash)| {
                        modified_ns
                            .parse::<i128>()
                            .ok()
                            .map(|modified_ns| FileFingerprint {
                                modified_ns,
                                size,
                                content_hash,
                            })
                    })
            })
            .map_err(Into::into)
    }

    fn set_active_project(
        &mut self,
        path: &Path,
        fingerprint: &FileFingerprint,
        status: ProjectSaveStatus,
        last_error: Option<String>,
    ) -> Result<(), StorageError> {
        let path = path.to_string_lossy().to_string();
        self.connection.execute(
            "UPDATE project_state
             SET active_path = ?1, workspace_mode = 'named_project', save_status = ?2,
                 last_error = ?3, modified_ns = ?4, file_size = ?5, content_hash = ?6
             WHERE singleton_id = 1",
            params![
                path,
                status.as_str(),
                last_error,
                fingerprint.modified_ns.to_string(),
                fingerprint.size as i64,
                fingerprint.content_hash
            ],
        )?;
        self.touch_recent(path.as_str(), RecentProjectStatus::Available, None)?;
        Ok(())
    }

    fn touch_recent(
        &mut self,
        path: &str,
        status: RecentProjectStatus,
        last_error: Option<String>,
    ) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO recent_projects(path, last_opened_order, status, last_error)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
               last_opened_order = excluded.last_opened_order,
               status = excluded.status,
               last_error = excluded.last_error",
            params![path, now_unix(), status.as_str(), last_error],
        )?;
        self.connection.execute(
            "DELETE FROM recent_projects
             WHERE path NOT IN (
                 SELECT path FROM recent_projects ORDER BY last_opened_order DESC, path LIMIT 8
             )",
            [],
        )?;
        Ok(())
    }

    fn mark_recent_failure(
        &mut self,
        path: &Path,
        status: RecentProjectStatus,
    ) -> Result<(), StorageError> {
        self.touch_recent(
            &path.to_string_lossy(),
            status,
            Some("project file could not be opened".to_owned()),
        )
    }

    fn set_save_status(
        &mut self,
        status: ProjectSaveStatus,
        last_error: Option<String>,
    ) -> Result<(), StorageError> {
        self.connection.execute(
            "UPDATE project_state SET save_status = ?1, last_error = ?2 WHERE singleton_id = 1",
            params![status.as_str(), last_error],
        )?;
        Ok(())
    }

    fn update_project_fingerprint(
        &mut self,
        fingerprint: &FileFingerprint,
        status: ProjectSaveStatus,
        last_error: Option<String>,
    ) -> Result<(), StorageError> {
        self.connection.execute(
            "UPDATE project_state
             SET save_status = ?1, last_error = ?2, modified_ns = ?3, file_size = ?4, content_hash = ?5
             WHERE singleton_id = 1",
            params![
                status.as_str(),
                last_error,
                fingerprint.modified_ns.to_string(),
                fingerprint.size as i64,
                fingerprint.content_hash
            ],
        )?;
        Ok(())
    }

    fn save_runtime_view_settings(&mut self, settings: &ViewSettings) -> Result<(), StorageError> {
        self.connection.execute(
            "UPDATE view_settings
             SET view_mode = ?1, anchor_date = ?2, show_dependencies = ?3,
                 task_column_width = ?4, mother_sort_mode = ?5
             WHERE singleton_id = 1",
            params![
                settings.view_mode.as_str(),
                settings.anchor_date,
                settings.show_dependencies,
                clamp_task_column_width(settings.task_column_width),
                settings.mother_sort_mode.as_str()
            ],
        )?;
        Ok(())
    }

    fn load_project_view_settings(
        &self,
        path: &Path,
    ) -> Result<Option<ViewSettings>, StorageError> {
        self.connection
            .query_row(
                "SELECT view_mode, anchor_date, show_dependencies, task_column_width, mother_sort_mode
                 FROM project_view_settings WHERE path = ?1",
                [path.to_string_lossy().as_ref()],
                |row| {
                    let view_mode: String = row.get(0)?;
                    let mother_sort_mode: String = row.get(4)?;
                    Ok((
                        view_mode,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        mother_sort_mode,
                    ))
                },
            )
            .optional()?
            .map(|(view_mode, anchor_date, show_dependencies, task_column_width, mother_sort_mode)| {
                let view_mode = ViewMode::parse(&view_mode)
                    .ok_or_else(|| StorageError::Validation("stored project view mode is invalid".to_owned()))?;
                let mother_sort_mode = MotherSortMode::parse(&mother_sort_mode)
                    .ok_or_else(|| StorageError::Validation("stored project sort mode is invalid".to_owned()))?;
                Ok(ViewSettings {
                    view_mode,
                    anchor_date,
                    show_dependencies,
                    task_column_width: clamp_task_column_width(task_column_width),
                    mother_sort_mode,
                })
            })
            .transpose()
    }

    pub fn create_mother_task(
        &mut self,
        name: &str,
        tag: Option<&str>,
    ) -> Result<MotherTask, StorageError> {
        let name = validate_name(name)?;
        let tag = validate_tag(tag)?;
        let transaction = self.connection.transaction()?;
        let sort_order = next_sort_order(&transaction, "mother_tasks", None)?;
        let id = format!("task_{}", Uuid::new_v4().simple());
        transaction.execute(
            "INSERT INTO mother_tasks(id, name, tag, sort_order) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, tag, sort_order],
        )?;
        transaction.commit()?;
        self.persist_active_project()?;

        Ok(MotherTask {
            id,
            name,
            tag,
            expanded: true,
            sort_order,
            depends_on: Vec::new(),
            sub_tasks: Vec::new(),
        })
    }

    pub fn rename_mother_task(
        &mut self,
        id: &str,
        name: &str,
        tag: Option<&str>,
    ) -> Result<(), StorageError> {
        let name = validate_name(name)?;
        let tag = validate_tag(tag)?;
        let affected = self.connection.execute(
            "UPDATE mother_tasks
             SET name = ?2, tag = ?3, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![id, name, tag],
        )?;
        require_affected(affected, "mother task")?;
        self.persist_active_project()
    }

    pub fn set_mother_expanded(&mut self, id: &str, expanded: bool) -> Result<(), StorageError> {
        let affected = self.connection.execute(
            "UPDATE mother_tasks SET expanded = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![id, expanded],
        )?;
        require_affected(affected, "mother task")?;
        self.persist_active_project()
    }

    pub fn reorder_mother_tasks(&mut self, ordered_ids: &[String]) -> Result<(), StorageError> {
        let transaction = self.connection.transaction()?;
        let existing_ids = {
            let mut statement = transaction.prepare("SELECT id FROM mother_tasks")?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            ids
        };
        let ordered_id_set = ordered_ids.iter().collect::<HashSet<_>>();

        if ordered_ids.len() != existing_ids.len()
            || ordered_id_set.len() != existing_ids.len()
            || ordered_ids.iter().any(|id| !existing_ids.contains(id))
        {
            return Err(StorageError::Validation(
                "mother task order must include every task exactly once".to_owned(),
            ));
        }

        for (sort_order, id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE mother_tasks
                 SET sort_order = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, sort_order as i64],
            )?;
        }
        transaction.commit()?;
        self.persist_active_project()?;
        Ok(())
    }

    pub fn reorder_sub_tasks(
        &mut self,
        mother_id: &str,
        ordered_ids: &[String],
    ) -> Result<(), StorageError> {
        let transaction = self.connection.transaction()?;
        let existing_ids = {
            let mut statement =
                transaction.prepare("SELECT id FROM sub_tasks WHERE mother_task_id = ?1")?;
            let ids = statement
                .query_map(params![mother_id], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            ids
        };
        let ordered_id_set = ordered_ids.iter().collect::<HashSet<_>>();

        if ordered_ids.len() != existing_ids.len()
            || ordered_id_set.len() != existing_ids.len()
            || ordered_ids.iter().any(|id| !existing_ids.contains(id))
        {
            return Err(StorageError::Validation(
                "sub task order must include every sub task exactly once".to_owned(),
            ));
        }

        for (sort_order, id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE sub_tasks
                 SET sort_order = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND mother_task_id = ?3",
                params![id, sort_order as i64, mother_id],
            )?;
        }
        transaction.commit()?;
        self.persist_active_project()?;
        Ok(())
    }

    pub fn delete_mother_task(&mut self, id: &str) -> Result<(), StorageError> {
        let transaction = self.connection.transaction()?;
        let affected = transaction.execute("DELETE FROM mother_tasks WHERE id = ?1", [id])?;
        require_affected(affected, "mother task")?;
        transaction.commit()?;
        self.persist_active_project()?;
        Ok(())
    }

    pub fn create_sub_task(&mut self, input: &CreateSubTaskInput) -> Result<SubTask, StorageError> {
        let name = validate_name(&input.name)?;
        validate_date_range(&input.start_date, input.end_date.as_deref())?;

        let transaction = self.connection.transaction()?;
        ensure_mother_exists(&transaction, &input.mother_task_id)?;
        let sort_order = next_sort_order(&transaction, "sub_tasks", Some(&input.mother_task_id))?;
        let id = format!("subtask_{}", Uuid::new_v4().simple());
        transaction.execute(
            "INSERT INTO sub_tasks(
                id, mother_task_id, name, start_date, end_date, sort_order
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                input.mother_task_id,
                name,
                input.start_date,
                input.end_date,
                sort_order
            ],
        )?;
        transaction.commit()?;
        self.persist_active_project()?;

        Ok(SubTask {
            id,
            mother_task_id: input.mother_task_id.clone(),
            name,
            start_date: input.start_date.clone(),
            end_date: input.end_date.clone(),
            sort_order,
        })
    }

    pub fn update_sub_task(&mut self, input: &UpdateSubTaskInput) -> Result<(), StorageError> {
        let name = validate_name(&input.name)?;
        validate_date_range(&input.start_date, input.end_date.as_deref())?;
        let affected = self.connection.execute(
            "UPDATE sub_tasks
             SET name = ?2, start_date = ?3, end_date = ?4, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![input.id, name, input.start_date, input.end_date],
        )?;
        require_affected(affected, "sub task")?;
        self.persist_active_project()
    }

    pub fn delete_sub_task(&mut self, id: &str) -> Result<(), StorageError> {
        let affected = self
            .connection
            .execute("DELETE FROM sub_tasks WHERE id = ?1", [id])?;
        require_affected(affected, "sub task")?;
        self.persist_active_project()
    }

    pub fn set_dependencies(
        &mut self,
        task_id: &str,
        depends_on: &[String],
    ) -> Result<Vec<String>, StorageError> {
        let unique_dependencies = unique_values(depends_on)?;
        if unique_dependencies.iter().any(|id| id == task_id) {
            return Err(StorageError::Validation(
                "a task cannot depend on itself".to_owned(),
            ));
        }

        let transaction = self.connection.transaction()?;
        ensure_mother_exists(&transaction, task_id)?;
        for dependency_id in &unique_dependencies {
            ensure_mother_exists(&transaction, dependency_id)?;
        }

        let mut graph = load_dependency_graph(&transaction)?;
        graph.insert(task_id.to_owned(), unique_dependencies.clone());
        if has_cycle(&graph) {
            return Err(StorageError::Conflict(
                "the dependency change would create a cycle".to_owned(),
            ));
        }

        transaction.execute("DELETE FROM dependencies WHERE task_id = ?1", [task_id])?;
        for dependency_id in &unique_dependencies {
            transaction.execute(
                "INSERT INTO dependencies(task_id, depends_on_task_id) VALUES (?1, ?2)",
                params![task_id, dependency_id],
            )?;
        }
        transaction.commit()?;
        self.persist_active_project()?;
        Ok(unique_dependencies)
    }

    pub fn save_view_settings(&mut self, settings: &ViewSettings) -> Result<(), StorageError> {
        parse_date(&settings.anchor_date)?;
        self.save_runtime_view_settings(settings)?;
        if let Some(path) = self.active_project_path()? {
            self.connection.execute(
                "INSERT INTO project_view_settings(
                    path, view_mode, anchor_date, show_dependencies, task_column_width, mother_sort_mode
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(path) DO UPDATE SET
                   view_mode = excluded.view_mode,
                   anchor_date = excluded.anchor_date,
                   show_dependencies = excluded.show_dependencies,
                   task_column_width = excluded.task_column_width,
                   mother_sort_mode = excluded.mother_sort_mode",
                params![
                    path.to_string_lossy(),
                    settings.view_mode.as_str(),
                    settings.anchor_date,
                    settings.show_dependencies,
                    clamp_task_column_width(settings.task_column_width),
                    settings.mother_sort_mode.as_str()
                ],
            )?;
        }
        Ok(())
    }

    fn load_sub_tasks(&self, mother_task_id: &str) -> Result<Vec<SubTask>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, start_date, end_date, sort_order
             FROM sub_tasks
             WHERE mother_task_id = ?1
             ORDER BY sort_order, id",
        )?;
        let rows = statement.query_map([mother_task_id], |row| {
            Ok(SubTask {
                id: row.get(0)?,
                mother_task_id: mother_task_id.to_owned(),
                name: row.get(1)?,
                start_date: row.get(2)?,
                end_date: row.get(3)?,
                sort_order: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn load_dependencies(&self, task_id: &str) -> Result<Vec<String>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT depends_on_task_id
             FROM dependencies
             WHERE task_id = ?1
             ORDER BY depends_on_task_id",
        )?;
        let rows = statement.query_map([task_id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn load_view_settings(&self) -> Result<ViewSettings, StorageError> {
        self.connection
            .query_row(
                "SELECT view_mode, anchor_date, show_dependencies, task_column_width, mother_sort_mode
                 FROM view_settings WHERE singleton_id = 1",
                [],
                |row| {
                    let view_mode: String = row.get(0)?;
                    Ok((
                        view_mode,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .map_err(StorageError::from)
            .and_then(
                |(view_mode, anchor_date, show_dependencies, task_column_width, mother_sort_mode)| {
                    let view_mode = ViewMode::parse(&view_mode).ok_or_else(|| {
                        StorageError::Validation("stored view mode is invalid".to_owned())
                    })?;
                    let mother_sort_mode = MotherSortMode::parse(&mother_sort_mode)
                        .ok_or_else(|| StorageError::Validation("stored mother sort mode is invalid".to_owned()))?;
                    Ok(ViewSettings {
                        view_mode,
                        anchor_date,
                        show_dependencies,
                        task_column_width: clamp_task_column_width(task_column_width),
                        mother_sort_mode,
                    })
                },
            )
    }
}

fn apply_migrations(connection: &mut Connection) -> Result<(), StorageError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            description TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )?;
    let current_version = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get::<_, i64>(0),
    )?;

    if current_version > LATEST_SCHEMA_VERSION {
        return Err(StorageError::Migration(format!(
            "database schema version {current_version} is newer than supported version {LATEST_SCHEMA_VERSION}"
        )));
    }

    if current_version < 1 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(INITIAL_MIGRATION)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, description) VALUES (1, 'initial schema')",
            [],
        )?;
        transaction.commit()?;
    }

    let current_version = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if current_version < 2 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(&format!(
            "ALTER TABLE view_settings ADD COLUMN task_column_width INTEGER NOT NULL DEFAULT {DEFAULT_TASK_COLUMN_WIDTH} CHECK (task_column_width BETWEEN {MIN_TASK_COLUMN_WIDTH} AND {MAX_TASK_COLUMN_WIDTH})"
        ))?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, description) VALUES (2, 'task column width')",
            [],
        )?;
        transaction.commit()?;
    }

    let current_version = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if current_version < 3 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "ALTER TABLE mother_tasks ADD COLUMN tag TEXT;
             ALTER TABLE view_settings ADD COLUMN mother_sort_mode TEXT NOT NULL DEFAULT 'manual'
               CHECK (mother_sort_mode IN ('manual', 'tag'));",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, description) VALUES (3, 'mother task tags and sort mode')",
            [],
        )?;
        transaction.commit()?;
    }

    let current_version = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if current_version < 4 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE project_state (
                singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
                active_path TEXT,
                workspace_mode TEXT NOT NULL DEFAULT 'unnamed_legacy'
                  CHECK (workspace_mode IN ('named_project', 'unnamed_legacy')),
                save_status TEXT NOT NULL DEFAULT 'saved'
                  CHECK (save_status IN ('saved', 'saving', 'unsaved', 'conflict', 'error')),
                last_error TEXT,
                modified_ns TEXT,
                file_size INTEGER,
                content_hash TEXT
            );
            INSERT INTO project_state(singleton_id) VALUES (1);

            CREATE TABLE recent_projects (
                path TEXT PRIMARY KEY NOT NULL,
                last_opened_order INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'missing', 'unreadable', 'invalid', 'conflict')),
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
                task_column_width INTEGER NOT NULL
                  CHECK (task_column_width BETWEEN 240 AND 600),
                mother_sort_mode TEXT NOT NULL CHECK (mother_sort_mode IN ('manual', 'tag'))
            );",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, description) VALUES (4, 'project file session metadata')",
            [],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos() as i64)
        .unwrap_or_default()
}

fn default_view_settings() -> ViewSettings {
    ViewSettings {
        view_mode: ViewMode::Biweek,
        anchor_date: OffsetDateTime::now_utc()
            .date()
            .format(&Iso8601::DATE)
            .unwrap_or_else(|_| "1970-01-01".to_owned()),
        show_dependencies: true,
        task_column_width: DEFAULT_TASK_COLUMN_WIDTH,
        mother_sort_mode: MotherSortMode::Manual,
    }
}

fn parse_workspace_mode(value: &str) -> Result<WorkspaceMode, StorageError> {
    match value {
        "named_project" => Ok(WorkspaceMode::NamedProject),
        "unnamed_legacy" => Ok(WorkspaceMode::UnnamedLegacy),
        _ => Err(StorageError::Validation(
            "stored workspace mode is invalid".to_owned(),
        )),
    }
}

fn parse_save_status(value: &str) -> Result<ProjectSaveStatus, StorageError> {
    match value {
        "saved" => Ok(ProjectSaveStatus::Saved),
        "saving" => Ok(ProjectSaveStatus::Saving),
        "unsaved" => Ok(ProjectSaveStatus::Unsaved),
        "conflict" => Ok(ProjectSaveStatus::Conflict),
        "error" => Ok(ProjectSaveStatus::Error),
        _ => Err(StorageError::Validation(
            "stored project save status is invalid".to_owned(),
        )),
    }
}

fn parse_recent_status(value: &str) -> Result<RecentProjectStatus, StorageError> {
    match value {
        "available" => Ok(RecentProjectStatus::Available),
        "missing" => Ok(RecentProjectStatus::Missing),
        "unreadable" => Ok(RecentProjectStatus::Unreadable),
        "invalid" => Ok(RecentProjectStatus::Invalid),
        "conflict" => Ok(RecentProjectStatus::Conflict),
        _ => Err(StorageError::Validation(
            "stored recent project status is invalid".to_owned(),
        )),
    }
}

fn classify_recent_failure(error: &ProjectFileError) -> RecentProjectStatus {
    match error {
        ProjectFileError::InvalidExtension => RecentProjectStatus::Invalid,
        ProjectFileError::ExternalChange => RecentProjectStatus::Conflict,
        ProjectFileError::Read(_) => RecentProjectStatus::Unreadable,
        ProjectFileError::Utf8(_) => RecentProjectStatus::Invalid,
        ProjectFileError::Write(_) => RecentProjectStatus::Unreadable,
    }
}

fn classify_storage_failure(error: &StorageError) -> RecentProjectStatus {
    match error {
        StorageError::Validation(_) => RecentProjectStatus::Invalid,
        StorageError::ProjectConflict(_) | StorageError::Conflict(_) => {
            RecentProjectStatus::Conflict
        }
        StorageError::Io(_) | StorageError::ProjectFile(_) => RecentProjectStatus::Unreadable,
        _ => RecentProjectStatus::Unreadable,
    }
}

fn project_file_error(error: ProjectFileError) -> StorageError {
    match error {
        ProjectFileError::InvalidExtension => {
            StorageError::Validation("please choose a .json project file".to_owned())
        }
        ProjectFileError::ExternalChange => {
            StorageError::ProjectConflict("project file changed outside PMPlan".to_owned())
        }
        ProjectFileError::Read(error) => StorageError::ProjectFile(error.to_string()),
        ProjectFileError::Utf8(error) => StorageError::Validation(error.to_string()),
        ProjectFileError::Write(error) => StorageError::ProjectFile(error),
    }
}

impl ProjectSaveStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Saved => "saved",
            Self::Saving => "saving",
            Self::Unsaved => "unsaved",
            Self::Conflict => "conflict",
            Self::Error => "error",
        }
    }
}

impl RecentProjectStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Missing => "missing",
            Self::Unreadable => "unreadable",
            Self::Invalid => "invalid",
            Self::Conflict => "conflict",
        }
    }
}

fn clamp_task_column_width(value: i64) -> i64 {
    value.clamp(MIN_TASK_COLUMN_WIDTH, MAX_TASK_COLUMN_WIDTH)
}

fn validate_name(value: &str) -> Result<String, StorageError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(StorageError::Validation(
            "task name cannot be empty".to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_tag(value: Option<&str>) -> Result<Option<String>, StorageError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let tag = value.trim();
    if tag.is_empty() {
        return Ok(None);
    }
    if tag.chars().count() > MOTHER_TAG_MAX_LENGTH {
        return Err(StorageError::Validation(format!(
            "mother task tag cannot exceed {MOTHER_TAG_MAX_LENGTH} characters"
        )));
    }
    Ok(Some(tag.to_owned()))
}

fn parse_date(value: &str) -> Result<Date, StorageError> {
    Date::parse(value, &Iso8601::DATE).map_err(|_| {
        StorageError::Validation(format!("invalid date '{value}', expected YYYY-MM-DD"))
    })
}

fn validate_date_range(start_date: &str, end_date: Option<&str>) -> Result<(), StorageError> {
    let start = parse_date(start_date)?;
    if let Some(end_date) = end_date {
        let end = parse_date(end_date)?;
        if end < start {
            return Err(StorageError::Validation(
                "end date cannot be earlier than start date".to_owned(),
            ));
        }
    }
    Ok(())
}

fn ensure_mother_exists(connection: &Connection, id: &str) -> Result<(), StorageError> {
    let exists = connection
        .query_row("SELECT 1 FROM mother_tasks WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(StorageError::NotFound(format!(
            "mother task '{id}' was not found"
        )))
    }
}

fn require_affected(affected: usize, entity: &str) -> Result<(), StorageError> {
    if affected == 0 {
        Err(StorageError::NotFound(format!("{entity} was not found")))
    } else {
        Ok(())
    }
}

fn next_sort_order(
    transaction: &Transaction<'_>,
    table: &str,
    mother_task_id: Option<&str>,
) -> Result<i64, StorageError> {
    let next = match (table, mother_task_id) {
        ("mother_tasks", None) => transaction.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM mother_tasks",
            [],
            |row| row.get(0),
        )?,
        ("sub_tasks", Some(mother_task_id)) => transaction.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1
             FROM sub_tasks WHERE mother_task_id = ?1",
            [mother_task_id],
            |row| row.get(0),
        )?,
        _ => {
            return Err(StorageError::Validation(
                "invalid sort-order request".to_owned(),
            ));
        }
    };
    Ok(next)
}

fn unique_values(values: &[String]) -> Result<Vec<String>, StorageError> {
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        if !seen.insert(value) {
            return Err(StorageError::Validation(format!(
                "duplicate dependency '{value}'"
            )));
        }
        result.push(value.clone());
    }
    Ok(result)
}

fn load_dependency_graph(
    connection: &Connection,
) -> Result<HashMap<String, Vec<String>>, StorageError> {
    let mut graph = HashMap::new();
    let mut task_statement = connection.prepare("SELECT id FROM mother_tasks")?;
    for task_id in task_statement.query_map([], |row| row.get::<_, String>(0))? {
        graph.insert(task_id?, Vec::new());
    }

    let mut dependency_statement =
        connection.prepare("SELECT task_id, depends_on_task_id FROM dependencies")?;
    for row in dependency_statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (task_id, dependency_id) = row?;
        graph.entry(task_id).or_default().push(dependency_id);
    }
    Ok(graph)
}

fn has_cycle(graph: &HashMap<String, Vec<String>>) -> bool {
    fn visit(
        node: &str,
        graph: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> bool {
        if visiting.contains(node) {
            return true;
        }
        if visited.contains(node) {
            return false;
        }

        visiting.insert(node.to_owned());
        if let Some(dependencies) = graph.get(node) {
            for dependency in dependencies {
                if visit(dependency, graph, visiting, visited) {
                    return true;
                }
            }
        }
        visiting.remove(node);
        visited.insert(node.to_owned());
        false
    }

    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    graph
        .keys()
        .any(|node| visit(node, graph, &mut visiting, &mut visited))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn sub_task_input(mother_task_id: &str) -> CreateSubTaskInput {
        CreateSubTaskInput {
            mother_task_id: mother_task_id.to_owned(),
            name: "Design timeline".to_owned(),
            start_date: "2026-09-17".to_owned(),
            end_date: Some("2026-09-19".to_owned()),
        }
    }

    #[test]
    fn initializes_an_empty_board() {
        let storage = Storage::open_in_memory().expect("open in-memory database");
        let board = storage.load_board().expect("load board");

        assert!(board.tasks.is_empty());
        assert_eq!(board.view_settings.view_mode, ViewMode::Biweek);
        assert!(board.view_settings.show_dependencies);
    }

    #[test]
    fn persists_crud_across_reopen() {
        let directory = tempdir().expect("create temp directory");
        let database_path = directory.path().join("pmplan.sqlite3");
        let mother_id;
        let sub_task_id;

        {
            let mut storage = Storage::open(&database_path).expect("open database");
            let mother = storage
                .create_mother_task("  Product launch  ", None)
                .expect("create mother task");
            mother_id = mother.id.clone();
            assert_eq!(mother.name, "Product launch");
            let sub_task = storage
                .create_sub_task(&sub_task_input(&mother.id))
                .expect("create sub task");
            sub_task_id = sub_task.id;
        }

        let mut reopened = Storage::open(&database_path).expect("reopen database");
        let board = reopened.load_board().expect("load persisted board");
        assert_eq!(board.tasks.len(), 1);
        assert_eq!(board.tasks[0].sub_tasks.len(), 1);
        assert_eq!(board.tasks[0].sub_tasks[0].id, sub_task_id);

        reopened
            .rename_mother_task(&mother_id, "Launch plan", None)
            .expect("rename mother task");
        reopened
            .set_mother_expanded(&mother_id, false)
            .expect("collapse mother task");
        reopened
            .delete_sub_task(&sub_task_id)
            .expect("delete sub task");
        let board = reopened.load_board().expect("reload board");
        assert_eq!(board.tasks[0].name, "Launch plan");
        assert!(!board.tasks[0].expanded);
        assert!(board.tasks[0].sub_tasks.is_empty());
    }

    #[test]
    fn isolates_named_projects_and_restores_the_last_project() {
        let directory = tempdir().expect("create temp directory");
        let database_path = directory.path().join("pmplan.sqlite3");
        let project_a = directory.path().join("a.json");
        let project_b = directory.path().join("b.json");
        fs::write(&project_a, r#"{"version":"1.0","tasks":[]}"#).expect("write A");
        fs::write(&project_b, r#"{"version":"1.0","tasks":[]}"#).expect("write B");

        {
            let mut storage = Storage::open(&database_path).expect("open database");
            storage.open_project(&project_a).expect("open A");
            storage
                .save_view_settings(&ViewSettings {
                    view_mode: ViewMode::Week,
                    anchor_date: "2026-01-05".to_owned(),
                    show_dependencies: false,
                    task_column_width: DEFAULT_TASK_COLUMN_WIDTH,
                    mother_sort_mode: MotherSortMode::Manual,
                })
                .expect("save A view");
            storage
                .create_mother_task("A task", None)
                .expect("save A task");
            assert!(fs::read_to_string(&project_a)
                .expect("read A")
                .contains("A task"));

            storage.open_project(&project_b).expect("open B");
            assert_eq!(
                storage
                    .load_board()
                    .expect("load B settings")
                    .view_settings
                    .view_mode,
                ViewMode::Biweek
            );
            storage
                .create_mother_task("B task", None)
                .expect("save B task");
            assert!(fs::read_to_string(&project_b)
                .expect("read B")
                .contains("B task"));
            assert!(!fs::read_to_string(&project_a)
                .expect("read A again")
                .contains("B task"));

            storage.open_project(&project_a).expect("reopen A");
            let a_settings = storage.load_board().expect("load A settings").view_settings;
            assert_eq!(a_settings.view_mode, ViewMode::Week);
            assert_eq!(a_settings.anchor_date, "2026-01-05");
            assert!(!a_settings.show_dependencies);
            storage
                .open_project(&project_b)
                .expect("restore B as last project");
        }

        let reopened = Storage::open(&database_path).expect("reopen database");
        let state = reopened.project_state().expect("load project state");
        let normalized_b = normalize_project_path(&project_b).expect("normalize B");
        assert_eq!(state.active_path.as_deref(), normalized_b.to_str());
        assert_eq!(
            reopened.load_board().expect("load B").tasks[0].name,
            "B task"
        );
    }

    #[test]
    fn reports_external_project_changes_without_losing_cached_mutation() {
        let directory = tempdir().expect("create temp directory");
        let database_path = directory.path().join("pmplan.sqlite3");
        let project = directory.path().join("project.json");
        fs::write(&project, r#"{"version":"1.0","tasks":[]}"#).expect("write project");

        let mut storage = Storage::open(&database_path).expect("open database");
        storage.open_project(&project).expect("open project");
        fs::write(&project, r#"{"version":"1.0","tasks":[],"external":true}"#)
            .expect("external edit");
        let error = storage
            .create_mother_task("Local change", None)
            .expect_err("external edit must block overwrite");
        assert_eq!(error.code(), "project_conflict");
        assert_eq!(
            storage.load_board().expect("load cached board").tasks.len(),
            1
        );
        assert_eq!(
            storage.project_state().expect("load state").save_status,
            ProjectSaveStatus::Conflict
        );
    }

    #[test]
    fn caps_recent_projects_at_eight_without_deleting_source_files() {
        let directory = tempdir().expect("create temp directory");
        let database_path = directory.path().join("pmplan.sqlite3");
        let mut storage = Storage::open(&database_path).expect("open database");
        let mut paths = Vec::new();
        for index in 0..9 {
            let path = directory.path().join(format!("project-{index}.json"));
            fs::write(&path, r#"{"version":"1.0","tasks":[]}"#).expect("write project");
            storage.open_project(&path).expect("open project");
            paths.push(path);
        }

        let state = storage.project_state().expect("load recent projects");
        assert_eq!(state.recent.len(), 8);
        assert!(state
            .recent
            .iter()
            .all(|recent| recent.path
                != normalize_project_path(&paths[0]).unwrap().to_string_lossy()));
        assert!(paths[0].exists());

        storage
            .remove_recent_project(&paths[8])
            .expect("remove recent record");
        assert!(paths[8].exists());
        assert_eq!(
            storage.project_state().expect("reload state").recent.len(),
            7
        );
    }

    #[test]
    fn persists_mother_tags_and_tag_sort_mode() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let mother = storage
            .create_mother_task("Tagged plan", Some("  Product  "))
            .expect("create tagged mother task");
        assert_eq!(mother.tag.as_deref(), Some("Product"));

        storage
            .rename_mother_task(&mother.id, "Tagged plan", Some("Roadmap"))
            .expect("update mother tag");
        storage
            .save_view_settings(&ViewSettings {
                view_mode: ViewMode::Biweek,
                anchor_date: "2026-09-18".to_owned(),
                show_dependencies: true,
                task_column_width: DEFAULT_TASK_COLUMN_WIDTH,
                mother_sort_mode: MotherSortMode::Tag,
            })
            .expect("save tag sort mode");

        let board = storage.load_board().expect("load tagged board");
        assert_eq!(board.tasks[0].tag.as_deref(), Some("Roadmap"));
        assert_eq!(board.view_settings.mother_sort_mode, MotherSortMode::Tag);
    }

    #[test]
    fn reorders_all_mother_tasks_atomically() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let task_a = storage.create_mother_task("A", None).expect("create A");
        let task_b = storage.create_mother_task("B", None).expect("create B");
        let task_c = storage.create_mother_task("C", None).expect("create C");

        storage
            .reorder_mother_tasks(&[task_c.id.clone(), task_a.id.clone(), task_b.id.clone()])
            .expect("reorder tasks");
        let board = storage.load_board().expect("load reordered board");
        assert_eq!(
            board
                .tasks
                .iter()
                .map(|task| task.name.as_str())
                .collect::<Vec<_>>(),
            vec!["C", "A", "B"]
        );
        assert_eq!(
            board
                .tasks
                .iter()
                .map(|task| task.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        let error = storage
            .reorder_mother_tasks(&[task_a.id, task_b.id])
            .expect_err("incomplete order must fail");
        assert_eq!(error.code(), "validation_error");
        assert_eq!(
            storage
                .load_board()
                .expect("load unchanged board")
                .tasks
                .iter()
                .map(|task| task.name.as_str())
                .collect::<Vec<_>>(),
            vec!["C", "A", "B"]
        );
    }

    #[test]
    fn reorders_sub_tasks_within_mother_and_rejects_incomplete_orders() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let mother = storage
            .create_mother_task("Mother", None)
            .expect("create mother");
        let sub_a = storage
            .create_sub_task(&sub_task_input(&mother.id))
            .expect("create A");
        let sub_b = storage
            .create_sub_task(&sub_task_input(&mother.id))
            .expect("create B");
        let sub_c = storage
            .create_sub_task(&sub_task_input(&mother.id))
            .expect("create C");

        storage
            .reorder_sub_tasks(
                &mother.id,
                &[sub_c.id.clone(), sub_a.id.clone(), sub_b.id.clone()],
            )
            .expect("reorder sub tasks");
        let sub_tasks = storage.load_board().expect("load reordered board").tasks[0]
            .sub_tasks
            .clone();
        assert_eq!(
            sub_tasks.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec![sub_c.id.as_str(), sub_a.id.as_str(), sub_b.id.as_str()]
        );
        assert_eq!(
            sub_tasks.iter().map(|s| s.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        let error = storage
            .reorder_sub_tasks(&mother.id, &[sub_a.id.clone(), sub_b.id.clone()])
            .expect_err("incomplete order must fail");
        assert_eq!(error.code(), "validation_error");
        let unchanged_board = storage.load_board().expect("load unchanged board");
        let unchanged = unchanged_board.tasks[0]
            .sub_tasks
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            unchanged,
            vec![sub_c.id.as_str(), sub_a.id.as_str(), sub_b.id.as_str()]
        );
    }

    #[test]
    fn rejects_invalid_date_ranges_without_writing() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let mother = storage
            .create_mother_task("Mother", None)
            .expect("create mother task");
        let mut input = sub_task_input(&mother.id);
        input.end_date = Some("2026-09-16".to_owned());

        let error = storage
            .create_sub_task(&input)
            .expect_err("invalid range must fail");
        assert_eq!(error.code(), "validation_error");
        assert!(storage.load_board().expect("load board").tasks[0]
            .sub_tasks
            .is_empty());
    }

    #[test]
    fn rejects_cycles_and_preserves_previous_dependencies() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let task_a = storage.create_mother_task("A", None).expect("create A");
        let task_b = storage.create_mother_task("B", None).expect("create B");
        let task_c = storage.create_mother_task("C", None).expect("create C");

        storage
            .set_dependencies(&task_b.id, std::slice::from_ref(&task_a.id))
            .expect("B depends on A");
        storage
            .set_dependencies(&task_c.id, std::slice::from_ref(&task_b.id))
            .expect("C depends on B");
        let error = storage
            .set_dependencies(&task_a.id, std::slice::from_ref(&task_c.id))
            .expect_err("cycle must fail");

        assert_eq!(error.code(), "dependency_conflict");
        let board = storage.load_board().expect("load board");
        let a = board
            .tasks
            .iter()
            .find(|task| task.id == task_a.id)
            .expect("find A");
        assert!(a.depends_on.is_empty());
    }

    #[test]
    fn rejects_self_duplicate_and_unknown_dependencies() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let task_a = storage.create_mother_task("A", None).expect("create A");
        let task_b = storage.create_mother_task("B", None).expect("create B");

        let self_error = storage
            .set_dependencies(&task_a.id, std::slice::from_ref(&task_a.id))
            .expect_err("self dependency must fail");
        assert_eq!(self_error.code(), "validation_error");

        let duplicate_error = storage
            .set_dependencies(&task_b.id, &[task_a.id.clone(), task_a.id.clone()])
            .expect_err("duplicate dependency must fail");
        assert_eq!(duplicate_error.code(), "validation_error");

        let unknown_error = storage
            .set_dependencies(&task_b.id, &["missing".to_owned()])
            .expect_err("unknown dependency must fail");
        assert_eq!(unknown_error.code(), "not_found");
    }

    #[test]
    fn deleting_a_mother_cascades_children_and_dependencies() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let task_a = storage.create_mother_task("A", None).expect("create A");
        let task_b = storage.create_mother_task("B", None).expect("create B");
        storage
            .create_sub_task(&sub_task_input(&task_a.id))
            .expect("create child");
        storage
            .set_dependencies(&task_b.id, std::slice::from_ref(&task_a.id))
            .expect("set dependency");

        storage.delete_mother_task(&task_a.id).expect("delete A");
        let board = storage.load_board().expect("load board");

        assert_eq!(board.tasks.len(), 1);
        assert_eq!(board.tasks[0].id, task_b.id);
        assert!(board.tasks[0].depends_on.is_empty());
    }

    #[test]
    fn defaults_task_column_width_for_new_boards() {
        let storage = Storage::open_in_memory().expect("open database");
        assert_eq!(
            storage
                .load_board()
                .expect("load board")
                .view_settings
                .task_column_width,
            DEFAULT_TASK_COLUMN_WIDTH
        );
    }

    #[test]
    fn persists_view_settings() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let expected = ViewSettings {
            view_mode: ViewMode::Month,
            anchor_date: "2026-10-01".to_owned(),
            show_dependencies: false,
            task_column_width: 420,
            mother_sort_mode: MotherSortMode::Manual,
        };

        storage
            .save_view_settings(&expected)
            .expect("save view settings");

        assert_eq!(
            storage.load_board().expect("load board").view_settings,
            expected
        );
    }

    #[test]
    fn clamps_task_column_width_when_loading() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let settings = ViewSettings {
            view_mode: ViewMode::Biweek,
            anchor_date: "2026-09-18".to_owned(),
            show_dependencies: true,
            task_column_width: 900,
            mother_sort_mode: MotherSortMode::Manual,
        };
        storage
            .save_view_settings(&settings)
            .expect("save clamped width");
        assert_eq!(
            storage
                .load_board()
                .expect("load board")
                .view_settings
                .task_column_width,
            MAX_TASK_COLUMN_WIDTH
        );
    }

    #[test]
    fn rejects_a_database_from_a_newer_schema_version() {
        let directory = tempdir().expect("create temp directory");
        let database_path = directory.path().join("future.sqlite3");
        let connection = Connection::open(&database_path).expect("open raw database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY NOT NULL,
                    description TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT INTO schema_migrations(version, description) VALUES (99, 'future');",
            )
            .expect("write future migration");
        drop(connection);

        let error = Storage::open(&database_path)
            .err()
            .expect("newer schema must be rejected");
        assert_eq!(error.code(), "migration_error");
    }
}
