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

/// 已完结(done/skipped):只留在完成那一天,不再排进时间轴的"从现在往后"队列
fn is_finished(status: &str) -> bool {
    status == "done" || status == "skipped"
}

/// done_at(rfc3339)解析成本地日期;没记录过完成时间则 None
fn done_day(task: &Task) -> Option<chrono::NaiveDate> {
    task.done_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Local).date_naive())
}

/// 某一天的任务视图:周期任务(当天有发生点)+ 一次性任务(当天到期)
/// + 未定时间任务(每个视图都带上看)。
/// 已完成/已跳过的任务只留在完成那一天,不再天天挂在池里。
#[tauri::command]
pub fn tasks_for_day(app: AppHandle, date: String) -> Result<Vec<Task>, String> {
    let day =
        chrono::NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").map_err(|e| format!("日期无效「{date}」: {e}"))?;
    let day_start = day
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(Local).single())
        .ok_or("本地时区解析失败")?;

    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {TASK_COLS} FROM tasks ORDER BY pinned DESC, priority DESC, id ASC"))
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([], row_to_task)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // 旧数据没记 done_at 的已完成任务:用最近一条执行记录的结束/开始时刻兜底定位完成日
    let mut stmt = conn
        .prepare(
            "SELECT task_id, MAX(COALESCE(ended_at, started_at)) FROM task_logs
             WHERE task_id IN (SELECT id FROM tasks WHERE status IN ('done','skipped'))
             GROUP BY task_id",
        )
        .map_err(|e| e.to_string())?;
    let last_log_day: std::collections::HashMap<i64, chrono::NaiveDate> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|row| {
            row.ok().and_then(|(id, ts)| {
                chrono::DateTime::parse_from_rfc3339(&ts)
                    .ok()
                    .map(|t| (id, t.with_timezone(&Local).date_naive()))
            })
        })
        .collect();
    drop(stmt);

    Ok(tasks
        .into_iter()
        .filter(|task| {
            let visible_normally = match task.kind.as_str() {
                "recurring" => match task.cron.as_deref().and_then(|e| parse_cron(e).ok()) {
                    Some(sched) => sched
                        .after(&day_start)
                        .next()
                        .map(|t| t.date_naive() == day)
                        .unwrap_or(false),
                    None => true, // 没配 cron 的周期任务始终可见
                },
                _ => match once_due_local(task) {
                    Some(due) => due.date_naive() == day,
                    None => true, // 未定时间的一次性任务始终可见
                },
            };
            if task.status == "done" || task.status == "skipped" {
                // 只在完成那天显示;兜底顺序:done_at → 最近执行记录 → 原规则(纯旧数据)
                if let Some(d) = done_day(task) {
                    d == day
                } else if let Some(d) = last_log_day.get(&task.id) {
                    *d == day
                } else {
                    visible_normally
                }
            } else {
                visible_normally
            }
        })
        .collect())
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
        .prepare("SELECT id, name, content, kind, cron, start_time, estimated_minutes, priority, pinned, status, created_at, once_due, done_at FROM tasks")
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
                done_at: r.get(12)?,
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
/// done 任务按今日执行记录定位:开始取当天最早一次,时长取实际累计(没有就按预估)
fn done_occ(
    task: &Task,
    started_at: &str,
    actual_sum: i64,
    day_start: DateTime<Local>,
) -> Option<Occurrence> {
    let started = chrono::DateTime::parse_from_rfc3339(started_at)
        .ok()?
        .with_timezone(&Local);
    let est = task.estimated_minutes.unwrap_or(30).max(5);
    Some(Occurrence {
        task_id: task.id,
        name: task.name.clone(),
        start_minute: ((started.timestamp() - day_start.timestamp()) / 60).clamp(0, 1439),
        duration_minutes: if actual_sum > 0 { actual_sum.max(5) } else { est },
        kind: task.kind.clone(),
        status: "done".into(),
        doing_log_id: None,
    })
}

#[tauri::command]
pub fn timeline_today(app: AppHandle) -> Result<Vec<Occurrence>, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let now = Local::now();
    let today = now.date_naive();
    let now_minute = (now.hour() * 60 + now.minute()) as i64;
    let day_start = today
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(Local).single())
        .ok_or("本地时区解析失败")?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks
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

    // 已完成任务的今日执行记录:done 也留在时间轴上(灰色遮罩),按实际时间定位
    let day_end = (day_start + Duration::hours(24)).to_rfc3339();
    let mut stmt = conn
        .prepare(
            "SELECT task_id, MIN(started_at), SUM(COALESCE(actual_minutes, 0))
             FROM task_logs
             WHERE ended_at IS NOT NULL AND started_at >= ?1 AND started_at < ?2
             GROUP BY task_id",
        )
        .map_err(|e| e.to_string())?;
    let done_pos: std::collections::HashMap<i64, (String, i64)> = stmt
        .query_map([day_start.to_rfc3339(), day_end], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (r.get::<_, String>(1)?, r.get::<_, i64>(2)?),
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<std::collections::HashMap<i64, (String, i64)>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    drop(conn);

    // 每个任务只取最新一条打开 log(历史 bug 曾堆积多条,时间轴画出多个色块)
    let mut latest_by_task: std::collections::HashMap<i64, (i64, String)> =
        std::collections::HashMap::new();
    for (log_id, task_id, started_at) in open_logs {
        latest_by_task
            .entry(task_id)
            .and_modify(|e| {
                if log_id > e.0 {
                    *e = (log_id, started_at.clone());
                }
            })
            .or_insert((log_id, started_at));
    }

    // doing 任务先定位:以实际开始时间为固定位置(跨天开始的压到 0 点);
    // 已定位的任务跳过常规排布,避免同一任务出现两个色块
    let mut out = Vec::new();
    let mut doing_ids: HashSet<i64> = HashSet::new();
    for (task_id, (log_id, started_at)) in &latest_by_task {
        let Some(task) = tasks.iter().find(|t| t.id == *task_id) else {
            continue;
        };
        // 池里已不是进行中(直接标记完成/跳过但 log 没收尾)→ 不按 doing 画
        if task.status == "done" || task.status == "skipped" {
            continue;
        }
        let Ok(started) = chrono::DateTime::parse_from_rfc3339(started_at) else {
            continue;
        };
        if started.date_naive() > today {
            continue;
        }
        doing_ids.insert(*task_id);
        let est = task.estimated_minutes.unwrap_or(30).max(5);
        let start_minute = ((started.timestamp() - day_start.timestamp()) / 60).clamp(0, 1439);
        // 进行中的色块延续到当前时刻:结尾 = max(预估结束, 现在)
        let duration = (now_minute - start_minute).max(est).max(5);
        out.push(Occurrence {
            task_id: task.id,
            name: task.name.clone(),
            start_minute,
            duration_minutes: duration,
            kind: task.kind.clone(),
            status: "doing".into(),
            doing_log_id: Some(*log_id),
        });
    }

    let mut queued: Vec<&Task> = Vec::new();

    for task in &tasks {
        if doing_ids.contains(&task.id) {
            continue;
        }
        let est = task.estimated_minutes.unwrap_or(30).max(5);
        match task.kind.as_str() {
            "recurring" => {
                let Some(expr) = task.cron.as_deref() else {
                    if !is_finished(&task.status) {
                        queued.push(task);
                    }
                    continue;
                };
                let Ok(sched) = parse_cron(expr) else {
                    if !is_finished(&task.status) {
                        queued.push(task);
                    }
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
                if !placed && !is_finished(&task.status) {
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
                } else if let Some((started_at, sum)) = done_pos.get(&task.id) {
                    // 没定时间但今天做过:按实际执行时间留在时间轴上
                    if let Some(occ) = done_occ(task, started_at, *sum, day_start) {
                        out.push(occ);
                    } else {
                        queued.push(task);
                    }
                } else if !is_finished(&task.status) {
                    // 没定时间或不是今天:从现在往后排;已完结的只留在完成那天,不排上今天
                    queued.push(task);
                }
            }
            _ => {
                if let Some((started_at, sum)) = done_pos.get(&task.id) {
                    if let Some(occ) = done_occ(task, started_at, *sum, day_start) {
                        out.push(occ);
                    } else {
                        queued.push(task);
                    }
                } else if !is_finished(&task.status) {
                    queued.push(task);
                }
            }
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
