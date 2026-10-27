use base64::Engine;
use std::fs;
use std::path::PathBuf;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn settings_path() -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("app", "formwright", "Formwright").ok_or("no config directory")?;
    Ok(dirs.config_dir().join("settings.json"))
}

/// Settings (including the API key) live in the user's config directory,
/// readable only by them on Unix.
#[tauri::command]
fn load_settings() -> Result<Option<String>, String> {
    match fs::read_to_string(settings_path()?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn save_settings(json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(err)?;
    let path = settings_path()?;
    fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(err)?;
    }
    fs::rename(&tmp, &path).map_err(err)
}

/// Writes a file the user picked in a save dialog.
#[tauri::command]
fn write_file(path: String, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(err)?;
    fs::write(path, bytes).map_err(err)
}

/// Reads a file the user picked in an open dialog.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .invoke_handler(tauri::generate_handler![load_settings, save_settings, write_file, read_text_file])
        .run(tauri::generate_context!())
        .expect("error while running Formwright");
}
