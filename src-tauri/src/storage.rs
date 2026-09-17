use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use thiserror::Error;
use time::{format_description::well_known::Iso8601, Date};
use uuid::Uuid;

use crate::domain::{
    BoardSnapshot, CreateSubTaskInput, MotherTask, SubTask, UpdateSubTaskInput, ViewMode,
    ViewSettings,
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
const LATEST_SCHEMA_VERSION: i64 = 1;

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
        }
    }
}

pub struct Storage {
    connection: Connection,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let connection = Connection::open(path)?;
        Self::initialize(connection)
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self, StorageError> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn initialize(mut connection: Connection) -> Result<Self, StorageError> {
        connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
        )?;
        apply_migrations(&mut connection)?;
        Ok(Self { connection })
    }

    pub fn load_board(&self) -> Result<BoardSnapshot, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, expanded, sort_order FROM mother_tasks ORDER BY sort_order, id",
        )?;
        let mother_rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;

        let mut tasks = Vec::new();
        for mother_row in mother_rows {
            let (id, name, expanded, sort_order) = mother_row?;
            tasks.push(MotherTask {
                depends_on: self.load_dependencies(&id)?,
                sub_tasks: self.load_sub_tasks(&id)?,
                id,
                name,
                expanded,
                sort_order,
            });
        }

        Ok(BoardSnapshot {
            tasks,
            view_settings: self.load_view_settings()?,
        })
    }

    pub fn create_mother_task(&mut self, name: &str) -> Result<MotherTask, StorageError> {
        let name = validate_name(name)?;
        let transaction = self.connection.transaction()?;
        let sort_order = next_sort_order(&transaction, "mother_tasks", None)?;
        let id = format!("task_{}", Uuid::new_v4().simple());
        transaction.execute(
            "INSERT INTO mother_tasks(id, name, sort_order) VALUES (?1, ?2, ?3)",
            params![id, name, sort_order],
        )?;
        transaction.commit()?;

        Ok(MotherTask {
            id,
            name,
            expanded: true,
            sort_order,
            depends_on: Vec::new(),
            sub_tasks: Vec::new(),
        })
    }

    pub fn rename_mother_task(&mut self, id: &str, name: &str) -> Result<(), StorageError> {
        let name = validate_name(name)?;
        let affected = self.connection.execute(
            "UPDATE mother_tasks SET name = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![id, name],
        )?;
        require_affected(affected, "mother task")
    }

    pub fn set_mother_expanded(&mut self, id: &str, expanded: bool) -> Result<(), StorageError> {
        let affected = self.connection.execute(
            "UPDATE mother_tasks SET expanded = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![id, expanded],
        )?;
        require_affected(affected, "mother task")
    }

    pub fn delete_mother_task(&mut self, id: &str) -> Result<(), StorageError> {
        let transaction = self.connection.transaction()?;
        let affected = transaction.execute("DELETE FROM mother_tasks WHERE id = ?1", [id])?;
        require_affected(affected, "mother task")?;
        transaction.commit()?;
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
        require_affected(affected, "sub task")
    }

    pub fn delete_sub_task(&mut self, id: &str) -> Result<(), StorageError> {
        let affected = self
            .connection
            .execute("DELETE FROM sub_tasks WHERE id = ?1", [id])?;
        require_affected(affected, "sub task")
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
        Ok(unique_dependencies)
    }

    pub fn save_view_settings(&mut self, settings: &ViewSettings) -> Result<(), StorageError> {
        parse_date(&settings.anchor_date)?;
        self.connection.execute(
            "UPDATE view_settings
             SET view_mode = ?1, anchor_date = ?2, show_dependencies = ?3
             WHERE singleton_id = 1",
            params![
                settings.view_mode.as_str(),
                settings.anchor_date,
                settings.show_dependencies
            ],
        )?;
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
                "SELECT view_mode, anchor_date, show_dependencies
                 FROM view_settings WHERE singleton_id = 1",
                [],
                |row| {
                    let view_mode: String = row.get(0)?;
                    Ok((view_mode, row.get(1)?, row.get(2)?))
                },
            )
            .map_err(StorageError::from)
            .and_then(|(view_mode, anchor_date, show_dependencies)| {
                let view_mode = ViewMode::parse(&view_mode).ok_or_else(|| {
                    StorageError::Validation("stored view mode is invalid".to_owned())
                })?;
                Ok(ViewSettings {
                    view_mode,
                    anchor_date,
                    show_dependencies,
                })
            })
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
    Ok(())
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
                .create_mother_task("  Product launch  ")
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
            .rename_mother_task(&mother_id, "Launch plan")
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
    fn rejects_invalid_date_ranges_without_writing() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let mother = storage
            .create_mother_task("Mother")
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
        let task_a = storage.create_mother_task("A").expect("create A");
        let task_b = storage.create_mother_task("B").expect("create B");
        let task_c = storage.create_mother_task("C").expect("create C");

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
        let task_a = storage.create_mother_task("A").expect("create A");
        let task_b = storage.create_mother_task("B").expect("create B");

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
        let task_a = storage.create_mother_task("A").expect("create A");
        let task_b = storage.create_mother_task("B").expect("create B");
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
    fn persists_view_settings() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let expected = ViewSettings {
            view_mode: ViewMode::Month,
            anchor_date: "2026-10-01".to_owned(),
            show_dependencies: false,
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
