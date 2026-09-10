use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// 一条任务。kind = recurring 时 cron 必填;kind = once 时用 once_due。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub name: String,
    /// 详细内容/备注,任务名的补充说明
    pub content: Option<String>,
    /// "recurring" | "once"
    pub kind: String,
    /// cron 表达式,如 "0 9 * * 1-5"(分 时 日 月 周)
    pub cron: Option<String>,
    /// 建议开始时刻 HH:MM
    pub start_time: Option<String>,
    /// 预估时长(分钟)
    pub estimated_minutes: Option<i64>,
    pub priority: i64,
    pub pinned: bool,
    /// "todo" | "doing" | "done" | "skipped"
    pub status: String,
    pub created_at: String,
    /// 一次性任务的目标时间
    pub once_due: Option<String>,
}

/// 一条执行记录,预估校准与每日复盘的数据源。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLog {
    pub id: i64,
    pub task_id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub actual_minutes: Option<i64>,
    /// "user" | "idle_prompt" | "llm_suggest"
    pub source: String,
    pub note: Option<String>,
}

pub struct Db(pub Mutex<Connection>);

pub fn init_db(app: &AppHandle) -> Result<Db, String> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let conn = Connection::open(dir.join("assistant.db"))
        .map_err(|e| format!("打开数据库失败: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS tasks (
           id INTEGER PRIMARY KEY,
           name TEXT NOT NULL,
           content TEXT,
           kind TEXT NOT NULL CHECK (kind IN ('recurring','once')),
           cron TEXT,
           start_time TEXT,
           estimated_minutes INTEGER,
           priority INTEGER NOT NULL DEFAULT 0,
           pinned INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT 'todo'
             CHECK (status IN ('todo','doing','done','skipped')),
           created_at TEXT NOT NULL,
           once_due TEXT
         );
         CREATE TABLE IF NOT EXISTS task_logs (
           id INTEGER PRIMARY KEY,
           task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
           started_at TEXT NOT NULL,
           ended_at TEXT,
           actual_minutes INTEGER,
           source TEXT NOT NULL DEFAULT 'user',
           note TEXT
         );
         CREATE TABLE IF NOT EXISTS settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("初始化表结构失败: {e}"))?;
    // 旧库迁移:补 content 列
    let has_content: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name='content'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_content == 0 {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN content TEXT;")
            .map_err(|e| format!("迁移 content 列失败: {e}"))?;
    }
    Ok(Db(Mutex::new(conn)))
}

pub fn row_to_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
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
}

pub const TASK_COLS: &str = "id, name, content, kind, cron, start_time, estimated_minutes, priority, pinned, status, created_at, once_due";

#[tauri::command]
pub fn task_create(
    db: tauri::State<Db>,
    name: String,
    content: Option<String>,
    kind: String,
    cron: Option<String>,
    start_time: Option<String>,
    estimated_minutes: Option<i64>,
    priority: Option<i64>,
    once_due: Option<String>,
) -> Result<Task, String> {
    if name.trim().is_empty() {
        return Err("任务名不能为空".into());
    }
    if kind == "recurring" && cron.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("周期任务必须提供 cron 表达式".into());
    }
    let now = Local::now().to_rfc3339();
    let content = content
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO tasks (name, content, kind, cron, start_time, estimated_minutes, priority, pinned, status, created_at, once_due)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'todo', ?8, ?9)",
        params![
            name.trim(),
            content,
            kind,
            cron,
            start_time,
            estimated_minutes,
            priority.unwrap_or(0),
            now,
            once_due
        ],
    )
    .map_err(|e| format!("写入任务失败: {e}"))?;
    let id = conn.last_insert_rowid();
    Ok(Task {
        id,
        name: name.trim().to_string(),
        content,
        kind,
        cron,
        start_time,
        estimated_minutes,
        priority: priority.unwrap_or(0),
        pinned: false,
        status: "todo".into(),
        created_at: now,
        once_due,
    })
}

#[tauri::command]
pub fn task_list(db: tauri::State<Db>) -> Result<Vec<Task>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks
             ORDER BY pinned DESC, priority DESC, id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_task)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn task_update(db: tauri::State<Db>, task: Task) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE tasks SET name=?1, content=?2, kind=?3, cron=?4, start_time=?5,
             estimated_minutes=?6, priority=?7, pinned=?8, status=?9, once_due=?10
             WHERE id=?11",
            params![
                task.name,
                task.content,
                task.kind,
                task.cron,
                task.start_time,
                task.estimated_minutes,
                task.priority,
                task.pinned as i64,
                task.status,
                task.once_due,
                task.id
            ],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("任务 {} 不存在", task.id));
    }
    // 直接标记完成/跳过时,把还开着的执行记录收尾,
    // 否则时间轴会一直按 doing 画,和任务池状态对不上
    if task.status == "done" || task.status == "skipped" {
        conn.execute(
            "UPDATE task_logs SET ended_at=?1, actual_minutes=COALESCE(actual_minutes, 0)
             WHERE task_id=?2 AND ended_at IS NULL",
            params![Local::now().to_rfc3339(), task.id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn task_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM task_logs WHERE task_id=?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 开始一条任务:status 置 doing 并写一条 task_log,返回 log id(结束时回填)。
#[tauri::command]
pub fn task_start(db: tauri::State<Db>, id: i64, source: String) -> Result<i64, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET status='doing' WHERE id=?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    // 同一任务只允许一条打开中的执行记录:旧的没收尾就补一个结束时间,
    // 否则时间轴会按每条 log 各画一个色块(历史 bug 根源)
    tx.execute(
        "UPDATE task_logs SET ended_at=?1
         WHERE task_id=?2 AND ended_at IS NULL",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO task_logs (task_id, started_at, source) VALUES (?1, ?2, ?3)",
        params![id, now, source],
    )
    .map_err(|e| e.to_string())?;
    let log_id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(log_id)
}

/// 结束一条任务:回填 task_log,任务置 done。
#[tauri::command]
pub fn task_finish(db: tauri::State<Db>, log_id: i64) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let task_id: Option<i64> = tx
        .query_row(
            "SELECT task_id FROM task_logs WHERE id=?1",
            params![log_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(task_id) = task_id else {
        return Err(format!("执行记录 {log_id} 不存在"));
    };
    let started: String = tx
        .query_row(
            "SELECT started_at FROM task_logs WHERE id=?1",
            params![log_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let minutes = chrono::DateTime::parse_from_rfc3339(&started)
        .ok()
        .map(|s| ((now_epoch_seconds() - s.timestamp()) / 60).max(0));
    tx.execute(
        "UPDATE task_logs SET ended_at=?1, actual_minutes=?2 WHERE id=?3",
        params![now, minutes, log_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET status='done' WHERE id=?1",
        params![task_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 暂停一条任务:回填当前执行记录但不标记完成,任务回 todo。
#[tauri::command]
pub fn task_pause(db: tauri::State<Db>, log_id: i64) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let task_id: Option<i64> = tx
        .query_row(
            "SELECT task_id FROM task_logs WHERE id=?1",
            params![log_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(task_id) = task_id else {
        return Err(format!("执行记录 {log_id} 不存在"));
    };
    let started: String = tx
        .query_row(
            "SELECT started_at FROM task_logs WHERE id=?1",
            params![log_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let minutes = chrono::DateTime::parse_from_rfc3339(&started)
        .ok()
        .map(|s| ((now_epoch_seconds() - s.timestamp()) / 60).max(0));
    tx.execute(
        "UPDATE task_logs SET ended_at=?1, actual_minutes=?2 WHERE id=?3",
        params![now, minutes, log_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET status='todo' WHERE id=?1",
        params![task_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn now_epoch_seconds() -> i64 {
    Local::now().timestamp()
}

#[tauri::command]
pub fn task_logs_for(db: tauri::State<Db>, task_id: i64) -> Result<Vec<TaskLog>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, started_at, ended_at, actual_minutes, source, note
             FROM task_logs WHERE task_id=?1 ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![task_id], |r| {
            Ok(TaskLog {
                id: r.get(0)?,
                task_id: r.get(1)?,
                started_at: r.get(2)?,
                ended_at: r.get(3)?,
                actual_minutes: r.get(4)?,
                source: r.get(5)?,
                note: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn settings_get(db: tauri::State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM settings WHERE key=?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_set(db: tauri::State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 今日所有执行记录(带任务名与预估),供每日复盘与预估校准。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogWithTask {
    #[serde(flatten)]
    pub log: TaskLog,
    pub task_name: String,
    pub estimated_minutes: Option<i64>,
}

#[tauri::command]
pub fn logs_today(app: tauri::AppHandle) -> Result<Vec<LogWithTask>, String> {
    use tauri::Manager;
    let db = app.state::<Db>();
    let day_start = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
    let day_start = day_start.and_local_timezone(Local).single().unwrap();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.task_id, l.started_at, l.ended_at, l.actual_minutes,
                    l.source, l.note, t.name, t.estimated_minutes
             FROM task_logs l JOIN tasks t ON t.id = l.task_id
             WHERE l.started_at >= ?1 ORDER BY l.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([day_start.to_rfc3339()], |r| {
            Ok(LogWithTask {
                log: TaskLog {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    started_at: r.get(2)?,
                    ended_at: r.get(3)?,
                    actual_minutes: r.get(4)?,
                    source: r.get(5)?,
                    note: r.get(6)?,
                },
                task_name: r.get(7)?,
                estimated_minutes: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}
