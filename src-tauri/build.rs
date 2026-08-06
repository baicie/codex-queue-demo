fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_info",
            "load_queue",
            "save_queue",
            "run_queue",
            "list_task_runs",
            "read_task_run",
        ]),
    ))
    .expect("failed to build Tauri application");
}
