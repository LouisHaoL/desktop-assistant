mod idle;
mod llm;
mod scheduler;
mod task_store;

use idle::IdlePrompted;
use scheduler::FiredKeys;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
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
    // 状态落库,重启后恢复一致
    if let Some(db) = app.try_state::<crate::task_store::Db>() {
        if let Ok(conn) = db.0.lock() {
            let _ = conn.execute(
                "INSERT INTO settings (key, value) VALUES ('click_through', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [if enable { "1" } else { "0" }],
            );
        }
    }
    // 横条菜单里切穿透后,托盘勾选要跟着动
    sync_tray_checks(app);
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

/// 从 settings 读窗口几何(bar_x/bar_y/bar_w/bar_h、pet_x/pet_y)
fn read_setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let db = app.try_state::<crate::task_store::Db>()?;
    let conn = db.0.lock().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

fn read_f(app: &tauri::AppHandle, key: &str) -> Option<f64> {
    read_setting(app, key)?.trim().parse().ok()
}

/// 启动时恢复横条/桌宠的上次位置和大小(没存过就用默认布局)
fn restore_window_geometry(app: &tauri::AppHandle) {
    if let Some(bar) = app.get_webview_window("timeline-bar") {
        let w = read_f(app, "bar_w");
        let h = read_f(app, "bar_h");
        let x = read_f(app, "bar_x");
        let y = read_f(app, "bar_y");
        if let (Some(w), Some(h)) = (w, h) {
            let _ = bar.set_size(tauri::LogicalSize::new(w.max(320.0), h.max(32.0)));
        } else if let Ok(Some(monitor)) = bar.primary_monitor() {
            let _ = bar.set_size(tauri::PhysicalSize::new(monitor.size().width, 56u32));
        }
        if let (Some(x), Some(y)) = (x, y) {
            let _ = bar.set_position(tauri::LogicalPosition::new(x, y));
        } else {
            let _ = bar.set_position(tauri::PhysicalPosition::new(0i32, 0i32));
        }
    }
    if let Some(pet) = app.get_webview_window("pet") {
        if let (Some(x), Some(y)) = (read_f(app, "pet_x"), read_f(app, "pet_y")) {
            let _ = pet.set_position(tauri::LogicalPosition::new(x, y));
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

    // 双击托盘图标 = 打开主界面(这个版本没有 click_count,自己按间隔判)
    let last_left_click = std::sync::Mutex::new(None::<std::time::Instant>);
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("缺少应用图标").clone())
        .tooltip("桌面小助理")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let mut last = last_left_click.lock().unwrap();
                let now = std::time::Instant::now();
                let double = matches!(*last, Some(t) if now.duration_since(t).as_millis() < 500);
                *last = Some(now);
                if double {
                    *last = None;
                    if let Some(win) = tray.app_handle().get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
        })
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
    // 先 build 再 manage 再 run:配置里的窗口在 run 阶段才创建,
    // 这样窗口页面一发 invoke,Db 等状态就已就位(否则命令里 state::<Db>() 会 panic)
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 时间轴横条/桌宠:恢复上次的位置和大小
            restore_window_geometry(app.handle());

            // 恢复穿透状态(和托盘勾选、横条行为保持一致)
            let ct_on = read_setting(app.handle(), "click_through").as_deref() == Some("1");
            if ct_on {
                let _ = apply_click_through(app.handle(), true);
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
            task_store::task_pause,
            task_store::task_finish,
            task_store::task_logs_for,
            task_store::logs_today,
            task_store::settings_get,
            task_store::settings_set,
            scheduler::timeline_today,
            llm::llm_chat,
            set_click_through
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    let db = task_store::init_db(app.handle()).expect("数据库初始化失败");
    app.manage(db);
    app.manage(FiredKeys(Default::default()));
    app.manage(IdlePrompted(Default::default()));
    app.manage(ClickThrough(Mutex::new(false)));

    app.run(|_app, _event| {});
}
