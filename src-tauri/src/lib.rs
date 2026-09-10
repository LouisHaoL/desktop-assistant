mod idle;
mod llm;
mod scheduler;
mod task_store;

use idle::IdlePrompted;
use scheduler::FiredKeys;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

/// 横条当前是否鼠标穿透(Windows API 无反向查询,自己记账)
pub struct ClickThrough(pub Mutex<bool>);

/// 横条鼠标穿透开关(托盘和前端都可调)
#[tauri::command]
fn set_click_through(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    apply_click_through(&app, enable)
}

fn apply_click_through(app: &tauri::AppHandle, enable: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("timeline-bar")
        .ok_or("找不到时间轴窗口")?;
    win.set_ignore_cursor_events(enable)
        .map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<ClickThrough>() {
        *state.0.lock().map_err(|e| e.to_string())? = enable;
    }
    Ok(())
}

fn toggle_bar_visible(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("timeline-bar") else {
        return;
    };
    let vis = win.is_visible().unwrap_or(false);
    let _ = if vis { win.hide() } else { win.show() };
    sync_tray_checks(app);
}

/// 点击托盘菜单后,让勾选状态与窗口/穿透实际状态一致
fn sync_tray_checks(app: &tauri::AppHandle) {
    let Some(menu) = app.menu() else { return };
    let bar_visible = app
        .get_webview_window("timeline-bar")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let pet_visible = app
        .get_webview_window("pet")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let click_through = app
        .try_state::<ClickThrough>()
        .and_then(|s| s.0.lock().ok().map(|g| *g))
        .unwrap_or(false);
    for (id, checked) in [
        ("show_bar", bar_visible),
        ("show_pet", pet_visible),
        ("click_through", click_through),
    ] {
        if let Some(tauri::menu::MenuItemKind::Check(c)) = menu.get(id) {
            let _ = c.set_checked(checked);
        }
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_bar = CheckMenuItem::with_id(app, "show_bar", "显示时间轴横条", true, true, None::<&str>)?;
    let show_pet = CheckMenuItem::with_id(app, "show_pet", "显示桌宠", true, false, None::<&str>)?;
    let click_through =
        CheckMenuItem::with_id(app, "click_through", "横条鼠标穿透", true, false, None::<&str>)?;
    let show_main = MenuItem::with_id(app, "show_main", "打开主面板", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_bar, &click_through, &show_pet, &show_main, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("缺少应用图标").clone())
        .tooltip("桌面小助理")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_bar" => toggle_bar_visible(app),
            "show_pet" => {
                if let Some(win) = app.get_webview_window("pet") {
                    let vis = win.is_visible().unwrap_or(false);
                    let _ = if vis { win.hide() } else { win.show() };
                }
                sync_tray_checks(app);
            }
            "click_through" => {
                let cur = app
                    .try_state::<ClickThrough>()
                    .and_then(|s| s.0.lock().ok().map(|g| *g))
                    .unwrap_or(false);
                let _ = apply_click_through(app, !cur);
                sync_tray_checks(app);
            }
            "show_main" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let db = task_store::init_db(app.handle()).expect("数据库初始化失败");
            app.manage(db);
            app.manage(FiredKeys(Default::default()));
            app.manage(IdlePrompted(Default::default()));
            app.manage(ClickThrough(Mutex::new(false)));

            // 时间轴横条:铺满主屏顶部
            if let Some(bar) = app.get_webview_window("timeline-bar") {
                if let Ok(Some(monitor)) = bar.primary_monitor() {
                    let w = monitor.size().width;
                    let _ = bar.set_position(tauri::PhysicalPosition::new(0i32, 0i32));
                    let _ = bar.set_size(tauri::PhysicalSize::new(w, 56u32));
                }
            }

            // 主面板点关闭 = 隐藏到托盘
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            setup_tray(app.handle())?;
            scheduler::spawn(app.handle().clone());
            idle::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            task_store::task_create,
            task_store::task_list,
            task_store::task_update,
            task_store::task_delete,
            task_store::task_start,
            task_store::task_finish,
            task_store::task_logs_for,
            task_store::logs_today,
            task_store::settings_get,
            task_store::settings_set,
            scheduler::timeline_today,
            llm::llm_chat,
            set_click_through
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
