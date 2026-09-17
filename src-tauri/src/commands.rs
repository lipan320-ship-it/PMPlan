use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::{
    domain::{
        BoardSnapshot, CreateMotherTaskInput, CreateSubTaskInput, MotherTask,
        RenameMotherTaskInput, SetDependenciesInput, SetMotherExpandedInput, SubTask,
        UpdateSubTaskInput, ViewSettings,
    },
    storage::{Storage, StorageError},
};

pub struct AppState {
    storage: Mutex<Storage>,
}

impl AppState {
    pub fn new(storage: Storage) -> Self {
        Self {
            storage: Mutex::new(storage),
        }
    }

    fn with_storage<T>(
        &self,
        operation: impl FnOnce(&mut Storage) -> Result<T, StorageError>,
    ) -> Result<T, CommandError> {
        let mut storage = self.storage.lock().map_err(|_| CommandError {
            code: "storage_unavailable".to_owned(),
            message: "local storage is temporarily unavailable".to_owned(),
        })?;
        operation(&mut storage).map_err(Into::into)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<StorageError> for CommandError {
    fn from(value: StorageError) -> Self {
        let code = value.code().to_owned();
        let message = match &value {
            StorageError::Validation(_) | StorageError::NotFound(_) | StorageError::Conflict(_) => {
                value.to_string()
            }
            StorageError::Migration(_) => "local database schema is not supported".to_owned(),
            StorageError::Database(_) => "local database operation failed".to_owned(),
            StorageError::Io(_) => "local data directory is unavailable".to_owned(),
        };
        Self { code, message }
    }
}

#[tauri::command(async)]
pub fn load_board(state: State<'_, AppState>) -> Result<BoardSnapshot, CommandError> {
    state.with_storage(|storage| storage.load_board())
}

#[tauri::command(async)]
pub fn create_mother_task(
    state: State<'_, AppState>,
    input: CreateMotherTaskInput,
) -> Result<MotherTask, CommandError> {
    state.with_storage(|storage| storage.create_mother_task(&input.name))
}

#[tauri::command(async)]
pub fn rename_mother_task(
    state: State<'_, AppState>,
    input: RenameMotherTaskInput,
) -> Result<(), CommandError> {
    state.with_storage(|storage| storage.rename_mother_task(&input.id, &input.name))
}

#[tauri::command(async)]
pub fn set_mother_expanded(
    state: State<'_, AppState>,
    input: SetMotherExpandedInput,
) -> Result<(), CommandError> {
    state.with_storage(|storage| storage.set_mother_expanded(&input.id, input.expanded))
}

#[tauri::command(async)]
pub fn delete_mother_task(state: State<'_, AppState>, id: String) -> Result<(), CommandError> {
    state.with_storage(|storage| storage.delete_mother_task(&id))
}

#[tauri::command(async)]
pub fn create_sub_task(
    state: State<'_, AppState>,
    input: CreateSubTaskInput,
) -> Result<SubTask, CommandError> {
    state.with_storage(|storage| storage.create_sub_task(&input))
}

#[tauri::command(async)]
pub fn update_sub_task(
    state: State<'_, AppState>,
    input: UpdateSubTaskInput,
) -> Result<(), CommandError> {
    state.with_storage(|storage| storage.update_sub_task(&input))
}

#[tauri::command(async)]
pub fn delete_sub_task(state: State<'_, AppState>, id: String) -> Result<(), CommandError> {
    state.with_storage(|storage| storage.delete_sub_task(&id))
}

#[tauri::command(async)]
pub fn set_dependencies(
    state: State<'_, AppState>,
    input: SetDependenciesInput,
) -> Result<Vec<String>, CommandError> {
    state.with_storage(|storage| storage.set_dependencies(&input.task_id, &input.depends_on))
}

#[tauri::command(async)]
pub fn save_view_settings(
    state: State<'_, AppState>,
    settings: ViewSettings,
) -> Result<(), CommandError> {
    state.with_storage(|storage| storage.save_view_settings(&settings))
}

#[cfg(test)]
mod tests {
    use rusqlite::Error as SqlError;

    use super::*;

    #[test]
    fn hides_database_details_from_command_errors() {
        let error = CommandError::from(StorageError::Database(SqlError::InvalidQuery));

        assert_eq!(error.code, "database_error");
        assert_eq!(error.message, "local database operation failed");
        assert!(!error.message.contains("query"));
    }
}
