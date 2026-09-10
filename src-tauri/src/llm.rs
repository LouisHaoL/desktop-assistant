use crate::task_store::Db;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

fn read_setting(app: &AppHandle, key: &str) -> Option<String> {
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

// 前端存的是 camelCase(baseUrl/apiKey/model),这里按 camelCase 反序列化
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmProfile {
    id: String,
    name: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
}

/// 读取当前启用的 LLM 配置。支持多配置(llm_profiles JSON + llm_active),
/// 兼容旧的单配置字段(llm_base_url / llm_api_key / llm_model)。
fn read_active_config(app: &AppHandle) -> Result<LlmProfile, String> {
    if let Some(json) = read_setting(app, "llm_profiles") {
        let profiles: Vec<LlmProfile> = serde_json::from_str(&json)
            .map_err(|e| format!("llm_profiles 配置损坏: {e}"))?;
        if !profiles.is_empty() {
            let active_id = read_setting(app, "llm_active");
            let picked = profiles
                .iter()
                .find(|p| Some(p.id.as_str()) == active_id.as_deref())
                .or_else(|| profiles.first());
            return Ok(picked.unwrap().clone());
        }
    }
    Ok(LlmProfile {
        id: "legacy".into(),
        name: "默认".into(),
        base_url: read_setting(app, "llm_base_url")
            .ok_or("还没配置 LLM 服务商,请到「设置」页填写")?,
        api_key: read_setting(app, "llm_api_key").unwrap_or_default(),
        model: read_setting(app, "llm_model").ok_or("还没选择模型,请到「设置」页填写")?,
    })
}

/// 统一的 OpenAI 兼容 chat 调用。
#[tauri::command]
pub async fn llm_chat(app: AppHandle, messages: Vec<LlmMessage>) -> Result<String, String> {
    let profile = read_active_config(&app)?;
    let base_url = if profile.base_url.is_empty() {
        return Err("启用的配置缺少 Base URL,请到「设置」页补全".into());
    } else {
        profile.base_url
    };
    let api_key = profile.api_key;
    let model = if profile.model.is_empty() {
        return Err("启用的配置缺少模型名,请到「设置」页补全".into());
    } else {
        profile.model
    };

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
