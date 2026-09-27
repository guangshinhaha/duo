use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

// #42: the menu-bar half of the pending count. The client owns the number
// (`useWaitingCount` — the one number the dock, the window title and this
// all read), and this renders it beside the tray icon: a count shows it,
// zero shows nothing — "nothing waiting" is a state the menu bar should
// drop, not display.
#[cfg(desktop)]
#[tauri::command]
fn set_pending_count(app: tauri::AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("duo") {
        let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None });
    }
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_pending_count(_count: u32) {}

/// The mini tray's window label; the client renders the popover when it is loaded in this window (`isTrayWindow`).
#[cfg(desktop)]
const TRAY_LABEL: &str = "tray";
#[cfg(desktop)]
const TRAY_WIDTH: f64 = 360.0;
#[cfg(desktop)]
const TRAY_HEIGHT: f64 = 480.0;

/// When the mini tray last hid itself. A click on the tray icon while the popover is open first takes its focus (which hides it) and then arrives as a click — without this the popover would hide and immediately show again.
#[cfg(desktop)]
#[derive(Default)]
struct TrayState {
    hidden_at: Mutex<Option<Instant>>,
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn hide_tray_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_LABEL) {
        let _ = window.hide();
    }
}

/// Opens the app at an address: the mini tray's Open. The window comes forward here; where it goes is the client's half, told by the event.
#[cfg(desktop)]
#[tauri::command]
fn open_in_app(app: tauri::AppHandle, hash: String) {
    hide_tray_window(&app);
    show_main(&app);
    let _ = app.emit_to("main", "open-hash", hash);
}

#[cfg(not(desktop))]
#[tauri::command]
fn open_in_app(_hash: String) {}

#[cfg(desktop)]
#[tauri::command]
fn hide_tray(app: tauri::AppHandle) {
    hide_tray_window(&app);
}

#[cfg(not(desktop))]
#[tauri::command]
fn hide_tray() {}

/// Shows the mini tray under the tray icon, or hides it if it is showing. The popover is built the first time it is wanted and then kept, so it opens instantly after that.
#[cfg(desktop)]
fn toggle_tray_window(app: &tauri::AppHandle, icon_rect: Option<tauri::Rect>) {
    use tauri::{PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(hidden_at) = state.hidden_at.lock() {
            if hidden_at.map_or(false, |at| at.elapsed() < Duration::from_millis(300)) {
                return;
            }
        }
    }

    let window = match app.get_webview_window(TRAY_LABEL) {
        Some(window) => window,
        None => match WebviewWindowBuilder::new(app, TRAY_LABEL, WebviewUrl::App("index.html#tray".into()))
            .title("Duo")
            .inner_size(TRAY_WIDTH, TRAY_HEIGHT)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
        {
            Ok(window) => window,
            Err(_) => return,
        },
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    if let Some(rect) = icon_rect {
        let scale = window.scale_factor().unwrap_or(1.0);
        let position = rect.position.to_physical::<f64>(scale);
        let size = rect.size.to_physical::<f64>(scale);
        let width = TRAY_WIDTH * scale;
        let x = (position.x + size.width / 2.0 - width / 2.0).max(0.0);
        let y = position.y + size.height + 4.0 * scale;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// The native menu (#151). Every accelerator here is a key the page also handles on its own, so in a plain browser the same keys work; in the shell the menu takes the key first and hands the app the action to run.
#[cfg(desktop)]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Duo")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // Without an Edit menu the webview loses copy, paste and undo on the Mac.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let waiting = MenuItemBuilder::with_id("waiting", "Waiting on you")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let search = MenuItemBuilder::with_id("search", "Search…")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let inspector = MenuItemBuilder::with_id("inspector", "Show or hide the inspector")
        .accelerator("CmdOrCtrl+I")
        .build(app)?;
    let mut chats = SubmenuBuilder::new(app, "Chats")
        .item(&waiting)
        .item(&search)
        .item(&inspector)
        .separator();
    for n in 1..=9 {
        let item = MenuItemBuilder::with_id(format!("chat-{n}"), format!("Go to chat {n}"))
            .accelerator(format!("CmdOrCtrl+{n}"))
            .build(app)?;
        chats = chats.item(&item);
    }
    let chats_menu = chats.build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &chats_menu, &window_menu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

                app.manage(TrayState::default());

                app.set_menu(build_menu(app.handle())?)?;
                app.on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    let ours = matches!(id, "settings" | "waiting" | "search" | "inspector")
                        || id.starts_with("chat-");
                    if ours {
                        show_main(app);
                        let _ = app.emit_to("main", "menu-action", id);
                    }
                });

                // The tray is the standing question — "is anything waiting?" —
                // answered from the menu bar without opening the app. Left-click
                // opens the mini tray: what waits, and the one thing that may be
                // done from there (send a confident draft). Right-click gets the
                // menu: the app, the queue, and Quit.
                let open = MenuItem::with_id(app, "open", "Open Duo", true, None::<&str>)?;
                let review = MenuItem::with_id(app, "review", "Waiting on you", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Duo", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &review, &quit])?;

                // The tray itself is declared in tauri.conf.json (`trayIcon`): a
                // monochrome template image the menu bar tints for light, dark
                // and the selected state. This wires what it does.
                let tray = app.tray_by_id("duo").expect("tauri.conf.json declares the tray icon");
                tray.set_menu(Some(menu))?;
                tray.on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "review" => {
                        show_main(app);
                        // The client owns the navigation half: tray.ts
                        // listens for exactly this event, the same way
                        // it listens for notification actions.
                        let _ = app.emit("tray-open-review", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
                tray.on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_tray_window(tray.app_handle(), Some(rect));
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // A Mac app's close button hides, not quits: the tray count, the
                // dock badge, and the draft notifications are the point of the
                // shell, and they only work while the process lives. Quit lives
                // in the tray menu (and ⌘Q), stated rather than implied.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // The mini tray is a popover: it goes when you look away from it.
                #[cfg(desktop)]
                tauri::WindowEvent::Focused(false) if window.label() == TRAY_LABEL => {
                    let _ = window.hide();
                    if let Some(state) = window.app_handle().try_state::<TrayState>() {
                        if let Ok(mut hidden_at) = state.hidden_at.lock() {
                            *hidden_at = Some(Instant::now());
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![set_pending_count, open_in_app, hide_tray])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
