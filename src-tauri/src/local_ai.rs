//! One-click local AI: finds Ollama or installs a tested build of it, runs
//! the server while the app is open, and downloads models with progress.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_http::reqwest;

/// The Ollama release this app installs. Bumped deliberately, after testing.
const OLLAMA_VERSION: &str = "v0.40.11";
const SERVER: &str = "http://127.0.0.1:11434";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Default)]
pub struct LocalAi {
    /// The server we started, so we can stop it when the app quits.
    server: Mutex<Option<Child>>,
    cancel: AtomicBool,
}

impl LocalAi {
    pub fn shutdown(&self) {
        if let Some(mut child) = self.server.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    stage: &'static str,
    status: String,
    done: u64,
    total: u64,
}

fn progress<R: Runtime>(app: &AppHandle<R>, stage: &'static str, status: impl Into<String>, done: u64, total: u64) {
    let _ = app.emit("local-ai-progress", Progress { stage, status: status.into(), done, total });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    name: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The server answers on `url`.
    running: bool,
    /// An Ollama binary exists (ours or the user's).
    installed: bool,
    /// The binary is the one this app installed.
    managed: bool,
    version: Option<String>,
    models: Vec<ModelInfo>,
    ram_gb: f64,
    gpu: Option<String>,
    url: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("formwright/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(err)
}

/// The release asset for this computer, if Ollama ships one.
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("ollama-linux-amd64.tar.zst"),
        ("linux", "aarch64") => Some("ollama-linux-arm64.tar.zst"),
        ("macos", _) => Some("ollama-darwin.tgz"),
        ("windows", "x86_64") => Some("ollama-windows-amd64.zip"),
        ("windows", "aarch64") => Some("ollama-windows-arm64.zip"),
        _ => None,
    }
}

const EXE: &str = if cfg!(windows) { "ollama.exe" } else { "ollama" };

fn managed_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(err)?.join("ollama"))
}

/// Looks for the binary in an unpacked release (it moves between layouts).
fn find_in(dir: &Path, depth: usize) -> Option<PathBuf> {
    let direct = dir.join(EXE);
    if direct.is_file() {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().is_dir()).find_map(|e| find_in(&e.path(), depth - 1))
}

/// An Ollama the user already has, in PATH or the usual install locations.
fn system_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).map(|d| d.join(EXE)).collect()).unwrap_or_default();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if cfg!(target_os = "macos") {
        candidates.push("/Applications/Ollama.app/Contents/Resources/ollama".into());
        candidates.push("/opt/homebrew/bin/ollama".into());
        candidates.push("/usr/local/bin/ollama".into());
    } else if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs").join("Ollama").join(EXE));
        }
    } else {
        candidates.push("/usr/local/bin/ollama".into());
        candidates.push("/usr/bin/ollama".into());
        if let Some(h) = &home {
            candidates.push(h.join(".local/bin/ollama"));
            candidates.push(h.join(".local/share/ollama/bin/ollama"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn binary<R: Runtime>(app: &AppHandle<R>) -> Option<(PathBuf, bool)> {
    if let Some(p) = system_binary() {
        return Some((p, false));
    }
    let dir = managed_dir(app).ok()?;
    find_in(&dir, 3).map(|p| (p, true))
}

fn nvidia_gpu() -> bool {
    if cfg!(target_os = "linux") {
        Path::new("/proc/driver/nvidia/version").exists()
    } else if cfg!(windows) {
        std::env::var_os("SystemRoot").is_some_and(|r| PathBuf::from(r).join("System32").join("nvidia-smi.exe").exists())
    } else {
        false
    }
}

fn gpu_label() -> Option<String> {
    if nvidia_gpu() {
        Some("NVIDIA".into())
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("Apple silicon".into())
    } else {
        None
    }
}

fn ram_gb() -> f64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory() as f64 / 1_073_741_824.0
}

async fn server_version() -> Option<String> {
    let c = client().ok()?;
    let r = c.get(format!("{SERVER}/api/version")).timeout(Duration::from_millis(1500)).send().await.ok()?;
    let v: serde_json::Value = serde_json::from_slice(&r.bytes().await.ok()?).ok()?;
    v["version"].as_str().map(str::to_string)
}

async fn models() -> Vec<ModelInfo> {
    let Ok(c) = client() else { return vec![] };
    let Ok(r) = c.get(format!("{SERVER}/api/tags")).timeout(Duration::from_secs(3)).send().await else { return vec![] };
    let Ok(bytes) = r.bytes().await else { return vec![] };
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    v["models"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| Some(ModelInfo { name: m["name"].as_str()?.to_string(), size: m["size"].as_u64().unwrap_or(0) })).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn local_ai_status(app: AppHandle) -> Result<Status, String> {
    let version = server_version().await;
    let bin = binary(&app);
    Ok(Status {
        running: version.is_some(),
        installed: bin.is_some() || version.is_some(),
        managed: bin.as_ref().is_some_and(|b| b.1),
        models: if version.is_some() { models().await } else { vec![] },
        version,
        ram_gb: ram_gb(),
        gpu: gpu_label(),
        url: SERVER.into(),
    })
}

/// Downloads `url` to `dest`, reporting progress and returning the SHA-256.
async fn download<R: Runtime>(app: &AppHandle<R>, state: &LocalAi, url: &str, dest: &Path) -> Result<String, String> {
    let resp = client()?.get(url).send().await.map_err(err)?.error_for_status().map_err(err)?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(err)?;
    let mut hash = Sha256::new();
    let mut done = 0u64;
    let mut last = 0u64;
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(err)? {
        if state.cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        file.write_all(&chunk).map_err(err)?;
        hash.update(&chunk);
        done += chunk.len() as u64;
        if done - last > 4 << 20 || done == total {
            last = done;
            progress(app, "engine", "Downloading the local AI engine", done, total);
        }
    }
    file.flush().map_err(err)?;
    Ok(hex::encode(hash.finalize()))
}

/// GPU libraries the computer can't use are skipped: on Linux and Windows
/// they are most of the download's size on disk.
fn wanted(path: &Path, keep_cuda: bool) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");
    keep_cuda || !(s.contains("lib/ollama/cuda_") || s.contains("lib/ollama/rocm"))
}

fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(err)?;
    let keep_cuda = nvidia_gpu();
    let file = std::fs::File::open(archive).map_err(err)?;
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        #[cfg(windows)]
        {
            let mut zip = zip::ZipArchive::new(file).map_err(err)?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i).map_err(err)?;
                let Some(rel) = entry.enclosed_name() else { continue };
                if !wanted(&rel, keep_cuda) {
                    continue;
                }
                let out = dest.join(rel);
                if entry.is_dir() {
                    std::fs::create_dir_all(&out).map_err(err)?;
                } else {
                    if let Some(parent) = out.parent() {
                        std::fs::create_dir_all(parent).map_err(err)?;
                    }
                    let mut f = std::fs::File::create(&out).map_err(err)?;
                    std::io::copy(&mut entry, &mut f).map_err(err)?;
                }
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            let _ = (file, keep_cuda);
            return Err("zip archives are only used on Windows".into());
        }
    }
    let reader: Box<dyn std::io::Read> = if name.ends_with(".tar.zst") {
        #[cfg(target_os = "linux")]
        {
            Box::new(zstd::stream::read::Decoder::new(file).map_err(err)?)
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err("zstd archives are only used on Linux".into());
        }
    } else {
        Box::new(flate2::read::GzDecoder::new(file))
    };
    let mut tar = tar::Archive::new(reader);
    for entry in tar.entries().map_err(err)? {
        let mut entry = entry.map_err(err)?;
        let path = entry.path().map_err(err)?.into_owned();
        if wanted(&path, keep_cuda) {
            entry.unpack_in(dest).map_err(err)?;
        }
    }
    Ok(())
}

/// Installs Ollama into the app's data folder, unless one is already there.
#[tauri::command]
pub async fn local_ai_install(app: AppHandle, state: State<'_, LocalAi>) -> Result<(), String> {
    if binary(&app).is_some() || server_version().await.is_some() {
        return Ok(());
    }
    state.cancel.store(false, Ordering::Relaxed);
    let asset = asset().ok_or("Local AI isn't available for this kind of computer")?;
    let base = format!("https://github.com/ollama/ollama/releases/download/{OLLAMA_VERSION}");
    let sums = client()?.get(format!("{base}/sha256sum.txt")).send().await.map_err(err)?.error_for_status().map_err(err)?.text().await.map_err(err)?;
    // Lines look like "<sha256>  ./ollama-linux-amd64.tar.zst".
    let expected = sums
        .lines()
        .find_map(|l| {
            let mut parts = l.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?.trim_start_matches(['*', '.', '/']);
            (name == asset).then(|| hash.to_string())
        })
        .ok_or("the release has no checksum for this download")?;

    let dir = managed_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let archive = dir.join(asset);
    let got = download(&app, &state, &format!("{base}/{asset}"), &archive).await;
    let got = match got {
        Ok(h) => h,
        Err(e) => {
            let _ = std::fs::remove_file(&archive);
            return Err(e);
        }
    };
    if !got.eq_ignore_ascii_case(&expected) {
        let _ = std::fs::remove_file(&archive);
        return Err("the download was corrupted (checksum mismatch); please try again".into());
    }

    progress(&app, "engine", "Unpacking", 0, 0);
    let unpack_dir = dir.clone();
    let archive_path = archive.clone();
    tauri::async_runtime::spawn_blocking(move || extract(&archive_path, &unpack_dir)).await.map_err(err)??;
    let _ = std::fs::remove_file(&archive);
    let exe = find_in(&dir, 3).ok_or("the download didn't contain the engine")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    Ok(())
}

/// Starts the server (unless one is already running) and waits until it answers.
#[tauri::command]
pub async fn local_ai_start(app: AppHandle, state: State<'_, LocalAi>) -> Result<(), String> {
    if server_version().await.is_some() {
        return Ok(());
    }
    let (exe, _) = binary(&app).ok_or("The local AI engine isn't installed. Open Settings → Local model to install it.")?;
    let log_dir = app.path().app_log_dir().map_err(err)?;
    std::fs::create_dir_all(&log_dir).map_err(err)?;
    let log = std::fs::File::create(log_dir.join("ollama.log")).map_err(err)?;
    let mut cmd = Command::new(&exe);
    cmd.arg("serve")
        .env("OLLAMA_HOST", "127.0.0.1:11434")
        // The CAD tools and instructions need more than Ollama's default context.
        .env("OLLAMA_CONTEXT_LENGTH", "16384")
        .env("OLLAMA_KEEP_ALIVE", "30m")
        .env("OLLAMA_MAX_LOADED_MODELS", "1")
        .env("OLLAMA_NUM_PARALLEL", "1")
        .env("OLLAMA_FLASH_ATTENTION", "1")
        .env("OLLAMA_KV_CACHE_TYPE", "q8_0")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(err)?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("couldn't start the local AI engine: {e}"))?;
    *state.server.lock().unwrap() = Some(child);
    for _ in 0..60 {
        if server_version().await.is_some() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("the local AI engine didn't start; see ollama.log in the app's log folder".into())
}

/// Downloads a model, reporting combined progress over all of its layers.
#[tauri::command]
pub async fn local_ai_pull(app: AppHandle, state: State<'_, LocalAi>, model: String) -> Result<(), String> {
    state.cancel.store(false, Ordering::Relaxed);
    let body = serde_json::to_vec(&serde_json::json!({ "model": model, "stream": true })).map_err(err)?;
    let mut resp = client()?
        .post(format!("{SERVER}/api/pull"))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    let mut layers: std::collections::HashMap<String, (u64, u64)> = Default::default();
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(err)? {
        if state.cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
            if let Some(e) = v["error"].as_str() {
                return Err(e.to_string());
            }
            let status = v["status"].as_str().unwrap_or("").to_string();
            if let (Some(d), Some(t)) = (v["digest"].as_str(), v["total"].as_u64()) {
                layers.insert(d.to_string(), (v["completed"].as_u64().unwrap_or(0), t));
            }
            let (done, total) = layers.values().fold((0, 0), |(a, b), (d, t)| (a + d, b + t));
            if status == "success" {
                progress(&app, "model", "Ready", total, total);
                return Ok(());
            }
            let label = if status.starts_with("pulling") && total > 0 { "Downloading the model".to_string() } else { capitalise(&status) };
            progress(&app, "model", label, done, total);
        }
    }
    Err("the download stopped before it finished".into())
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[tauri::command]
pub async fn local_ai_remove(model: String) -> Result<(), String> {
    let body = serde_json::to_vec(&serde_json::json!({ "model": model })).map_err(err)?;
    client()?
        .delete(format!("{SERVER}/api/delete"))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn local_ai_cancel(state: State<'_, LocalAi>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unpacks a real Ollama release (point FORMWRIGHT_OLLAMA_ARCHIVE at one;
    /// skipped otherwise, since it's a 1.4 GB download).
    #[test]
    fn unpacks_a_release_without_unusable_gpu_libraries() {
        let Some(archive) = std::env::var_os("FORMWRIGHT_OLLAMA_ARCHIVE").map(PathBuf::from) else { return };
        let dest = std::env::temp_dir().join(format!("formwright-ollama-{}", std::process::id()));
        extract(&archive, &dest).unwrap();
        let exe = find_in(&dest, 3).expect("binary unpacked");
        assert!(std::fs::metadata(&exe).unwrap().len() > 1_000_000);
        if !nvidia_gpu() {
            let cuda = walk(&dest).into_iter().filter(|p| p.to_string_lossy().contains("cuda_")).count();
            assert_eq!(cuda, 0, "CUDA libraries skipped without an NVIDIA GPU");
        }
        std::fs::remove_dir_all(dest).unwrap();
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            }
            out.push(p);
        }
        out
    }

    #[test]
    fn knows_a_download_for_this_computer() {
        assert!(asset().is_some());
        assert!(ram_gb() > 0.5);
    }
}
