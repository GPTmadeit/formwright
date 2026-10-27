# Formwright

Simple, open-source CAD with an AI assistant you can talk to.

Build with shapes and holes, like Tinkercad, or describe what you want and watch the assistant build it one part at a time. You can type while it works to change course ("make it taller", "no, put the hole on the side"), press Stop, or grab any part and edit it yourself. The assistant always works from the current scene, so your edits are kept.

![Formwright](docs/screenshot.png)

## Features

- **Shapes:** box (with rounded edges), cylinder, cone, sphere, torus, wedge, tube, polygon extrusion, revolve (lathe profile).
- **Holes and groups:** mark any shape as a hole, then group it with solids to cut it out. Groups nest, move and rotate as one object.
- **Direct editing:** move, rotate and scale gizmo with snapping, exact numbers in the inspector, arrow-key nudging, undo and redo.
- **Assistant:** Claude, or a free local model installed with one click. It streams progress notes, shows each step as a clickable chip, takes interjections between steps, checks its own work by looking at rendered views, and makes every step undoable.
- **Export:** STL for 3D printing and OBJ. Scenes save as `.formwright` (JSON).
- **Runs everywhere:** Windows, macOS, Linux (x64 and ARM), Android, and in the browser for iPhone, iPad and anything else. Installed copies update themselves.

## Install

Get the latest build from [Releases](https://github.com/GPTmadeit/formwright/releases/latest):

| Platform | File |
| --- | --- |
| Windows (Intel/AMD) | `Formwright_<version>_x64-setup.exe`, or the `.msi` |
| Windows on ARM | `Formwright_<version>_arm64-setup.exe` |
| macOS (Apple Silicon and Intel) | `Formwright_<version>_universal.dmg` |
| Linux x64 | `.AppImage`, or `_amd64.deb` / `.x86_64.rpm` |
| Linux ARM64 (Raspberry Pi 5, ARM laptops) | `_aarch64.AppImage`, or `_arm64.deb` / `.aarch64.rpm` |
| Android (phones, tablets, Chromebooks) | `Formwright_<version>_android.apk` |
| iPhone, iPad, or any browser | [gptmadeit.github.io/formwright](https://gptmadeit.github.io/formwright/). Use *Add to Home Screen* to install it like an app. |

The builds aren't signed with paid developer certificates yet, so the first launch needs one extra click:

- **Windows:** on "Windows protected your PC", click *More info*, then *Run anyway*.
- **macOS:** right-click the app and choose *Open*, or use *System Settings → Privacy & Security → Open Anyway*.
- **Android:** allow your browser or file manager to install apps when asked.

**Updates:** the desktop apps update themselves from GitHub releases, each in its own format (a `.deb` install updates from the next `.deb` and asks for your password). On Android an update button downloads the new APK. The web version is always the latest tested code.

On phones and tablets, the panels open from the tab bar at the bottom. Tap a shape to select it, drag with one finger to orbit, pinch to zoom, and turn on *Pick several* in Objects to select more than one shape.

## The assistant

Open **Settings** and choose how the assistant runs.

**Claude (Anthropic API)** gives the most accurate designs. Paste an API key from [console.anthropic.com](https://console.anthropic.com/) and pick a model and effort level. The key is stored only on your computer, readable only by you, and Anthropic bills your account for usage.

**Local model (free)** runs privately on your own computer. In the desktop app, pick a tier and click *Install*; it downloads and runs [Ollama](https://ollama.com) for you (or uses yours if it's already installed) and fetches the model:

| Tier | Model | Download | Memory | Function calling (BFCL-V4) | Multi-step tool use (τ²-bench) |
| --- | --- | --- | --- | --- | --- |
| Light | Qwen3.5 4B | 3.3 GB | 8 GB | 50.3 | 79.9 |
| Better | Qwen3.5 9B | 6.6 GB | 16 GB | 66.1 | 79.1 |
| Best local | Qwen3.5 35B-A3B | 22 GB | 32 GB | 67.3 | 81.2 |

Scores are the publisher's. Settings marks the best fit for your computer. Without a graphics card the processor does all the work, so a model is much slower than on a recent laptop or a Mac: on an older 4-core PC, the light model writes about 3 words a second. No model, local or cloud, gets every design right: check what it builds, and use Claude when accuracy matters most.

The app keeps local models quick by switching off their step-by-step "thinking" (turn it back on in Settings for harder jobs, at a big cost in speed) and by having the model read its instructions in the background before your first request.

To measure models on your own hardware: `EVAL_MODELS=qwen3.5:4b,qwen3.5:9b npm run eval:local` builds a set of test parts with each model through the real assistant and checks the geometry.

The web version can't install anything, but it can use Ollama on the same computer if you start Ollama with `OLLAMA_ORIGINS=https://gptmadeit.github.io`. The Android app can use Ollama running on another machine on your network (`http://<that computer>:11434`).

Everything except the assistant works without either.

## Shortcuts

| Key | Action |
| --- | --- |
| W / E / R | Move / rotate / scale |
| Arrows, PgUp/PgDn | Nudge 1 mm (Shift: 10 mm) |
| D | Drop to workplane |
| H | Toggle solid/hole |
| F | Fit view to selection |
| Ctrl G / Ctrl Shift G | Group / ungroup |
| Ctrl D | Duplicate |
| Ctrl Z / Ctrl Shift Z | Undo / redo |
| Ctrl S / Ctrl O | Save / open |
| Del | Delete |

## Develop

```sh
npm install
npm run dev          # browser at http://localhost:1420
npm run tauri dev    # desktop app
npm run build:web    # the browser version, as deployed to GitHub Pages
npx tauri android dev  # Android (needs the Android SDK and NDK)
npm test             # model, geometry kernel and AI tool tests
npm run test:ui      # end-to-end in headless Chromium against a scripted mock API (no key, no cost)
```

Layout:

- `src/model`: scene document (shapes, groups, undo history) and transforms
- `src/geom`: geometry kernel on [Manifold](https://github.com/elalish/manifold) (WASM), plus STL/OBJ export
- `src/view`: three.js viewport, selection and gizmo
- `src/ai`: assistant loop (streaming, tool calls, interjections) and the modelling tools it can use
- `src/ui`: palette, object tree, inspector, chat panel
- `src-tauri`: desktop shell (settings storage, file dialogs, updater)

Releases: bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, push to `main`, wait for CI to pass, then push a `vX.Y.Z` tag. CI builds every platform, signs the installers and publishes them with the `latest.json` the in-app updater reads. Every push to `main` that passes tests also deploys the web version to GitHub Pages. Signing uses three repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (updates), and `ANDROID_KEYSTORE_B64` with `ANDROID_KEYSTORE_PASSWORD` (the APK).

## License

MIT or Apache-2.0, at your option.
