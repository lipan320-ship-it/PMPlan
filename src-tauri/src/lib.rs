#![allow(linker_messages)]

mod commands;
mod domain;
mod storage;
mod transfer;

use tauri::Manager;

pub const PRODUCT_NAME: &str = "工作规划时间板";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let database_path = app.path().app_local_data_dir()?.join("pmplan.sqlite3");
            let storage = storage::Storage::open(&database_path)?;
            app.manage(commands::AppState::new(storage));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_board,
            commands::create_mother_task,
            commands::rename_mother_task,
            commands::set_mother_expanded,
            commands::delete_mother_task,
            commands::create_sub_task,
            commands::update_sub_task,
            commands::delete_sub_task,
            commands::set_dependencies,
            commands::save_view_settings,
            commands::analyze_import_content,
            commands::analyze_import_file,
            commands::apply_import_content,
            commands::apply_import_file,
            commands::export_json_content,
            commands::export_json_file,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PMPlan desktop application");
}

#[cfg(test)]
mod tests {
    use super::PRODUCT_NAME;

    #[test]
    fn product_name_is_stable() {
        assert_eq!(PRODUCT_NAME, "工作规划时间板");
    }
}
