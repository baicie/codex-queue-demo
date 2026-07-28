fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_info",
            "load_queue",
            "save_queue",
            "run_queue",
        ]),
    ))
    .expect("failed to build Tauri application");
}
