use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use crate::{
    domain::{BoardSnapshot, MotherTask, SubTask},
    storage::{Storage, StorageError},
};

const EXPORT_VERSION: &str = "1.0";
const MAX_IMPORT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Overwrite,
    Merge,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub valid: bool,
    pub version: Option<String>,
    pub mother_task_count: usize,
    pub sub_task_count: usize,
    pub dependency_count: usize,
    pub errors: Vec<ValidationIssue>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub mother_task_count: usize,
    pub sub_task_count: usize,
    pub dependency_count: usize,
}

#[derive(Debug, Default, Deserialize)]
struct RawDocument {
    version: Option<String>,
    tasks: Option<Vec<RawMotherTask>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMotherTask {
    id: Option<String>,
    name: Option<String>,
    expanded: Option<bool>,
    depends_on: Option<Vec<String>>,
    sub_tasks: Option<Vec<RawSubTask>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubTask {
    id: Option<String>,
    name: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Debug, Clone)]
struct PreparedImport {
    version: String,
    tasks: Vec<PreparedMotherTask>,
}

#[derive(Debug, Clone)]
struct PreparedMotherTask {
    id: String,
    name: String,
    expanded: bool,
    depends_on: Vec<String>,
    sub_tasks: Vec<PreparedSubTask>,
}

#[derive(Debug, Clone)]
struct PreparedSubTask {
    id: String,
    name: String,
    start_date: String,
    end_date: Option<String>,
}

#[derive(Debug)]
struct Preparation {
    document: Option<PreparedImport>,
    version: Option<String>,
    mother_task_count: usize,
    sub_task_count: usize,
    dependency_count: usize,
    errors: Vec<ValidationIssue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDocument<'a> {
    version: &'static str,
    exported_at: String,
    source: &'static str,
    tasks: Vec<ExportMotherTask<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportMotherTask<'a> {
    id: &'a str,
    name: &'a str,
    expanded: bool,
    depends_on: &'a [String],
    sub_tasks: Vec<ExportSubTask<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSubTask<'a> {
    id: &'a str,
    name: &'a str,
    start_date: &'a str,
    end_date: Option<&'a str>,
}

impl Storage {
    pub fn analyze_import_content(
        &self,
        content: &str,
        mode: ImportMode,
    ) -> Result<ImportPreview, StorageError> {
        let preparation = self.prepare_import(content, mode)?;
        Ok(ImportPreview {
            valid: preparation.errors.is_empty(),
            version: preparation.version,
            mother_task_count: preparation.mother_task_count,
            sub_task_count: preparation.sub_task_count,
            dependency_count: preparation.dependency_count,
            errors: preparation.errors,
        })
    }

    pub fn analyze_import_file(
        &self,
        path: &Path,
        mode: ImportMode,
    ) -> Result<ImportPreview, StorageError> {
        let content = read_json_file(path)?;
        self.analyze_import_content(&content, mode)
    }

    pub fn apply_import_content(
        &mut self,
        content: &str,
        mode: ImportMode,
    ) -> Result<TransferResult, StorageError> {
        let preparation = self.prepare_import(content, mode)?;
        if !preparation.errors.is_empty() {
            let first = &preparation.errors[0];
            return Err(StorageError::Validation(format!(
                "{}: {} ({} validation errors)",
                first.path,
                first.message,
                preparation.errors.len()
            )));
        }
        let document = preparation.document.ok_or_else(|| {
            StorageError::Validation("import document could not be prepared".to_owned())
        })?;
        let result = TransferResult {
            mother_task_count: document.tasks.len(),
            sub_task_count: document.tasks.iter().map(|task| task.sub_tasks.len()).sum(),
            dependency_count: document
                .tasks
                .iter()
                .map(|task| task.depends_on.len())
                .sum(),
        };
        self.apply_prepared_import(document, mode)?;
        Ok(result)
    }

    pub fn apply_import_file(
        &mut self,
        path: &Path,
        mode: ImportMode,
    ) -> Result<TransferResult, StorageError> {
        let content = read_json_file(path)?;
        self.apply_import_content(&content, mode)
    }

    pub fn export_json_content(&self) -> Result<String, StorageError> {
        let board = self.load_board()?;
        export_board(&board)
    }

    pub fn export_json_file(&self, path: &Path) -> Result<TransferResult, StorageError> {
        let board = self.load_board()?;
        let content = export_board(&board)?;
        let destination = ensure_json_extension(path);
        fs::write(destination, format!("\u{feff}{content}"))?;
        Ok(TransferResult {
            mother_task_count: board.tasks.len(),
            sub_task_count: board.tasks.iter().map(|task| task.sub_tasks.len()).sum(),
            dependency_count: board.tasks.iter().map(|task| task.depends_on.len()).sum(),
        })
    }

    fn prepare_import(&self, content: &str, mode: ImportMode) -> Result<Preparation, StorageError> {
        if content.len() > MAX_IMPORT_BYTES {
            return Ok(Preparation {
                document: None,
                version: None,
                mother_task_count: 0,
                sub_task_count: 0,
                dependency_count: 0,
                errors: vec![issue("$", "文件超过 10 MB 限制")],
            });
        }
        let clean_content = content.trim_start_matches('\u{feff}');
        let raw: RawDocument = match serde_json::from_str(clean_content) {
            Ok(document) => document,
            Err(error) => {
                return Ok(Preparation {
                    document: None,
                    version: None,
                    mother_task_count: 0,
                    sub_task_count: 0,
                    dependency_count: 0,
                    errors: vec![issue("$", &format!("JSON 无法解析：{error}"))],
                });
            }
        };

        let tasks_missing = raw.tasks.is_none();
        let raw_tasks = raw.tasks.unwrap_or_default();
        let mother_task_count = raw_tasks.len();
        let sub_task_count = raw_tasks
            .iter()
            .map(|task| task.sub_tasks.as_ref().map_or(0, Vec::len))
            .sum();
        let dependency_count = raw_tasks
            .iter()
            .map(|task| task.depends_on.as_ref().map_or(0, Vec::len))
            .sum();
        let current = self.load_board()?;
        let mut errors = Vec::new();

        let version = raw.version.clone();
        match version.as_deref() {
            Some(value) if value.split('.').next() == Some("1") => {}
            Some(value) => errors.push(issue(
                "version",
                &format!("文件版本 {value} 与当前 1.x 不兼容"),
            )),
            None => errors.push(issue("version", "缺少必填版本号")),
        }
        if tasks_missing {
            errors.push(issue("tasks", "tasks 必须是数组"));
        }

        let existing_by_id: HashMap<_, _> = current
            .tasks
            .iter()
            .map(|task| (task.id.as_str(), task))
            .collect();
        let mut supplied_mother_ids = HashSet::new();
        let mut supplied_sub_task_ids = HashSet::new();
        let mut prepared_tasks = Vec::with_capacity(raw_tasks.len());

        for (task_index, raw_task) in raw_tasks.into_iter().enumerate() {
            let task_path = format!("tasks[{task_index}]");
            let name = normalized_required(
                raw_task.name.as_deref(),
                &format!("{task_path}.name"),
                &mut errors,
            );
            let supplied_id = normalized_optional_id(
                raw_task.id.as_deref(),
                &format!("{task_path}.id"),
                &mut errors,
            );
            if let Some(id) = supplied_id.as_deref() {
                if !supplied_mother_ids.insert(id.to_owned()) {
                    errors.push(issue(
                        &format!("{task_path}.id"),
                        &format!("母任务 id {id} 重复"),
                    ));
                }
            }
            let resolved_id = match supplied_id {
                Some(id) => id,
                None if mode == ImportMode::Overwrite => {
                    errors.push(issue(
                        &format!("{task_path}.id"),
                        "覆盖导入要求母任务包含 id",
                    ));
                    generated_id("task")
                }
                None => current
                    .tasks
                    .iter()
                    .find(|task| task.name == name)
                    .map_or_else(|| generated_id("task"), |task| task.id.clone()),
            };
            let existing_mother = existing_by_id.get(resolved_id.as_str()).copied();
            let raw_sub_tasks = raw_task.sub_tasks.unwrap_or_default();
            let mut prepared_sub_tasks = Vec::with_capacity(raw_sub_tasks.len());

            for (sub_index, raw_sub_task) in raw_sub_tasks.into_iter().enumerate() {
                let sub_path = format!("{task_path}.subTasks[{sub_index}]");
                let sub_name = normalized_required(
                    raw_sub_task.name.as_deref(),
                    &format!("{sub_path}.name"),
                    &mut errors,
                );
                let start_date = normalized_required(
                    raw_sub_task.start_date.as_deref(),
                    &format!("{sub_path}.startDate"),
                    &mut errors,
                );
                validate_date(&start_date, &format!("{sub_path}.startDate"), &mut errors);
                if let Some(end_date) = raw_sub_task.end_date.as_deref() {
                    validate_date(end_date, &format!("{sub_path}.endDate"), &mut errors);
                    if !start_date.is_empty() && end_date < start_date.as_str() {
                        errors.push(issue(
                            &format!("{sub_path}.endDate"),
                            "结束日期不能早于开始日期",
                        ));
                    }
                }
                let supplied_sub_id = normalized_optional_id(
                    raw_sub_task.id.as_deref(),
                    &format!("{sub_path}.id"),
                    &mut errors,
                );
                if let Some(id) = supplied_sub_id.as_deref() {
                    if !supplied_sub_task_ids.insert(id.to_owned()) {
                        errors.push(issue(
                            &format!("{sub_path}.id"),
                            &format!("子任务 id {id} 重复"),
                        ));
                    }
                }
                let resolved_sub_id = match supplied_sub_id {
                    Some(id) => id,
                    None if mode == ImportMode::Overwrite => {
                        errors.push(issue(
                            &format!("{sub_path}.id"),
                            "覆盖导入要求子任务包含 id",
                        ));
                        generated_id("subtask")
                    }
                    None => existing_mother
                        .and_then(|mother| {
                            mother.sub_tasks.iter().find(|sub_task| {
                                sub_task.name == sub_name && sub_task.start_date == start_date
                            })
                        })
                        .map_or_else(|| generated_id("subtask"), |task| task.id.clone()),
                };
                prepared_sub_tasks.push(PreparedSubTask {
                    id: resolved_sub_id,
                    name: sub_name,
                    start_date,
                    end_date: raw_sub_task.end_date,
                });
            }

            let depends_on = raw_task.depends_on.unwrap_or_default();
            let unique_dependencies: HashSet<_> = depends_on.iter().collect();
            if unique_dependencies.len() != depends_on.len() {
                errors.push(issue(
                    &format!("{task_path}.dependsOn"),
                    "前置母任务 id 不能重复",
                ));
            }
            if depends_on.iter().any(|id| id == &resolved_id) {
                errors.push(issue(
                    &format!("{task_path}.dependsOn"),
                    "母任务不能依赖自身",
                ));
            }
            prepared_tasks.push(PreparedMotherTask {
                id: resolved_id,
                name,
                expanded: raw_task.expanded.unwrap_or(false),
                depends_on,
                sub_tasks: prepared_sub_tasks,
            });
        }

        let resolved_ids: HashSet<_> = prepared_tasks.iter().map(|task| task.id.clone()).collect();
        if resolved_ids.len() != prepared_tasks.len() {
            errors.push(issue("tasks", "多个母任务解析为同一个 id"));
        }
        let available_ids: HashSet<String> = if mode == ImportMode::Merge {
            current
                .tasks
                .iter()
                .map(|task| task.id.clone())
                .chain(resolved_ids.iter().cloned())
                .collect()
        } else {
            resolved_ids.clone()
        };
        for (index, task) in prepared_tasks.iter().enumerate() {
            for dependency_id in &task.depends_on {
                if !available_ids.contains(dependency_id) {
                    errors.push(issue(
                        &format!("tasks[{index}].dependsOn"),
                        &format!("前置母任务 id {dependency_id} 不存在"),
                    ));
                }
            }
        }

        let mut graph: HashMap<String, Vec<String>> = if mode == ImportMode::Merge {
            current
                .tasks
                .iter()
                .map(|task| (task.id.clone(), task.depends_on.clone()))
                .collect()
        } else {
            HashMap::new()
        };
        for task in &prepared_tasks {
            graph.insert(task.id.clone(), task.depends_on.clone());
        }
        if graph_has_cycle(&graph) {
            errors.push(issue("tasks[].dependsOn", "文件会形成循环依赖"));
        }

        let document = if errors.is_empty() {
            Some(PreparedImport {
                version: version.clone().unwrap_or_else(|| EXPORT_VERSION.to_owned()),
                tasks: prepared_tasks,
            })
        } else {
            None
        };
        Ok(Preparation {
            document,
            version,
            mother_task_count,
            sub_task_count,
            dependency_count,
            errors,
        })
    }

    fn apply_prepared_import(
        &mut self,
        document: PreparedImport,
        mode: ImportMode,
    ) -> Result<(), StorageError> {
        debug_assert!(document.version.starts_with("1."));
        let transaction = self.connection.transaction()?;
        if mode == ImportMode::Overwrite {
            transaction.execute("DELETE FROM mother_tasks", [])?;
        }
        let mut next_mother_order: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM mother_tasks",
            [],
            |row| row.get(0),
        )?;

        for (index, task) in document.tasks.iter().enumerate() {
            let existing_order: Option<i64> = transaction
                .query_row(
                    "SELECT sort_order FROM mother_tasks WHERE id = ?1",
                    [&task.id],
                    |row| row.get(0),
                )
                .optional()?;
            let sort_order = if mode == ImportMode::Overwrite {
                index as i64
            } else if let Some(order) = existing_order {
                order
            } else {
                let order = next_mother_order;
                next_mother_order += 1;
                order
            };
            transaction.execute(
                "INSERT INTO mother_tasks(id, name, expanded, sort_order)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   expanded = excluded.expanded,
                   updated_at = CURRENT_TIMESTAMP",
                params![task.id, task.name, task.expanded, sort_order],
            )?;

            let mut next_sub_order: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1
                 FROM sub_tasks WHERE mother_task_id = ?1",
                [&task.id],
                |row| row.get(0),
            )?;
            for (sub_index, sub_task) in task.sub_tasks.iter().enumerate() {
                let existing_sub_order: Option<i64> = transaction
                    .query_row(
                        "SELECT sort_order FROM sub_tasks WHERE id = ?1",
                        [&sub_task.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let sub_order = if mode == ImportMode::Overwrite {
                    sub_index as i64
                } else if let Some(order) = existing_sub_order {
                    order
                } else {
                    let order = next_sub_order;
                    next_sub_order += 1;
                    order
                };
                transaction.execute(
                    "INSERT INTO sub_tasks(
                        id, mother_task_id, name, start_date, end_date, sort_order
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                       mother_task_id = excluded.mother_task_id,
                       name = excluded.name,
                       start_date = excluded.start_date,
                       end_date = excluded.end_date,
                       updated_at = CURRENT_TIMESTAMP",
                    params![
                        sub_task.id,
                        task.id,
                        sub_task.name,
                        sub_task.start_date,
                        sub_task.end_date,
                        sub_order
                    ],
                )?;
            }
        }

        for task in &document.tasks {
            transaction.execute("DELETE FROM dependencies WHERE task_id = ?1", [&task.id])?;
            for dependency_id in &task.depends_on {
                transaction.execute(
                    "INSERT INTO dependencies(task_id, depends_on_task_id) VALUES (?1, ?2)",
                    params![task.id, dependency_id],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

fn export_board(board: &BoardSnapshot) -> Result<String, StorageError> {
    let exported_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| StorageError::Validation(format!("export time failed: {error}")))?;
    let document = ExportDocument {
        version: EXPORT_VERSION,
        exported_at,
        source: "工作规划时间板",
        tasks: board.tasks.iter().map(export_mother_task).collect(),
    };
    serde_json::to_string_pretty(&document).map_err(|error| {
        StorageError::Validation(format!("planning data could not be serialized: {error}"))
    })
}

fn export_mother_task(task: &MotherTask) -> ExportMotherTask<'_> {
    ExportMotherTask {
        id: &task.id,
        name: &task.name,
        expanded: task.expanded,
        depends_on: &task.depends_on,
        sub_tasks: task.sub_tasks.iter().map(export_sub_task).collect(),
    }
}

fn export_sub_task(task: &SubTask) -> ExportSubTask<'_> {
    ExportSubTask {
        id: &task.id,
        name: &task.name,
        start_date: &task.start_date,
        end_date: task.end_date.as_deref(),
    }
}

fn read_json_file(path: &Path) -> Result<String, StorageError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err(StorageError::Validation("请选择 .json 格式文件".to_owned()));
    }
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_IMPORT_BYTES as u64 {
        return Err(StorageError::Validation("文件超过 10 MB 限制".to_owned()));
    }
    fs::read_to_string(path).map_err(Into::into)
}

fn ensure_json_extension(path: &Path) -> PathBuf {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        path.to_owned()
    } else {
        path.with_extension("json")
    }
}

fn normalized_required(
    value: Option<&str>,
    path: &str,
    errors: &mut Vec<ValidationIssue>,
) -> String {
    let value = value.unwrap_or_default().trim();
    if value.is_empty() {
        errors.push(issue(path, "字段不能为空"));
    }
    value.to_owned()
}

fn normalized_optional_id(
    value: Option<&str>,
    path: &str,
    errors: &mut Vec<ValidationIssue>,
) -> Option<String> {
    value.map(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            errors.push(issue(path, "id 不能为空字符串"));
        }
        trimmed.to_owned()
    })
}

fn validate_date(value: &str, path: &str, errors: &mut Vec<ValidationIssue>) {
    if value.is_empty() {
        return;
    }
    if time::Date::parse(value, &time::format_description::well_known::Iso8601::DATE).is_err() {
        errors.push(issue(path, "日期必须是有效的 YYYY-MM-DD"));
    }
}

fn generated_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

fn issue(path: &str, message: &str) -> ValidationIssue {
    ValidationIssue {
        path: path.to_owned(),
        message: message.to_owned(),
    }
}

fn graph_has_cycle(graph: &HashMap<String, Vec<String>>) -> bool {
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
        for dependency in graph.get(node).into_iter().flatten() {
            if visit(dependency, graph, visiting, visited) {
                return true;
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

    use crate::domain::CreateSubTaskInput;

    use super::*;

    const VALID_JSON: &str = r#"{
      "version": "1.0",
      "tasks": [
        {
          "id": "T-001",
          "name": "Discovery",
          "expanded": true,
          "dependsOn": [],
          "subTasks": [
            {
              "id": "S-001",
              "name": "Research",
              "startDate": "2026-09-17",
              "endDate": null
            }
          ]
        },
        {
          "id": "T-002",
          "name": "Delivery",
          "dependsOn": ["T-001"],
          "subTasks": []
        }
      ]
    }"#;

    #[test]
    fn previews_and_overwrites_valid_json() {
        let mut storage = Storage::open_in_memory().expect("open database");
        storage
            .create_mother_task("Existing")
            .expect("create existing task");

        let preview = storage
            .analyze_import_content(VALID_JSON, ImportMode::Overwrite)
            .expect("analyze import");
        assert!(preview.valid);
        assert_eq!(preview.mother_task_count, 2);
        assert_eq!(preview.sub_task_count, 1);
        assert_eq!(preview.dependency_count, 1);

        storage
            .apply_import_content(VALID_JSON, ImportMode::Overwrite)
            .expect("apply import");
        let board = storage.load_board().expect("load board");
        assert_eq!(board.tasks.len(), 2);
        assert_eq!(board.tasks[1].depends_on, vec!["T-001"]);
        assert_eq!(board.tasks[0].sub_tasks[0].end_date, None);
    }

    #[test]
    fn reports_multiple_validation_errors_without_writing() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let existing = storage
            .create_mother_task("Keep me")
            .expect("create existing task");
        let invalid = r#"{
          "version": "2.0",
          "tasks": [{
            "id": "T-001",
            "name": "",
            "dependsOn": ["T-001", "missing"],
            "subTasks": [{
              "id": "S-001",
              "name": "Broken",
              "startDate": "2026-02-30",
              "endDate": "2026-02-01"
            }]
          }]
        }"#;

        let preview = storage
            .analyze_import_content(invalid, ImportMode::Overwrite)
            .expect("analyze invalid import");
        assert!(!preview.valid);
        assert!(preview.errors.len() >= 4);
        assert!(storage
            .apply_import_content(invalid, ImportMode::Overwrite)
            .is_err());
        assert_eq!(
            storage.load_board().expect("load board").tasks[0].id,
            existing.id
        );
    }

    #[test]
    fn merge_updates_matches_and_keeps_unmentioned_tasks() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let existing = storage
            .create_mother_task("Existing")
            .expect("create existing task");
        let child = storage
            .create_sub_task(&CreateSubTaskInput {
                mother_task_id: existing.id.clone(),
                name: "Child".to_owned(),
                start_date: "2026-09-17".to_owned(),
                end_date: None,
            })
            .expect("create child");
        storage
            .create_mother_task("Untouched")
            .expect("create untouched task");
        let merge = format!(
            r#"{{
              "version": "1.0",
              "tasks": [{{
                "id": "{}",
                "name": "Renamed",
                "expanded": false,
                "subTasks": [{{
                  "id": "{}",
                  "name": "Updated child",
                  "startDate": "2026-09-18"
                }}]
              }}]
            }}"#,
            existing.id, child.id
        );

        storage
            .apply_import_content(&merge, ImportMode::Merge)
            .expect("merge import");
        let board = storage.load_board().expect("load board");
        assert_eq!(board.tasks.len(), 2);
        assert_eq!(board.tasks[0].name, "Renamed");
        assert_eq!(board.tasks[0].sub_tasks[0].name, "Updated child");
        assert_eq!(board.tasks[1].name, "Untouched");
    }

    #[test]
    fn merge_matches_missing_ids_and_generates_ids_for_new_items() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let existing = storage
            .create_mother_task("Existing")
            .expect("create existing task");
        let child = storage
            .create_sub_task(&CreateSubTaskInput {
                mother_task_id: existing.id.clone(),
                name: "Child".to_owned(),
                start_date: "2026-09-17".to_owned(),
                end_date: None,
            })
            .expect("create child");
        let merge = r#"{
          "version": "1.0",
          "tasks": [
            {
              "name": "Existing",
              "subTasks": [{
                "name": "Child",
                "startDate": "2026-09-17",
                "endDate": "2026-09-19"
              }]
            },
            {
              "name": "Generated",
              "subTasks": [{"name": "New child", "startDate": "2026-09-20"}]
            }
          ]
        }"#;

        storage
            .apply_import_content(merge, ImportMode::Merge)
            .expect("merge idless import");
        let board = storage.load_board().expect("load board");
        assert_eq!(board.tasks.len(), 2);
        assert_eq!(board.tasks[0].id, existing.id);
        assert_eq!(board.tasks[0].sub_tasks[0].id, child.id);
        assert_eq!(
            board.tasks[0].sub_tasks[0].end_date.as_deref(),
            Some("2026-09-19")
        );
        assert!(board.tasks[1].id.starts_with("task_"));
        assert!(board.tasks[1].sub_tasks[0].id.starts_with("subtask_"));
    }

    #[test]
    fn export_round_trip_preserves_planning_semantics() {
        let mut storage = Storage::open_in_memory().expect("open database");
        storage
            .apply_import_content(VALID_JSON, ImportMode::Overwrite)
            .expect("seed import");
        let exported = storage.export_json_content().expect("export content");
        let mut restored = Storage::open_in_memory().expect("open restored database");
        restored
            .apply_import_content(&exported, ImportMode::Overwrite)
            .expect("restore export");

        assert_eq!(
            storage.load_board().expect("load source").tasks,
            restored.load_board().expect("load restored").tasks
        );
    }

    #[test]
    fn reads_bom_and_writes_json_file() {
        let directory = tempdir().expect("temp directory");
        let mut storage = Storage::open_in_memory().expect("open database");
        let import_path = directory.path().join("import.json");
        fs::write(&import_path, format!("\u{feff}{VALID_JSON}")).expect("write import fixture");
        storage
            .apply_import_file(&import_path, ImportMode::Overwrite)
            .expect("import BOM file");
        let export_path = directory.path().join("backup");
        storage.export_json_file(&export_path).expect("export file");

        assert!(directory.path().join("backup.json").exists());
    }
}
