use std::{env, fs, path::PathBuf};

/// The Windows application manifest, embedded in every binary this crate
/// produces rather than in the app executable alone.
///
/// This is byte-for-byte the manifest `tauri-build` embeds by default. The
/// difference is who links it: tauri-build hands its compiled resource to
/// `embed-resource`, which emits `cargo:rustc-link-arg-bins` — the app
/// executable and nothing else. The unit-test harness (`gitnado_lib-*.exe`) is
/// not a bin target, so it got no manifest at all.
///
/// That was harmless until `src/menu.rs` started using `tauri::menu`, which
/// links `muda` into the library. muda's Windows about-dialog imports
/// `TaskDialogIndirect`, and only the side-by-side Common-Controls v6 assembly
/// exports it. With no manifest naming that assembly the loader binds
/// comctl32 5.82 from System32, cannot find the export, and kills the process
/// before `main` with STATUS_ENTRYPOINT_NOT_FOUND — `cargo test` on Windows
/// could not run a single test, and said nothing about why.
///
/// Passing the manifest straight to the linker covers every artifact, tests
/// included. Two RT_MANIFEST resources in one image is a fatal CVT1100
/// duplicate-resource error, so tauri-build's copy has to go: the manifest is
/// moved here, not duplicated.
const WINDOWS_APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "msvc" {
        let manifest = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"))
            .join("gitnado.exe.manifest");
        fs::write(&manifest, WINDOWS_APP_MANIFEST).expect("failed to write the Windows manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());

        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("failed to run tauri-build");
        return;
    }

    tauri_build::build()
}
