use crate::task_store::{Db, Task, TASK_COLS, row_to_task};
use chrono::{DateTime, Duration, Local, Timelike};
use cron::Schedule;
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// 到点提醒去重:(task_id, 触发分钟桶)
pub struct FiredKeys(pub Mutex<HashSet<(i64, i64)>>);

/// 时间轴上的一段安排:分钟数从 0 点起算。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Occurrence {
    pub task_id: i64,
    pub name: String,
    /// 当天第几分钟开始
    pub start_minute: i64,
    /// 持续分钟数
    pub duration_minutes: i64,
    pub kind: String,
    /// 任务当前状态(todo / doing)
    pub status: String,
    /// doing 任务对应的打开中的执行记录 id,横条上完成/暂停要用
    #[serde(rename = "doingLogId")]
    pub doing_log_id: Option<i64>,
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
            let due = once_due_local(task)?;
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

/// once 任务的 due(本地时间);解析失败返回 None。
fn once_due_local(task: &Task) -> Option<DateTime<Local>> {
    let due = task.once_due.as_deref()?;
    chrono::DateTime::parse_from_rfc3339(due)
        .ok()
        .map(|d| d.with_timezone(&Local))
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
        // once 任务的错过补偿:due 已过但还没提醒过(应用当时没开 / 扫描跳过),
        // 补发一次。(id, -1) 这把钥匙只有正常到点或补发会写入,保证只提醒一次。
        if task.kind == "once" && task.status == "todo" {
            if let Some(due) = once_due_local(&task) {
                if due < now && due.date_naive() == now.date_naive() && fired_guard.insert((task.id, -1)) {
                    notify_and_emit(app, &task, due);
                    continue;
                }
            }
        }
        if let Some(at) = due_now(&task, now) {
            let bucket = minute_bucket(at);
            // (id, -1) 一并占位,避免错过补偿在同一分钟重复提醒
            fired_guard.insert((task.id, -1));
            if fired_guard.insert((task.id, bucket)) {
                notify_and_emit(app, &task, at);
            }
        }
    }
    Ok(())
}

/// 时间轴全景:所有未完成任务都排上去。
/// - 周期任务:按 cron 的今日时刻,固定位置
/// - 一次性任务且指定了今日时间:固定位置
/// - 正在执行的任务:按实际开始时间,固定位置
/// - 其余任务:从当前时间开始往后顺序排(开始执行后会变成固定位置)
#[tauri::command]
pub fn timeline_today(app: AppHandle) -> Result<Vec<Occurrence>, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks WHERE status != 'done'
             ORDER BY pinned DESC, priority DESC, id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([], row_to_task)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    // 打开中的执行记录(doing 任务的固定起点)
    let mut stmt = conn
        .prepare("SELECT id, task_id, started_at FROM task_logs WHERE ended_at IS NULL")
        .map_err(|e| e.to_string())?;
    let open_logs = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    drop(conn);

    let now = Local::now();
    let today = now.date_naive();
    let now_minute = (now.hour() * 60 + now.minute()) as i64;
    let day_start = today
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(Local).single())
        .ok_or("本地时区解析失败")?;

    let mut out = Vec::new();
    let mut queued: Vec<&Task> = Vec::new();

    for task in &tasks {
        let est = task.estimated_minutes.unwrap_or(30).max(5);
        match task.kind.as_str() {
            "recurring" => {
                let Some(expr) = task.cron.as_deref() else {
                    queued.push(task);
                    continue;
                };
                let Ok(sched) = parse_cron(expr) else {
                    queued.push(task);
                    continue;
                };
                let mut placed = false;
                for t in sched.after(&day_start).take(48) {
                    if t.date_naive() != today {
                        break;
                    }
                    placed = true;
                    out.push(Occurrence {
                        task_id: task.id,
                        name: task.name.clone(),
                        start_minute: (t.hour() * 60 + t.minute()) as i64,
                        duration_minutes: est,
                        kind: task.kind.clone(),
                        status: task.status.clone(),
                        doing_log_id: None,
                    });
                }
                if !placed {
                    queued.push(task); // 今天没有发生点,也从现在往后排
                }
            }
            "once" => {
                let due = once_due_local(task);
                if let Some(due) = due.filter(|d| d.date_naive() == today) {
                    out.push(Occurrence {
                        task_id: task.id,
                        name: task.name.clone(),
                        start_minute: (due.hour() * 60 + due.minute()) as i64,
                        duration_minutes: est,
                        kind: task.kind.clone(),
                        status: task.status.clone(),
                        doing_log_id: None,
                    });
                } else {
                    queued.push(task); // 没定时间或不是今天:从现在往后排
                }
            }
            _ => queued.push(task),
        }
    }

    // doing 任务:以实际开始时间为固定位置(跨天开始的压到 0 点)
    for (log_id, task_id, started_at) in &open_logs {
        let Ok(started) = chrono::DateTime::parse_from_rfc3339(started_at) else {
            continue;
        };
        let started = started.with_timezone(&Local);
        if started.date_naive() > today {
            continue;
        }
        if let Some(task) = tasks.iter().find(|t| t.id == *task_id) {
            let est = task.estimated_minutes.unwrap_or(30).max(5);
            let start_minute = ((started.timestamp() - day_start.timestamp()) / 60).clamp(0, 1439);
            out.push(Occurrence {
                task_id: task.id,
                name: task.name.clone(),
                start_minute,
                duration_minutes: est,
                kind: task.kind.clone(),
                status: "doing".into(),
                doing_log_id: Some(*log_id),
            });
        }
    }

    // 其余任务:从当前时间开始往后顺序排
    let mut cursor = now_minute;
    for task in queued {
        let est = task.estimated_minutes.unwrap_or(30).max(5);
        out.push(Occurrence {
            task_id: task.id,
            name: task.name.clone(),
            start_minute: cursor,
            duration_minutes: est,
            kind: task.kind.clone(),
            status: task.status.clone(),
            doing_log_id: None,
        });
        cursor += est;
    }

    out.sort_by_key(|o| o.start_minute);
    Ok(out)
}
