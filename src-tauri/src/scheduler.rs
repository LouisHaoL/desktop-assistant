use crate::task_store::{Db, Task};
use chrono::{DateTime, Duration, Local, Timelike};
use cron::Schedule;
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// 到点提醒去重:(task_id, 触发分钟桶)
pub struct FiredKeys(pub Mutex<HashSet<(i64, i64)>>);

/// 一天之内周期任务的具体时刻(供时间轴用):分钟数从 0 点起算。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Occurrence {
    pub task_id: i64,
    pub name: String,
    /// 当天第几分钟开始
    pub start_minute: i64,
    /// 持续分钟数
    pub duration_minutes: i64,
    pub kind: String,
}

/// 解析 5 段 cron(分 时 日 月 周),返回今天(以及后续)的时刻表。
fn parse_cron(expr: &str) -> Result<Schedule, String> {
    // cron crate 要求 6~7 段(秒在前),前面补 "0"
    let with_sec = format!("0 {}", expr.trim());
    Schedule::from_str(&with_sec).map_err(|e| format!("cron 表达式无效「{expr}」: {e}"))
}

fn minute_bucket(t: DateTime<Local>) -> i64 {
    t.timestamp() / 60
}

/// 任务是否应在 now 前后的扫描窗口内提醒。
/// 返回 Some(触发时刻) 表示这一分钟该提醒。
fn due_now(task: &Task, now: DateTime<Local>) -> Option<DateTime<Local>> {
    match task.kind.as_str() {
        "recurring" => {
            let expr = task.cron.as_deref()?;
            let sched = parse_cron(expr).ok()?;
            // 往前找 24 小时窗口内最近一次不超过当前时刻的发生点
            let window_start = now - Duration::hours(24);
            let prev = sched.after(&window_start).take_while(|t| *t <= now).last()?;
            (minute_bucket(prev) == minute_bucket(now)).then_some(prev)
        }
        "once" => {
            let due = task.once_due.as_deref()?;
            let due = chrono::DateTime::parse_from_rfc3339(due)
                .ok()?
                .with_timezone(&Local);
            (task.status == "todo" && minute_bucket(due) == minute_bucket(now)).then_some(due)
        }
        _ => None,
    }
}

fn notify_and_emit(app: &AppHandle, task: &Task, at: DateTime<Local>) {
    let time = at.format("%H:%M").to_string();
    let body = task
        .content
        .as_deref()
        .unwrap_or("到点了,去看看吧");
    let _ = app
        .notification()
        .builder()
        .title(format!("[{time}] {}", task.name))
        .body(body)
        .show();
    // 前端各窗口弹 toast
    let _ = app.emit("task-due", serde_json::json!({
        "id": task.id,
        "name": task.name,
        "content": task.content.clone(),
        "at": time,
    }));
}

/// 每 30 秒扫描一次任务表,对命中的任务发通知。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        let _ = scan_once(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}

fn scan_once(app: &AppHandle) -> Result<(), String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, content, kind, cron, start_time, estimated_minutes, priority, pinned, status, created_at, once_due FROM tasks")
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([], |r| {
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
    drop(stmt);

    let now = Local::now();
    let fired = app.state::<FiredKeys>();
    let mut fired_guard = fired.0.lock().map_err(|e| e.to_string())?;
    for task in tasks {
        if task.status == "done" || task.status == "skipped" {
            continue;
        }
        if let Some(at) = due_now(&task, now) {
            let key = (task.id, minute_bucket(at));
            if fired_guard.insert(key) {
                notify_and_emit(app, &task, at);
            }
        }
    }
    Ok(())
}

/// 今天的周期任务时刻段 + 未到期的一次性任务,给时间轴横条渲染。
#[tauri::command]
pub fn timeline_today(app: AppHandle) -> Result<Vec<Occurrence>, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, content, kind, cron, start_time, estimated_minutes, priority, pinned, status, created_at, once_due FROM tasks WHERE status != 'done'")
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([], |r| {
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
    drop(stmt);

    let today = Local::now().date_naive();
    let mut out = Vec::new();
    for task in tasks {
        let est = task.estimated_minutes.unwrap_or(30);
        match task.kind.as_str() {
            "recurring" => {
                let Some(expr) = task.cron.as_deref() else { continue };
                let Ok(sched) = parse_cron(expr) else { continue };
                let day_start = today
                    .and_hms_opt(0, 0, 0)
                    .and_then(|t| t.and_local_timezone(Local).single());
                let Some(day_start) = day_start else { continue };
                for t in sched.after(&day_start).take(48) {
                    if t.date_naive() != today {
                        break;
                    }
                    out.push(Occurrence {
                        task_id: task.id,
                        name: task.name.clone(),
                        start_minute: (t.hour() * 60 + t.minute()) as i64,
                        duration_minutes: est,
                        kind: task.kind.clone(),
                    });
                }
            }
            "once" => {
                let Some(due) = task.once_due.as_deref() else { continue };
                let Ok(due) = chrono::DateTime::parse_from_rfc3339(due) else { continue };
                let due = due.with_timezone(&Local);
                if due.date_naive() != today {
                    continue;
                }
                out.push(Occurrence {
                    task_id: task.id,
                    name: task.name.clone(),
                    start_minute: (due.hour() * 60 + due.minute()) as i64,
                    duration_minutes: est,
                    kind: task.kind.clone(),
                });
            }
            _ => {}
        }
    }
    out.sort_by_key(|o| o.start_minute);
    Ok(out)
}
