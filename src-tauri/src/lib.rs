mod codex_supervisor;
mod commands;

use codex_supervisor::CodexSupervisorState;
use commands::RunState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CodexSupervisorState::default())
        .manage(RunState::default())
        .setup(|app| {
            codex_supervisor::start_watchdog(
                app.handle().clone(),
                app.state::<CodexSupervisorState>().inner().clone(),
            )
            .map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex_supervisor::load_codex_supervisor,
            codex_supervisor::resume_codex_thread,
            codex_supervisor::complete_codex_goal,
            commands::app_info,
            commands::load_queue,
            commands::save_queue,
            commands::run_queue,
            commands::list_task_runs,
            commands::read_task_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running Codex Queue");
}
