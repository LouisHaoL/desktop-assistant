use base64::Engine as _;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 桌宠自定义素材(图片)存放在 app_data_dir/pet_assets 下。
/// 前端用 <input type=file> 选中文件后以 base64 传进来,展示时再读回拼 data URL,
/// 不引入 dialog/fs 插件,权限面最小。
const MAX_BYTES: usize = 5 * 1024 * 1024;
const ALLOWED_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("pet_assets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建素材目录失败: {e}"))?;
    Ok(dir)
}

/// 文件名白名单:仅字母数字 _ - . 且扩展名必须是图片格式,防路径穿越
fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_lowercase();
    let valid = !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && !name.contains("..");
    if !valid {
        return Err("素材文件名不合法".into());
    }
    let ext = name.rsplit('.').next().unwrap_or("");
    if !ALLOWED_EXT.contains(&ext) {
        return Err(format!("仅支持格式:{}", ALLOWED_EXT.join(" / ")));
    }
    Ok(name)
}

/// 保存一张桌宠素材(同名校验后覆盖),返回规范化的文件名
#[tauri::command]
pub fn pet_asset_save(app: tauri::AppHandle, name: String, data_base64: String) -> Result<String, String> {
    let name = safe_name(&name)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("图片数据解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("图片超过 5MB,请压缩后再试".into());
    }
    let path = assets_dir(&app)?.join(&name);
    std::fs::write(&path, bytes).map_err(|e| format!("写入素材失败: {e}"))?;
    Ok(name)
}

#[tauri::command]
pub fn pet_asset_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = assets_dir(&app)?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("读取素材目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| safe_name(n).is_ok())
        .collect();
    names.sort();
    Ok(names)
}

/// 读回素材内容(base64),前端按扩展名补 data URL 头
#[tauri::command]
pub fn pet_asset_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let name = safe_name(&name)?;
    let path = assets_dir(&app)?.join(&name);
    let bytes = std::fs::read(&path).map_err(|e| format!("读取素材失败: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn pet_asset_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let name = safe_name(&name)?;
    let path = assets_dir(&app)?.join(&name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除素材失败: {e}"))?;
    }
    Ok(())
}
