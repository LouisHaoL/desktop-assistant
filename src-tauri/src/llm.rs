use crate::task_store::Db;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

fn read_llm_config(app: &AppHandle, key: &str) -> Option<String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.trim().is_empty())
}

/// 统一的 OpenAI 兼容 chat 调用。base_url / api_key / llm_model 存在 settings 表。
#[tauri::command]
pub async fn llm_chat(app: AppHandle, messages: Vec<LlmMessage>) -> Result<String, String> {
    let base_url = read_llm_config(&app, "llm_base_url")
        .ok_or("还没配置 LLM 服务商,请到「设置」页填写")?;
    let api_key = read_llm_config(&app, "llm_api_key").unwrap_or_default();
    let model =
        read_llm_config(&app, "llm_model").ok_or("还没选择模型,请到「设置」页填写")?;

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.post(&url).json(&serde_json::json!({
        "model": model,
        "messages": messages,
    }));
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败({status}): {e}"))?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("LLM 返回 {status}: {msg}"));
    }
    body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("LLM 响应格式异常: {body}"))
}

// 说明:前端直接拼 prompt 后调 llm_chat,复盘/建任务等逻辑都放前端,Rust 只做透传。
