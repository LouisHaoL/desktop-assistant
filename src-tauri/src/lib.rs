mod scheduler;
mod task_store;

use scheduler::FiredKeys;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let db = task_store::init_db(app.handle())
                .expect("数据库初始化失败");
            app.manage(db);
            app.manage(FiredKeys(Default::default()));
            scheduler::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            task_store::task_create,
            task_store::task_list,
            task_store::task_update,
            task_store::task_delete,
            task_store::task_start,
            task_store::task_finish,
            task_store::task_logs_for,
            task_store::settings_get,
            task_store::settings_set,
            scheduler::timeline_today
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
