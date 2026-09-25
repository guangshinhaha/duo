use tauri::{Emitter, Manager};

// #42: the menu-bar half of the pending count. The client owns the number
// (ReviewLink's one query — the same place the dock badge reads), and this
// renders it beside the tray icon: a count shows it, zero shows nothing —
// "nothing waiting" is a state the menu bar should drop, not display.
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

            // The tray is the standing question — "is anything waiting?" —
            // answered from the menu bar without opening the app. Review is
            // the whole point of the app; Quit is the only other thing a
            // menu bar is for. Left-click shows the window (the menu-bar
            // surrogate of clicking the dock icon); right-click gets the
            // menu.
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let review = MenuItem::with_id(app, "review", "Review", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Duo", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&review, &quit])?;

                let icon = app
                    .default_window_icon()
                    .expect("the bundle always embeds an icon")
                    .clone();

                TrayIconBuilder::with_id("duo")
                    .icon(icon)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "review" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            // The client owns the navigation half: tray.ts
                            // listens for exactly this event, the same way
                            // it listens for notification actions.
                            let _ = app.emit("tray-open-review", ());
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // A Mac app's close button hides, not quits: the tray count, the
            // dock badge, and the draft notifications are the point of the
            // shell, and they only work while the process lives. Quit lives
            // in the tray menu (and ⌘Q), stated rather than implied.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![set_pending_count])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
