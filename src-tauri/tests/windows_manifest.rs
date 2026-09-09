//! The Windows application manifest has to reach every binary, not just the app.
//!
//! `muda` — linked in by `src/menu.rs` — imports `TaskDialogIndirect`, which
//! only the side-by-side Common-Controls v6 assembly exports. A binary whose
//! manifest does not name that assembly is bound against comctl32 5.82 and is
//! killed by the loader before `main` with STATUS_ENTRYPOINT_NOT_FOUND. That is
//! what happened to the unit-test harness: `tauri-build` embeds its manifest
//! through `embed-resource`, which links it into bin targets only.
//!
//! None of that can be observed from a Linux or macOS runner, and on Windows it
//! shows up as an exit status with no message attached. So pin the mechanism
//! instead: the manifest is ours, tauri-build's is switched off, and it is
//! handed to the linker for every artifact.

const BUILD_RS: &str = include_str!("../build.rs");

#[test]
fn the_manifest_declares_common_controls_v6() {
    assert!(
        BUILD_RS.contains(r#"name="Microsoft.Windows.Common-Controls""#)
            && BUILD_RS.contains(r#"version="6.0.0.0""#),
        "build.rs must embed a manifest declaring Common-Controls v6; without it \
         the test harness cannot even load on Windows"
    );
}

#[test]
fn tauri_builds_own_manifest_is_switched_off() {
    assert!(
        BUILD_RS.contains("new_without_app_manifest"),
        "tauri-build must not embed its own manifest as well: two RT_MANIFEST \
         resources in one image is a fatal CVT1100 duplicate-resource link error"
    );
}

#[test]
fn the_manifest_is_linked_into_every_artifact_not_only_bins() {
    assert!(
        BUILD_RS.contains("cargo:rustc-link-arg=/MANIFEST:EMBED")
            && BUILD_RS.contains("cargo:rustc-link-arg=/MANIFESTINPUT:"),
        "the manifest must go through `cargo:rustc-link-arg`, which covers every \
         linked artifact. `-bins` is what left the harness without one, and \
         `-tests` does not reach the lib's own unit-test binary either"
    );
}
