//! Content-Security-Policy regression test for `tauri.conf.json`.
//!
//! `tauri.conf.json` must stay strict JSON — the `config-json5` feature is not
//! enabled in this dependency graph (no `json5` crate in `Cargo.lock`), so a
//! `//` comment in that file makes the build fail. This test file is therefore
//! where the CSP is documented: it pins every directive and explains why each
//! one has the value it has, so a future edit that loosens the policy fails
//! here instead of silently shipping.
//!
//! A CSP violation is only ever visible at runtime in the webview console. The
//! Playwright suite runs against the Vite dev server, which serves the app
//! WITHOUT the Tauri CSP, so E2E can never catch a regression here. This test
//! is the only automated guard.
//!
//! ## Directive rationale
//!
//! * `default-src 'self'` — fallback for every directive not listed below.
//!   Everything the webview loads is bundled by Vite and served from the app's
//!   own origin.
//!
//! * `base-uri 'self'` — an injected `<base href>` would silently re-target
//!   every relative URL in the document. Nothing in the app sets a `<base>`
//!   tag, so pinning this costs nothing.
//!
//! * `object-src 'none'` — there is no `<object>`, `<embed>` or `<applet>` in
//!   the app. Plugin content is a classic script-execution bypass.
//!
//! * `frame-src 'none'` — the app contains no `<iframe>` anywhere in `src/`.
//!   NOTE: `frame-ancestors` is deliberately NOT set. Tauri applies the CSP as
//!   a response header on Windows/macOS but injects it as a `<meta>` tag on
//!   Linux, and `frame-ancestors` is ignored (with a console warning) in a
//!   `<meta>` policy.
//!
//! * `form-action 'self'` — the app has no `<form>` elements at all; every
//!   dialog submits through Tauri IPC. This stops an injected form from
//!   POSTing scraped data to a remote endpoint.
//!
//! * `script-src 'self' 'wasm-unsafe-eval'` — `'wasm-unsafe-eval'` is required
//!   by Shiki (`src/utils/shiki-highlighter.ts`), whose Oniguruma regex engine
//!   is WebAssembly. Shiki's language grammars are dynamically imported as
//!   local Vite chunks, so they are covered by `'self'`. No inline scripts.
//!
//! * `style-src 'self' 'unsafe-inline'` — Lit components apply per-element
//!   inline `style=` attributes and fall back to injected `<style>` elements
//!   where constructable stylesheets are unavailable. Removing
//!   `'unsafe-inline'` would need a nonce/hash pipeline the build does not
//!   have; left as-is deliberately.
//!
//! * `img-src 'self' data: https:` — `data:` covers image diffs, which are
//!   base64 payloads returned by Rust (`src/components/panels/lv-image-diff.ts`
//!   builds `data:<mime>;base64,...`). The broad `https:` is REQUIRED and must
//!   not be narrowed to an allowlist: avatar URLs are supplied by the provider
//!   APIs at runtime and the app supports self-hosted instances, so the host is
//!   not knowable at build time. Evidence:
//!   - `src/graph/canvas-renderer.ts` loads `https://www.gravatar.com/avatar/...`
//!     for commit-author avatars (opt-in; when the Gravatar setting is off no
//!     network request is made at all).
//!   - `src/components/dialogs/lv-github-dialog.ts` renders
//!     `<img src="${user.avatarUrl}">` from the GitHub API — `avatars.
//!     githubusercontent.com` for github.com, but an arbitrary host for GitHub
//!     Enterprise Server.
//!   - `src/components/dialogs/lv-gitlab-dialog.ts` and
//!     `lv-bitbucket-dialog.ts` do the same with `user.avatarUrl`; GitLab
//!     avatars come from the configured instance (self-hosted GitLab is a
//!     first-class option) and Bitbucket avatars from Atlassian CDN hosts.
//!   - `src/components/dialogs/lv-azure-devops-dialog.ts` maps
//!     `user.imageUrl`, which is served by the configured Azure DevOps
//!     organisation (or a self-hosted server).
//!   - `src/components/dialogs/lv-oidc-dialog.ts` renders the OIDC `picture`
//!     claim, i.e. whatever host the user's identity provider returns.
//!
//!   `http://127.0.0.1` was removed: nothing loads an image over loopback.
//!
//! * `connect-src 'self'` — the webview makes NO remote requests. There is no
//!   `fetch()`, `XMLHttpRequest`, `EventSource` or `WebSocket` to a remote host
//!   anywhere in `src/` (the only `fetch` calls are `gitService.fetch(...)`,
//!   i.e. `git fetch` over IPC), and `@tauri-apps/plugin-http` is not a
//!   dependency. Every provider API call, OAuth token exchange, updater check
//!   and AI request is made in Rust with `reqwest`. `http://127.0.0.1` was
//!   removed too: the OAuth loopback server
//!   (`src-tauri/src/services/loopback_server.rs`) is a Rust `TcpListener` and
//!   the authorize URL is opened in the SYSTEM browser via the shell plugin
//!   (`src/services/oauth.service.ts`), so the webview never talks to it; local
//!   AI endpoints (Ollama / LM Studio) and the local MCP server are likewise
//!   reached only from Rust, with the frontend going through `invokeCommand`.
//!
//!   Tauri's own IPC uses `fetch()` to `ipc://localhost` (macOS/Linux) or
//!   `http://ipc.localhost` (Windows) and falls back to `window.ipc.postMessage`
//!   when that request is blocked. Neither origin was allowed by the previous
//!   policy either (`https:` and `http://127.0.0.1` do not match them), so the
//!   app already runs on the postMessage transport and this change does not
//!   alter that. Adding `ipc: http://ipc.localhost` here would switch the whole
//!   app to the custom-protocol transport — a real behaviour change, and
//!   deliberately out of scope for a CSP hardening change.
//!
//! * `font-src 'self' data:` — only bundled and inlined fonts; no remote font
//!   CDN is referenced from `index.html` or any stylesheet.
//!
//! ## Accepted risk (unchanged by this file)
//!
//! `src-tauri/capabilities/default.json` grants `fs:` permissions over
//! `$HOME/**`. That is intentional for a Git client — repositories live
//! anywhere under the home directory — and is documented in `CODE_REVIEW.md`.
//! The CSP above is the defence-in-depth layer around it.

use std::collections::BTreeMap;

/// The CSP exactly as it must appear in `tauri.conf.json`, split into
/// `directive -> sources`.
fn expected_directives() -> BTreeMap<&'static str, Vec<&'static str>> {
    BTreeMap::from([
        ("default-src", vec!["'self'"]),
        ("base-uri", vec!["'self'"]),
        ("object-src", vec!["'none'"]),
        ("frame-src", vec!["'none'"]),
        ("form-action", vec!["'self'"]),
        ("script-src", vec!["'self'", "'wasm-unsafe-eval'"]),
        ("style-src", vec!["'self'", "'unsafe-inline'"]),
        ("img-src", vec!["'self'", "data:", "https:"]),
        ("connect-src", vec!["'self'"]),
        ("font-src", vec!["'self'", "data:"]),
    ])
}

fn csp_from_config() -> String {
    let raw = include_str!("../tauri.conf.json");
    let config: serde_json::Value =
        serde_json::from_str(raw).expect("tauri.conf.json must be valid strict JSON");
    config["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp must be a string in tauri.conf.json")
        .to_string()
}

fn parse_csp(csp: &str) -> BTreeMap<String, Vec<String>> {
    csp.split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut tokens = part.split_whitespace();
            let name = tokens.next().expect("non-empty directive").to_string();
            (name, tokens.map(str::to_string).collect::<Vec<_>>())
        })
        .collect()
}

#[test]
fn csp_matches_documented_policy() {
    let actual = parse_csp(&csp_from_config());
    let expected = expected_directives();

    for (directive, sources) in &expected {
        let actual_sources = actual.get(*directive).unwrap_or_else(|| {
            panic!(
                "CSP directive `{directive}` is missing from tauri.conf.json. \
                 See the module docs in src-tauri/tests/csp_policy.rs for why it is there."
            )
        });
        assert_eq!(
            actual_sources, sources,
            "CSP directive `{directive}` changed. If the change is intentional, update \
             src-tauri/tests/csp_policy.rs AND the rationale in its module docs."
        );
    }

    let unexpected: Vec<_> = actual
        .keys()
        .filter(|name| !expected.contains_key(name.as_str()))
        .collect();
    assert!(
        unexpected.is_empty(),
        "Undocumented CSP directive(s) {unexpected:?} in tauri.conf.json — add them to \
         src-tauri/tests/csp_policy.rs with a rationale."
    );
}

#[test]
fn csp_does_not_allow_arbitrary_remote_connections() {
    let actual = parse_csp(&csp_from_config());
    let connect = actual
        .get("connect-src")
        .expect("connect-src must be set explicitly, not inherited from default-src");

    // The webview makes no remote requests; all outbound HTTP is Rust/reqwest.
    // A bare `https:` here would restore an unrestricted exfiltration channel.
    for source in connect {
        assert!(
            source == "'self'",
            "connect-src gained `{source}`. The webview does not make remote requests \
             (no fetch/XHR/WebSocket/EventSource to a remote host in src/, and no \
             @tauri-apps/plugin-http). Adding a remote source re-opens an exfiltration path."
        );
    }
}

#[test]
fn csp_blocks_plugin_and_frame_content() {
    let actual = parse_csp(&csp_from_config());
    for directive in ["object-src", "frame-src"] {
        assert_eq!(
            actual.get(directive).map(Vec::as_slice),
            Some(["'none'".to_string()].as_slice()),
            "`{directive}` must stay 'none' — the app contains no <object>/<embed>/<iframe>."
        );
    }
}

#[test]
fn csp_is_applied_at_all() {
    // A `null`/absent csp disables the policy entirely, which is how this
    // finding started life (see CODE_REVIEW.md).
    let csp = csp_from_config();
    assert!(
        !csp.trim().is_empty(),
        "app.security.csp must not be empty — an empty policy is the same as no policy."
    );
    assert!(
        !csp.contains("'unsafe-eval'"),
        "script-src must never allow 'unsafe-eval'; Shiki only needs 'wasm-unsafe-eval'."
    );
}
