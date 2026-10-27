use base64::Engine;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::str::FromStr;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(err)?.join("settings.json"))
}

/// Settings (including the API key) live in the app's config directory,
/// readable only by the user on Unix.
#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(settings_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(err)?;
    let path = settings_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(err)?;
    }
    std::fs::rename(&tmp, &path).map_err(err)
}

/// Writes a file the user picked in a save dialog. `path` is a filesystem
/// path on desktop and a `content://` URI on Android.
#[tauri::command]
fn write_file<R: Runtime>(app: AppHandle<R>, path: String, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(err)?;
    let mut opts = OpenOptions::new();
    opts.read(false).write(true).create(true).truncate(true);
    let target = FilePath::from_str(&path).map_err(err)?;
    let mut file = app.fs().open(target, opts).map_err(err)?;
    file.write_all(&bytes).map_err(err)?;
    file.flush().map_err(err)
}

/// Reads a file the user picked in an open dialog (path or `content://` URI).
#[tauri::command]
fn read_text_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<String, String> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    let source = FilePath::from_str(&path).map_err(err)?;
    let mut text = String::new();
    app.fs().open(source, opts).map_err(err)?.read_to_string(&mut text).map_err(err)?;
    Ok(text)
}

/// Desktop updates come from the signed `latest.json` on GitHub releases.
/// (Android checks GitHub from the webview and hands the APK to the system.)
#[cfg(desktop)]
mod update {
    use super::err;
    use std::sync::Mutex;
    use tauri::{AppHandle, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    #[derive(Default)]
    pub struct Pending(Mutex<Option<Update>>);

    #[tauri::command]
    pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<String>, String> {
        let update = app.updater().map_err(err)?.check().await.map_err(err)?;
        let version = update.as_ref().map(|u| u.version.clone());
        *pending.0.lock().unwrap() = update;
        Ok(version)
    }

    #[tauri::command]
    pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
        let update = pending.0.lock().unwrap().take().ok_or("no update is pending")?;
        update.download_and_install(|_, _| {}, || {}).await.map_err(err)?;
        app.restart()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::Pending::default())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            write_file,
            read_text_file,
            update::update_check,
            update::update_install
        ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![load_settings, save_settings, write_file, read_text_file]);
    builder.run(tauri::generate_context!()).expect("error while running Formwright");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_files_through_the_fs_plugin() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let dir = std::env::temp_dir().join(format!("formwright-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.formwright").to_string_lossy().into_owned();

        let data = base64::engine::general_purpose::STANDARD.encode("{\"version\":1,\"nodes\":[]}");
        write_file(app.handle().clone(), path.clone(), data).unwrap();
        assert_eq!(read_text_file(app.handle().clone(), path.clone()).unwrap(), r#"{"version":1,"nodes":[]}"#);

        // Saving again over a longer file must not leave its tail behind.
        let short = base64::engine::general_purpose::STANDARD.encode("{}");
        write_file(app.handle().clone(), path.clone(), short).unwrap();
        assert_eq!(read_text_file(app.handle().clone(), path).unwrap(), "{}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
