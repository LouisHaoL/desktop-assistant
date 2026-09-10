use crate::task_store::{Db, Task};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// 是否已弹出过空闲提醒(用户活动恢复后复位)
pub struct IdlePrompted(pub Mutex<bool>);

#[cfg(windows)]
fn get_idle_ms() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    unsafe {
        let mut info = LASTINPUTINFO::default();
        info.cbSize = std::mem::size_of::<LASTINPUTINFO>() as u32;
        if GetLastInputInfo(&mut info).as_bool() {
            return GetTickCount().wrapping_sub(info.dwTime) as u64;
        }
        0
    }
}

#[cfg(not(windows))]
fn get_idle_ms() -> u64 {
    // TODO: macOS CGEventSourceSecondsSinceLastEventType / Linux X11 idle
    0
}

fn load_tasks_where(app: &AppHandle, status: &str) -> Result<Vec<Task>, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, content, kind, cron, start_time, estimated_minutes,
             priority, pinned, status, created_at, once_due
             FROM tasks WHERE status = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&status], |r| {
            Ok(Task {
                id: r.get(0)?,
                name: r.get(1)?,
                content: r.get(2)?,
                kind: r.get(3)?,
                cron: r.get(4)?,
                start_time: r.get(5)?,
                estimated_minutes: r.get(6)?,
                priority: r.get(7)?,
                pinned: r.get::<_, i64>(8)? != 0,
                status: r.get(9)?,
                created_at: r.get(10)?,
                once_due: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn idle_threshold_minutes(app: &AppHandle) -> u64 {
    let db = app.state::<Db>();
    let conn = db.0.lock().ok();
    let v = conn.and_then(|c| {
        c.query_row(
            "SELECT value FROM settings WHERE key='idle_threshold_minutes'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
    });
    v.and_then(|s| s.parse::<u64>().ok()).unwrap_or(15).max(1)
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        let _ = tick(&app);
        std::thread::sleep(std::time::Duration::from_secs(10));
    });
}

fn tick(app: &AppHandle) -> Result<(), String> {
    let idle_ms = get_idle_ms();
    let threshold_ms = idle_threshold_minutes(app) * 60_000;
    let prompted = app.state::<IdlePrompted>();
    let mut prompted = prompted.0.lock().map_err(|e| e.to_string())?;

    if idle_ms < 30_000 {
        // 用户刚有活动:若提醒还挂着就收回去
        if *prompted {
            *prompted = false;
            if let Some(win) = app.get_webview_window("idle-prompt") {
                let _ = win.hide();
            }
        }
        return Ok(());
    }
    if *prompted || idle_ms < threshold_ms {
        return Ok(());
    }

    let doing = load_tasks_where(app, "doing")?;
    let todo: Vec<Task> = load_tasks_where(app, "todo")?
        .into_iter()
        .filter(|t| t.kind != "recurring")
        .collect();
    if doing.is_empty() && todo.is_empty() {
        return Ok(()); // 没东西可提醒
    }

    if let Some(win) = app.get_webview_window("idle-prompt") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit(
            "idle-prompt",
            serde_json::json!({
                "idle_minutes": idle_ms / 60_000,
                "doing": doing.first(),
                "todo": todo,
            }),
        );
        *prompted = true;
    }
    Ok(())
}
