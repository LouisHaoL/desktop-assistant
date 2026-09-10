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

/// 横条当前是否"位置锁定"(旧名穿透;托盘/前端都可调)。
/// 注意:鼠标是否穿透不再由这个开关直接控制,而是下面的命中区域机制。
pub struct ClickThrough(pub Mutex<bool>);

/// 横条的鼠标命中区域(逻辑坐标,相对窗口左上角)。kind:
/// "strip"=色带整体(可拖动) / "seg"=单个任务色块 / "grip"=缩放手柄 / "pop"=弹层
#[derive(Clone, serde::Deserialize)]
pub struct HitRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub kind: String,
}

/// 前端渲染后上报;只有区域内吃点击,其余部分穿透,空白处不挡桌面。
pub struct HitRegions(pub Mutex<Vec<HitRegion>>);

/// 前端上报横条命中区域
#[tauri::command]
fn set_bar_hit_regions(
    regions: Vec<HitRegion>,
    state: tauri::State<HitRegions>,
) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = regions;
    Ok(())
}

/// 横条鼠标穿透开关(托盘和前端都可调)。
/// 开 = 锁定位置(不能拖动/缩放);任务色块和弹层仍然可以点(命中区域照常工作)。
#[tauri::command]
fn set_click_through(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    apply_click_through(&app, enable)
}

fn apply_click_through(app: &tauri::AppHandle, enable: bool) -> Result<(), String> {
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
    // 横条据此显隐缩放手柄、禁用拖动
    if let Some(bar) = app.get_webview_window("timeline-bar") {
        use tauri::Emitter;
        let _ = bar.emit("bar-settings-changed", serde_json::json!({ "click_through": enable }));
    }
    Ok(())
}

/// 命中区域监视:每 60ms 查一次光标位置,在区域内窗口可交互,
/// 区域外(含整窗透明部分)整体穿透。弹层打开时其矩形也在区域内,不会被裁也不会挤压时间轴。
#[cfg(windows)]
fn spawn_hit_monitor(app: tauri::AppHandle) {
    use tauri::Emitter;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    std::thread::spawn(move || {
        let mut interactive = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(60));
            let Some(win) = app.get_webview_window("timeline-bar") else {
                continue;
            };
            if !win.is_visible().unwrap_or(false) {
                if interactive {
                    let _ = win.set_ignore_cursor_events(true);
                    interactive = false;
                }
                continue;
            }
            let (Ok(pos), Ok(sc), Ok(size)) =
                (win.outer_position(), win.scale_factor(), win.outer_size())
            else {
                continue;
            };
            let mut pt = POINT { x: 0, y: 0 };
            unsafe {
                let _ = GetCursorPos(&mut pt);
            }
            let lx = f64::from(pt.x - pos.x) / sc;
            let ly = f64::from(pt.y - pos.y) / sc;
            let lw = f64::from(size.width) / sc;
            let lh = f64::from(size.height) / sc;
            let regions = app
                .try_state::<HitRegions>()
                .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
                .unwrap_or_default();
            let inside = lx >= 0.0
                && ly >= 0.0
                && lx <= lw
                && ly <= lh
                && regions
                    .iter()
                    .any(|r| lx >= r.x && ly >= r.y && lx <= r.x + r.w && ly <= r.y + r.h);
            if inside != interactive {
                let _ = win.set_ignore_cursor_events(!inside);
                interactive = inside;
            }
            // 弹层开着时,光标移出所有区域(点到桌面/别处)→ 通知横条收起弹层。
            // 窗口在区域外是穿透的,页面收不到 mousedown,只能由这里补一刀。
            if !inside && regions.iter().any(|r| r.kind == "pop") {
                let _ = win.emit("bar-pops-dismiss", ());
            }
        }
    });
}

#[cfg(not(windows))]
fn spawn_hit_monitor(_app: tauri::AppHandle) {}

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
        let x = read_f(app, "bar_x");
        let y = read_f(app, "bar_y");
        // 高度固定:色带 + 下方透明弹层空间(弹层不再临时改窗口尺寸,时间轴不会变形)
        if let Some(w) = w {
            let _ = bar.set_size(tauri::LogicalSize::new(w.max(320.0), 300.0));
        } else if let Ok(Some(monitor)) = bar.primary_monitor() {
            let _ = bar.set_size(tauri::PhysicalSize::new(monitor.size().width, 300u32));
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
            scheduler::tasks_for_day,
            llm::llm_chat,
            set_click_through,
            set_bar_hit_regions
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    let db = task_store::init_db(app.handle()).expect("数据库初始化失败");
    app.manage(db);
    app.manage(FiredKeys(Default::default()));
    app.manage(IdlePrompted(Default::default()));
    // 穿透(锁定位置)状态从 settings 恢复;鼠标命中由 hit monitor 按区域实时切换
    let ct_on = read_setting(app.handle(), "click_through").as_deref() == Some("1");
    app.manage(ClickThrough(Mutex::new(ct_on)));
    app.manage(HitRegions(Default::default()));
    spawn_hit_monitor(app.handle().clone());
    // 托盘勾选与恢复出的穿透状态对齐
    sync_tray_checks(app.handle());

    app.run(|_app, _event| {});
}
