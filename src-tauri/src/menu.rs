//! Native application menu bar.
//!
//! Most of Leviathan's feature set (clean, bisect, worktrees, submodules, LFS,
//! hooks, git configuration, repository health, .gitignore/.gitattributes) was
//! reachable only by typing into the command palette. A desktop app is expected
//! to show those commands — and the keys that trigger them — in a menu bar.
//!
//! This module owns the *structure* of that menu only. It deliberately performs
//! no git work: choosing an item emits [`MENU_ACTION_EVENT`] with the item id
//! and the frontend runs the very same handler its command-palette twin runs
//! (see `src/services/app-menu.service.ts`), so the two can never drift.
//!
//! Labels are static; the enabled state and the accelerator shown on each item
//! are pushed from the frontend through the `sync_app_menu` command, because
//! both depend on state only the frontend has: whether a repository is open and
//! what the user has rebound their shortcuts to.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::error::{LeviathanError, Result};

/// Event emitted to the frontend with the id of the chosen menu item.
pub const MENU_ACTION_EVENT: &str = "app-menu-action";

/// Ids owned by the tray menu built in `lib.rs`.
///
/// Tauri routes EVERY menu event — tray and application menu alike — to every
/// global menu listener, so the tray's handler sees our items and ours sees the
/// tray's. Both filter by id, which only works while the two id spaces stay
/// disjoint; `app_menu_ids_do_not_collide_with_tray` keeps them that way.
pub const TRAY_MENU_IDS: &[&str] = &["show_hide", "quit"];

/// A single clickable application-menu item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MenuItemDef {
    /// Stable id, forwarded verbatim to the frontend.
    pub id: &'static str,
    pub label: &'static str,
    /// Acts on the active repository, so it starts disabled and is enabled by
    /// the frontend only while a repository is open.
    pub repository_scoped: bool,
}

/// One entry inside a menu section.
#[derive(Debug, Clone, Copy)]
pub enum MenuEntry {
    Item(MenuItemDef),
    Separator,
}

/// A top-level menu (File, Repository, …).
#[derive(Debug, Clone, Copy)]
pub struct MenuSection {
    pub id: &'static str,
    pub label: &'static str,
    pub entries: &'static [MenuEntry],
}

const fn item(id: &'static str, label: &'static str) -> MenuEntry {
    MenuEntry::Item(MenuItemDef {
        id,
        label,
        repository_scoped: false,
    })
}

/// An item that needs an open repository; disabled until the frontend says one
/// is open, so it can never fire into nothing.
const fn repo_item(id: &'static str, label: &'static str) -> MenuEntry {
    MenuEntry::Item(MenuItemDef {
        id,
        label,
        repository_scoped: true,
    })
}

/// The application menu, in display order.
///
/// Every id here must have a matching entry in `APP_MENU_ACTIONS` in
/// `src/services/app-menu.service.ts` — `scripts/menu-contract.test.mjs` fails
/// the build when the two lists disagree.
pub const APP_MENU: &[MenuSection] = &[
    MenuSection {
        id: "file",
        label: "File",
        entries: &[
            item("open-repository", "Open Repository…"),
            item("clone-repository", "Clone Repository…"),
            item("init-repository", "New Repository…"),
            MenuEntry::Separator,
            repo_item("close-repository-tab", "Close Repository Tab"),
        ],
    },
    MenuSection {
        id: "repository",
        label: "Repository",
        entries: &[
            repo_item("fetch", "Fetch"),
            repo_item("pull", "Pull"),
            repo_item("push", "Push"),
            MenuEntry::Separator,
            repo_item("clean", "Clean Working Directory…"),
            repo_item("bisect", "Bisect…"),
            MenuEntry::Separator,
            repo_item("worktrees", "Worktrees…"),
            repo_item("submodules", "Submodules…"),
            repo_item("lfs", "Git LFS…"),
            repo_item("hooks", "Hooks…"),
            MenuEntry::Separator,
            repo_item("config", "Git Configuration…"),
            repo_item("gitignore", ".gitignore & .gitattributes…"),
            repo_item("repository-health", "Repository Health & Maintenance…"),
        ],
    },
    MenuSection {
        id: "branch",
        label: "Branch",
        entries: &[
            repo_item("create-branch", "New Branch…"),
            repo_item("switch-branch", "Switch Branch…"),
            MenuEntry::Separator,
            repo_item("compare-branches", "Compare Branches…"),
            repo_item("branch-cleanup", "Clean Up Branches…"),
        ],
    },
    MenuSection {
        id: "view",
        label: "View",
        entries: &[
            item("toggle-left-panel", "Toggle Left Panel"),
            item("toggle-right-panel", "Toggle Right Panel"),
            repo_item("toggle-output-panel", "Toggle Output Panel"),
            MenuEntry::Separator,
            item("command-palette", "Command Palette…"),
        ],
    },
    MenuSection {
        id: "help",
        label: "Help",
        entries: &[
            item("keyboard-shortcuts", "Keyboard Shortcuts"),
            item("about", "About Leviathan"),
        ],
    },
];

/// Every clickable item in the application menu, in display order.
pub fn menu_item_defs() -> Vec<MenuItemDef> {
    APP_MENU
        .iter()
        .flat_map(|section| section.entries.iter())
        .filter_map(|entry| match entry {
            MenuEntry::Item(def) => Some(*def),
            MenuEntry::Separator => None,
        })
        .collect()
}

/// Whether `id` belongs to the application menu (as opposed to the tray menu,
/// whose events reach the same global listener).
pub fn is_app_menu_id(id: &str) -> bool {
    menu_item_defs().iter().any(|def| def.id == id)
}

/// A frontend-pushed update for one menu item.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemUpdate {
    pub id: String,
    pub enabled: bool,
    /// Tauri accelerator string (e.g. `CmdOrCtrl+Shift+F`), or `None` when the
    /// action has no keyboard binding.
    pub accelerator: Option<String>,
}

/// Handles to the built menu items, so their enabled state and accelerators can
/// be updated after the menu has been attached.
#[derive(Default)]
pub struct AppMenuState {
    items: Mutex<HashMap<String, MenuItem<Wry>>>,
}

impl AppMenuState {
    fn new(items: HashMap<String, MenuItem<Wry>>) -> Self {
        Self {
            items: Mutex::new(items),
        }
    }

    /// Apply frontend-pushed enabled/accelerator updates.
    ///
    /// Unknown ids and unparseable accelerators are logged and skipped rather
    /// than aborting the sync: a single bad entry must not leave the rest of the
    /// menu stale (which would show items as clickable with no repository open).
    pub fn apply(&self, updates: &[MenuItemUpdate]) -> Result<()> {
        let items = self
            .items
            .lock()
            .map_err(|_| LeviathanError::OperationFailed("app menu state is poisoned".into()))?;

        let mut failures: Vec<String> = Vec::new();

        for update in updates {
            let Some(menu_item) = items.get(&update.id) else {
                failures.push(format!("unknown menu item '{}'", update.id));
                continue;
            };

            if let Err(e) = menu_item.set_enabled(update.enabled) {
                failures.push(format!("{}: {}", update.id, e));
            }

            let result = match update.accelerator.as_deref() {
                Some(accelerator) => menu_item.set_accelerator(Some(accelerator)),
                None => menu_item.set_accelerator(None::<&str>),
            };
            if let Err(e) = result {
                failures.push(format!("{} accelerator: {}", update.id, e));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(LeviathanError::OperationFailed(format!(
                "failed to update {} menu item(s): {}",
                failures.len(),
                failures.join("; ")
            )))
        }
    }
}

/// Build the application menu, attach it, and forward chosen items to the
/// frontend.
///
/// Repository-scoped items start disabled — with no repository open they must
/// not fire — and the frontend enables them as soon as one is opened.
pub fn init_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let mut items: HashMap<String, MenuItem<Wry>> = HashMap::new();
    let mut menu = MenuBuilder::new(app);

    // macOS keeps the application menu (Services/Hide/Quit) and the Edit menu's
    // clipboard items in the menu bar itself. Attaching a custom menu REPLACES
    // Tauri's default one, so without these two submenus macOS users lose
    // ⌘X/⌘C/⌘V/⌘A and ⌘Q entirely.
    #[cfg(target_os = "macos")]
    {
        let about_metadata = tauri::menu::AboutMetadata {
            name: Some("Leviathan".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            ..Default::default()
        };
        let app_menu = SubmenuBuilder::new(app, "Leviathan")
            .about(Some(about_metadata))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }

    for section in APP_MENU {
        let mut submenu = SubmenuBuilder::new(app, section.label);

        for entry in section.entries {
            match entry {
                MenuEntry::Separator => submenu = submenu.separator(),
                MenuEntry::Item(def) => {
                    let menu_item = MenuItem::with_id(
                        app,
                        def.id,
                        def.label,
                        !def.repository_scoped,
                        None::<&str>,
                    )?;
                    submenu = submenu.item(&menu_item);
                    items.insert(def.id.to_string(), menu_item);
                }
            }
        }

        // Quit belongs to the application menu on macOS and to File everywhere
        // else.
        #[cfg(not(target_os = "macos"))]
        if section.id == "file" {
            submenu = submenu.separator().quit();
        }

        menu = menu.item(&submenu.build()?);

        #[cfg(target_os = "macos")]
        if section.id == "file" {
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            menu = menu.item(&edit_menu);
        }
    }

    app.set_menu(menu.build()?)?;
    app.manage(AppMenuState::new(items));

    app.on_menu_event(move |app, event| {
        let id = event.id().as_ref();
        // The tray menu's events arrive here too (Tauri fans every menu event
        // out to every global listener), so ignore anything that is not ours.
        if !is_app_menu_id(id) {
            return;
        }
        if let Err(e) = app.emit(MENU_ACTION_EVENT, id) {
            tracing::error!("Failed to forward menu action '{}': {}", id, e);
        }
    });

    tracing::info!("Application menu installed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_menu_id_is_unique() {
        let mut seen = HashSet::new();
        for def in menu_item_defs() {
            assert!(seen.insert(def.id), "duplicate menu item id: {}", def.id);
        }
    }

    #[test]
    fn app_menu_ids_do_not_collide_with_tray() {
        // A collision would make "Fetch" hide the window or quit the app,
        // because both menus share one global event listener.
        for def in menu_item_defs() {
            assert!(
                !TRAY_MENU_IDS.contains(&def.id),
                "menu item '{}' collides with a tray menu id",
                def.id
            );
        }
    }

    #[test]
    fn every_menu_id_is_kebab_case() {
        // The frontend table keys off these ids verbatim; keeping them to one
        // shape stops "repositoryHealth" vs "repository-health" drift.
        for def in menu_item_defs() {
            assert!(
                def.id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "menu item id '{}' is not kebab-case",
                def.id
            );
            assert!(!def.id.is_empty());
            assert!(!def.label.is_empty(), "menu item '{}' has no label", def.id);
        }
    }

    #[test]
    fn every_section_has_a_label_and_items() {
        for section in APP_MENU {
            assert!(!section.label.is_empty());
            assert!(!section.id.is_empty());
            assert!(
                section
                    .entries
                    .iter()
                    .any(|e| matches!(e, MenuEntry::Item(_))),
                "section '{}' has no clickable items",
                section.id
            );
        }
    }

    #[test]
    fn sections_are_the_conventional_desktop_set() {
        let ids: Vec<&str> = APP_MENU.iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["file", "repository", "branch", "view", "help"]);
    }

    #[test]
    fn repository_actions_are_repository_scoped() {
        let scoped: HashSet<&str> = menu_item_defs()
            .iter()
            .filter(|d| d.repository_scoped)
            .map(|d| d.id)
            .collect();

        for id in [
            "fetch",
            "pull",
            "push",
            "clean",
            "bisect",
            "worktrees",
            "submodules",
            "lfs",
            "hooks",
            "config",
            "gitignore",
            "repository-health",
            "create-branch",
            "switch-branch",
            "compare-branches",
            "branch-cleanup",
            "close-repository-tab",
            // The output panel only exists inside the active-repository layout.
            "toggle-output-panel",
        ] {
            assert!(scoped.contains(id), "'{}' must be repository-scoped", id);
        }

        // These work with no repository open and must stay clickable.
        for id in [
            "open-repository",
            "clone-repository",
            "init-repository",
            "toggle-left-panel",
            "toggle-right-panel",
            "command-palette",
            "keyboard-shortcuts",
            "about",
        ] {
            assert!(
                !scoped.contains(id),
                "'{}' must not be repository-scoped",
                id
            );
        }
    }

    #[test]
    fn is_app_menu_id_only_matches_our_items() {
        assert!(is_app_menu_id("fetch"));
        assert!(is_app_menu_id("about"));
        assert!(!is_app_menu_id("show_hide"));
        assert!(!is_app_menu_id("quit"));
        assert!(!is_app_menu_id(""));
        assert!(!is_app_menu_id("not-a-menu-item"));
    }

    #[test]
    fn menu_item_update_deserializes_from_the_frontend_payload() {
        let update: MenuItemUpdate = serde_json::from_str(
            r#"{"id":"fetch","enabled":true,"accelerator":"CmdOrCtrl+Shift+F"}"#,
        )
        .expect("payload should deserialize");
        assert_eq!(update.id, "fetch");
        assert!(update.enabled);
        assert_eq!(update.accelerator.as_deref(), Some("CmdOrCtrl+Shift+F"));

        let without: MenuItemUpdate =
            serde_json::from_str(r#"{"id":"about","enabled":false,"accelerator":null}"#)
                .expect("payload without an accelerator should deserialize");
        assert!(!without.enabled);
        assert_eq!(without.accelerator, None);
    }

    #[test]
    fn apply_reports_unknown_ids() {
        // No menu is built in a unit test, so every id is unknown — which is
        // exactly the "menu item disappeared" case the caller must hear about.
        let state = AppMenuState::default();
        let err = state
            .apply(&[MenuItemUpdate {
                id: "fetch".into(),
                enabled: true,
                accelerator: None,
            }])
            .expect_err("unknown ids must be reported");
        assert!(err.to_string().contains("fetch"));
    }

    #[test]
    fn apply_accepts_an_empty_update_list() {
        let state = AppMenuState::default();
        assert!(state.apply(&[]).is_ok());
    }

    #[test]
    fn menu_action_event_name_is_stable() {
        // The frontend listens for this exact string.
        assert_eq!(MENU_ACTION_EVENT, "app-menu-action");
    }
}
