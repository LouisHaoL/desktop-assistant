import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { initBar } from "./bar";
import { initPet } from "./pet";
import { initPrompt } from "./prompt";
import { initTaskPanel } from "./task-panel";
import {
  PluginHost,
  loadPluginList,
  PLUGIN_TEMPLATES,
  savePluginList,
  type PluginEntry,
} from "./plugins";
import { PROVIDER_PRESETS } from "./providers";
import { toast } from "./toast";
import {
  initThemeLive,
  loadThemeSettings,
  saveThemeSettings,
  THEME_PRESETS,
  type ThemeSettings,
} from "./theme";

interface Task {
  id: number;
  name: string;
  content: string | null;
  kind: "recurring" | "once";
  cron: string | null;
  start_time: string | null;
  estimated_minutes: number | null;
  priority: number;
  pinned: boolean;
  status: "todo" | "doing" | "done" | "skipped";
  created_at: string;
  once_due: string | null;
  done_at?: string | null;
}

interface TaskLog {
  id: number;
  task_id: number;
  started_at: string;
  ended_at: string | null;
  actual_minutes: number | null;
}

interface LogWithTask extends TaskLog {
  task_name: string;
  estimated_minutes: number | null;
}

interface LlmProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

// toast() 从 ./toast 导入,主窗口与插件共用

// ============ 任务池 ============

const listEl = document.querySelector<HTMLUListElement>("#task-list")!;
const errEl = document.querySelector<HTMLElement>("#task-err")!;
const bannerEl = document.querySelector<HTMLElement>("#doing-banner")!;
const doingNameEl = document.querySelector<HTMLElement>("#doing-name")!;
const emptyEl = document.querySelector<HTMLElement>("#empty-hint")!;

let openLog: { taskId: number; logId: number } | null = null;

// 任务池按天查看:默认今天,◀ ▶ 翻日期
function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
let viewDate = toDateStr(new Date());

function updateDayLabel() {
  const el = document.querySelector<HTMLElement>("#day-label")!;
  const d = new Date(`${viewDate}T00:00:00`);
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  el.textContent =
    viewDate === toDateStr(new Date())
      ? `今天 ${viewDate} 周${week}`
      : `${viewDate} 周${week}`;
}

function switchTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  document.querySelectorAll<HTMLElement>(".page").forEach((p) => {
    p.hidden = p.id !== `page-${tab}`;
  });
  if (tab === "pool") refresh();
  if (tab === "settings") initSettingsOnce();
  if (tab === "review") refreshReviewStats();
  if (tab === "plugins") initPluginsOnce();
}

async function refresh() {
  let tasks: Task[];
  try {
    tasks = await invoke<Task[]>("task_list");
  } catch (err) {
    // 加载失败要有可见反馈,不能悄悄变成空列表
    errEl.textContent = `任务加载失败:${String(err)}`;
    toast("任务加载失败", String(err));
    return;
  }
  errEl.textContent = "";

  try {
    openLog = null;
    const doing = tasks.find((t) => t.status === "doing");
    if (doing) {
      const logs = await invoke<TaskLog[]>("task_logs_for", { taskId: doing.id });
      const open = logs.find((l) => !l.ended_at);
      if (open) openLog = { taskId: doing.id, logId: open.id };
    }
    bannerEl.hidden = !doing;
    doingNameEl.textContent = doing?.name ?? "";

    // 当天视图:周期任务(当天有发生点)+ 一次性任务(当天到期);未定时间的始终可见
    const dayTasks = await invoke<Task[]>("tasks_for_day", { date: viewDate }).catch((err) => {
      errEl.textContent = `当日任务查询失败:${String(err)}`;
      return [] as Task[];
    });
    const undated = dayTasks.filter(
      (t) => t.kind === "recurring" ? !t.cron : !t.once_due
    );
    const scheduled = dayTasks.filter((t) => !undated.includes(t));
    emptyEl.hidden = dayTasks.length > 0;

    listEl.innerHTML = "";
    if (undated.length > 0) {
      const head = document.createElement("li");
      head.className = "day-group-head";
      head.textContent = "未安排时间(常驻)";
      listEl.append(head);
      for (const t of undated) renderTaskRow(t);
      const head2 = document.createElement("li");
      head2.className = "day-group-head";
      head2.textContent = "当天安排";
      listEl.append(head2);
    }
    for (const t of scheduled) renderTaskRow(t);
  } catch (err) {
    errEl.textContent = `任务渲染失败:${String(err)}`;
    toast("任务渲染失败", String(err));
  }
}

function renderTaskRow(t: Task) {
  const li = document.createElement("li");
  li.className = `task task-${t.status}`;

  // 状态徽章放最前面
  const badge = document.createElement("span");
  badge.className = `badge badge-status${
    t.status === "doing" ? " badge-doing" : t.status === "done" ? " badge-done" : " badge-todo"
  }`;
  badge.textContent =
    t.status === "done"
      ? "✓ 已完成"
      : t.status === "doing"
        ? "● 进行中"
        : t.status === "skipped"
          ? "已跳过"
          : "待办";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = t.name;
  name.onclick = () => showDetail(t);

  const detail = document.createElement("span");
  detail.className = "detail";
  const when =
    t.kind === "recurring"
      ? `周期 · cron ${t.cron}`
      : t.once_due
        ? `一次性 · ${new Date(t.once_due).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}`
        : "一次性 · 未定时间";
  detail.textContent = `${when}${t.estimated_minutes ? ` · 约 ${t.estimated_minutes} 分钟` : ""}`;

  li.append(badge, name, detail);

  if (t.status === "todo") {
    const startBtn = document.createElement("button");
    startBtn.textContent = "开始";
    startBtn.onclick = async () => {
      await invoke("task_start", { id: t.id, source: "user" });
      await refresh();
    };
    li.append(startBtn);
  }
  if (t.status !== "done") {
    const delBtn = document.createElement("button");
    delBtn.textContent = "删除";
    delBtn.className = "danger";
    delBtn.onclick = async () => {
      await invoke("task_delete", { id: t.id });
      await refresh();
    };
    li.append(delBtn);
  }
  listEl.append(li);
}

// ============ 任务详情弹窗 ============

async function showDetail(t: Task) {
  const mask = document.querySelector<HTMLElement>("#detail-mask")!;
  const card = document.querySelector<HTMLElement>("#detail-card")!;
  const logs = await invoke<TaskLog[]>("task_logs_for", { taskId: t.id }).catch(() => []);

  const kindText =
    t.kind === "recurring"
      ? `周期 · cron ${t.cron}`
      : t.once_due
        ? `一次性 · ${new Date(t.once_due).toLocaleString("zh-CN")}`
        : "一次性 · 未定时间";
  const actuals = logs.filter((l) => l.actual_minutes != null);
  const avg =
    actuals.length > 0
      ? Math.round(actuals.reduce((s, l) => s + (l.actual_minutes ?? 0), 0) / actuals.length)
      : null;
  const calib =
    avg != null && t.estimated_minutes
      ? avg > t.estimated_minutes
        ? `历史上平均要 ${avg} 分钟,比预估多 ${avg - t.estimated_minutes} 分钟,建议调高预估`
        : avg < t.estimated_minutes
          ? `历史上平均只要 ${avg} 分钟,比预估少 ${t.estimated_minutes - avg} 分钟,可以调低预估`
          : "历史预估很准 👍"
      : "";

  card.innerHTML = `
    <div class="detail-head">
      <h3></h3>
      <button id="detail-close" class="btn-mini">✕</button>
    </div>
    <div class="detail-meta"></div>
    <div class="detail-content"></div>
    ${calib ? `<div class="detail-calib"></div>` : ""}
    <div class="detail-logs">
      <div class="detail-label">执行记录</div>
      <ul></ul>
    </div>`;

  card.querySelector("h3")!.textContent = t.name;
  (card.querySelector(".detail-meta") as HTMLElement).textContent = `${kindText}${
    t.estimated_minutes ? ` · 预估 ${t.estimated_minutes} 分钟` : ""
  } · 状态 ${t.status}`;
  (card.querySelector(".detail-content") as HTMLElement).textContent = t.content || "(没有详细内容)";
  if (calib) (card.querySelector(".detail-calib") as HTMLElement).textContent = `💡 ${calib}`;
  const ul = card.querySelector<HTMLUListElement>(".detail-logs ul")!;
  ul.innerHTML = logs.length
    ? ""
    : `<li class="prompt-empty">还没有执行过</li>`;
  for (const l of logs.slice(0, 20)) {
    const li = document.createElement("li");
    const start = new Date(l.started_at).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
    li.textContent = `${start} → ${l.ended_at ? new Date(l.ended_at).toLocaleTimeString("zh-CN", { timeStyle: "short" }) : "进行中"}${
      l.actual_minutes != null ? ` · 实际 ${l.actual_minutes} 分钟` : ""
    }`;
    ul.append(li);
  }
  card.querySelector("#detail-close")!.addEventListener("click", () => (mask.hidden = true));
  mask.hidden = false;
}

// ============ AI:自然语言建任务 ============

function extractJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function aiCreateTasks(text: string): Promise<number> {
  const now = new Date().toLocaleString("zh-CN");
  const reply = await invoke<string>("llm_chat", {
    messages: [
      {
        role: "system",
        content:
          '你是任务解析器。把用户的描述解析成任务数组,只输出 JSON 数组,不要其他文字。字段:{"name":简短任务名,"content":详细说明可为null,"kind":"recurring|once","cron":五段cron表达式(分 时 日 月 周,kind为once时为null),"once_due":ISO8601时间(kind为recurring时为null),"estimated_minutes":预估分钟数整数}。当前时间是 ' +
          now +
          "。无法从描述推断的字段填合理默认值或 null。",
      },
      { role: "user", content: text },
    ],
  });
  const arr = extractJsonArray(reply);
  if (!arr || arr.length === 0) throw new Error("AI 没有解析出任务,原始回复:\n" + reply.slice(0, 200));
  let created = 0;
  for (const raw of arr) {
    const t = raw as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name : null;
    if (!name) continue;
    await invoke("task_create", {
      name,
      content: typeof t.content === "string" ? t.content : null,
      kind: t.kind === "recurring" ? "recurring" : "once",
      cron: typeof t.cron === "string" ? t.cron : null,
      startTime: null,
      estimatedMinutes: typeof t.estimated_minutes === "number" ? Math.round(t.estimated_minutes) : null,
      priority: null,
      onceDue: typeof t.once_due === "string" ? t.once_due : null,
    });
    created += 1;
  }
  return created;
}

// ============ 设置页:LLM 多配置 ============

let settingsInited = false;

async function loadProfiles(): Promise<{ profiles: LlmProfile[]; active: string | null }> {
  const [raw, active] = await Promise.all([
    invoke<string | null>("settings_get", { key: "llm_profiles" }),
    invoke<string | null>("settings_get", { key: "llm_active" }),
  ]);
  if (raw) {
    try {
      return { profiles: JSON.parse(raw), active };
    } catch {
      /* 损坏则重建 */
    }
  }
  // 兼容旧的单配置字段,迁移成一条配置
  const legacyUrl = await invoke<string | null>("settings_get", { key: "llm_base_url" });
  if (legacyUrl) {
    const [legacyKey, legacyModel] = await Promise.all([
      invoke<string | null>("settings_get", { key: "llm_api_key" }),
      invoke<string | null>("settings_get", { key: "llm_model" }),
    ]);
    const p: LlmProfile = {
      id: "p1",
      name: "默认配置",
      baseUrl: legacyUrl,
      apiKey: legacyKey ?? "",
      model: legacyModel ?? "",
    };
    await saveProfiles([p], p.id);
    return { profiles: [p], active: p.id };
  }
  return { profiles: [], active: null };
}

async function saveProfiles(profiles: LlmProfile[], active: string | null) {
  await invoke("settings_set", { key: "llm_profiles", value: JSON.stringify(profiles) });
  if (active) await invoke("settings_set", { key: "llm_active", value: active });
}

let editingProfileId: string | null = null; // null = 新增

function renderProfiles(profiles: LlmProfile[], active: string | null) {
  const ul = document.querySelector<HTMLUListElement>("#llm-profiles")!;
  ul.innerHTML = "";
  if (profiles.length === 0) {
    ul.innerHTML = `<li class="prompt-empty">还没有配置,点右上「＋ 新增」添加一个</li>`;
    return;
  }
  for (const p of profiles) {
    const li = document.createElement("li");
    li.className = `profile-item${p.id === active ? " active" : ""}`;
    const info = document.createElement("label");
    info.className = "profile-info";
    info.innerHTML = `
      <input type="radio" name="active-profile" ${p.id === active ? "checked" : ""} />
      <span class="profile-text"><b></b><em></em></span>`;
    info.querySelector("b")!.textContent = p.name;
    info.querySelector("em")!.textContent = `${p.baseUrl} · ${p.model}`;
    info.querySelector("input")!.onchange = async () => {
      await saveProfiles(profiles, p.id);
      renderProfiles(profiles, p.id);
      toast("已切换启用配置", p.name);
    };

    const editBtn = document.createElement("button");
    editBtn.className = "btn-mini";
    editBtn.textContent = "编辑";
    editBtn.onclick = () => openProfileForm(p);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-mini danger";
    delBtn.textContent = "删除";
    delBtn.onclick = async () => {
      const next = profiles.filter((x) => x.id !== p.id);
      await saveProfiles(next, p.id === active ? (next[0]?.id ?? null) : active);
      renderProfiles(next, p.id === active ? (next[0]?.id ?? null) : active);
    };

    li.append(info, editBtn, delBtn);
    ul.append(li);
  }
}

function openProfileForm(p?: LlmProfile) {
  editingProfileId = p?.id ?? null;
  const form = document.querySelector<HTMLElement>("#profile-form")!;
  document.querySelector<HTMLInputElement>("#pf-name")!.value = p?.name ?? "";
  document.querySelector<HTMLInputElement>("#set-baseurl")!.value = p?.baseUrl ?? "";
  document.querySelector<HTMLInputElement>("#set-model")!.value = p?.model ?? "";
  document.querySelector<HTMLInputElement>("#set-key")!.value = p?.apiKey ?? "";
  const presetSel = document.querySelector<HTMLSelectElement>("#set-preset")!;
  const match = p ? PROVIDER_PRESETS.find((x) => x.baseUrl === p.baseUrl) : undefined;
  presetSel.value = match?.id ?? (p ? "custom" : "deepseek");
  syncPresetModels(presetSel.value, p?.model);
  form.hidden = false;
}

function syncPresetModels(presetId: string, current?: string) {
  const p = PROVIDER_PRESETS.find((x) => x.id === presetId);
  const models = document.querySelector<HTMLDataListElement>("#set-models")!;
  models.innerHTML = "";
  if (!p) return;
  if (p.baseUrl && document.querySelector<HTMLInputElement>("#set-baseurl")!.dataset.touched !== "1") {
    document.querySelector<HTMLInputElement>("#set-baseurl")!.value = p.baseUrl;
  }
  for (const m of p.models) {
    const o = document.createElement("option");
    o.value = m;
    models.append(o);
  }
  if (current) document.querySelector<HTMLInputElement>("#set-model")!.value = current;
  else if (p.models[0]) document.querySelector<HTMLInputElement>("#set-model")!.value = p.models[0];
}

async function initSettingsOnce() {
  if (settingsInited) return;
  settingsInited = true;

  // 预设下拉
  const presetSel = document.querySelector<HTMLSelectElement>("#set-preset")!;
  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSel.append(opt);
  }
  presetSel.onchange = () => syncPresetModels(presetSel.value);
  document.querySelector<HTMLInputElement>("#set-baseurl")!.addEventListener("input", (e) => {
    (e.target as HTMLInputElement).dataset.touched = "1";
  });

  document.querySelector("#btn-profile-add")!.addEventListener("click", () => openProfileForm());
  document.querySelector("#pf-cancel")!.addEventListener("click", () => {
    document.querySelector<HTMLElement>("#profile-form")!.hidden = true;
  });
  document.querySelector("#pf-save")!.addEventListener("click", async () => {
    const msg = document.querySelector<HTMLElement>("#set-msg")!;
    const name = document.querySelector<HTMLInputElement>("#pf-name")!.value.trim();
    const baseUrl = document.querySelector<HTMLInputElement>("#set-baseurl")!.value.trim();
    const model = document.querySelector<HTMLInputElement>("#set-model")!.value.trim();
    const apiKey = document.querySelector<HTMLInputElement>("#set-key")!.value.trim();
    if (!name || !baseUrl || !model) {
      msg.textContent = "名称 / Base URL / 模型 都不能为空";
      return;
    }
    const { profiles, active } = await loadProfiles();
    const profile: LlmProfile = {
      id: editingProfileId ?? `p${Date.now()}`,
      name,
      baseUrl,
      apiKey,
      model,
    };
    const next = editingProfileId
      ? profiles.map((p) => (p.id === editingProfileId ? profile : p))
      : [...profiles, profile];
    await saveProfiles(next, active ?? profile.id);
    document.querySelector<HTMLElement>("#profile-form")!.hidden = true;
    renderProfiles(next, active ?? profile.id);
    msg.textContent = "✓ 已保存";
  });

  document.querySelector("#set-test")!.addEventListener("click", async () => {
    const msg = document.querySelector<HTMLElement>("#set-msg")!;
    msg.textContent = "测试中…";
    try {
      const reply = await invoke<string>("llm_chat", {
        messages: [{ role: "user", content: "回复「连接成功」四个字" }],
      });
      msg.textContent = `✓ ${reply.slice(0, 60)}`;
    } catch (err) {
      msg.textContent = String(err);
    }
  });

  const { profiles, active } = await loadProfiles();
  renderProfiles(profiles, active);

  // ===== 以下设置统一「改动即保存」,并广播给时间轴横条实时生效 =====
  // (注意:WebviewWindow 实例没有 emit 方法,必须用全局 emit 才能通知到横条)
  const notifyBar = () => emit("bar-settings-changed", {});

  // 时间轴显示/隐藏(持久化,重启后保持)
  const barVisible = document.querySelector<HTMLInputElement>("#set-bar-visible")!;
  barVisible.checked =
    (await invoke<string | null>("settings_get", { key: "bar_visible" })) !== "0";
  barVisible.onchange = async () => {
    await invoke("settings_set", { key: "bar_visible", value: barVisible.checked ? "1" : "0" });
    const w = await WebviewWindow.getByLabel("timeline-bar");
    if (!w) return;
    if (barVisible.checked) await w.show();
    else await w.hide();
  };

  // 背景透明度
  const opacityRange = document.querySelector<HTMLInputElement>("#set-opacity")!;
  const opacityVal = document.querySelector<HTMLElement>("#opacity-val")!;
  const savedOpacity = await invoke<string | null>("settings_get", { key: "timeline_opacity" });
  opacityRange.value = savedOpacity ?? "75";
  opacityVal.textContent = (Number(opacityRange.value) / 100).toFixed(2);
  opacityRange.oninput = () => {
    opacityVal.textContent = (Number(opacityRange.value) / 100).toFixed(2);
  };
  opacityRange.onchange = async () => {
    await invoke("settings_set", { key: "timeline_opacity", value: opacityRange.value });
    await notifyBar();
  };

  // 时间显示格式 12/24 小时制
  const timeFmtSel = document.querySelector<HTMLSelectElement>("#set-time-format")!;
  timeFmtSel.value =
    (await invoke<string | null>("settings_get", { key: "bar_time_format" })) ?? "24";
  timeFmtSel.onchange = async () => {
    await invoke("settings_set", { key: "bar_time_format", value: timeFmtSel.value });
    await notifyBar();
  };

  // 视图范围 全天/半天(与横条右键菜单共用同一个 bar_view_mode 配置)
  const viewSel = document.querySelector<HTMLSelectElement>("#set-view-mode")!;
  viewSel.value =
    (await invoke<string | null>("settings_get", { key: "bar_view_mode" })) === "half"
      ? "half"
      : "full";
  viewSel.onchange = async () => {
    await invoke("settings_set", { key: "bar_view_mode", value: viewSel.value });
    await notifyBar();
  };

  // 静默启动:勾选后下次启动不打开主界面,从托盘进入
  const silent = document.querySelector<HTMLInputElement>("#set-silent-start")!;
  silent.checked = (await invoke<string | null>("settings_get", { key: "silent_start" })) === "1";
  silent.onchange = async () => {
    await invoke("settings_set", { key: "silent_start", value: silent.checked ? "1" : "0" });
    toast("已保存", silent.checked ? "下次启动不打开主界面,从托盘图标进入" : "下次启动正常打开主界面");
  };

  // 开机自启:勾选即写系统自启项(Windows 注册表 Run 键),失败时回弹勾选
  const autostart = document.querySelector<HTMLInputElement>("#set-autostart")!;
  autostart.checked = await invoke<boolean>("autostart_is_enabled").catch(() => false);
  autostart.onchange = async () => {
    try {
      await invoke("autostart_set", { enable: autostart.checked });
      toast("已保存", autostart.checked ? "开机后将自动启动本应用" : "已取消开机自动启动");
    } catch (e) {
      autostart.checked = !autostart.checked;
      toast("设置失败", String(e));
    }
  };

  // 空闲阈值:失焦即保存
  const thresholdEl = document.querySelector<HTMLInputElement>("#set-threshold")!;
  const threshold = await invoke<string | null>("settings_get", { key: "idle_threshold_minutes" });
  thresholdEl.value = threshold ?? "15";
  thresholdEl.onchange = async () => {
    await invoke("settings_set", {
      key: "idle_threshold_minutes",
      value: thresholdEl.value || "15",
    });
    toast("已保存", "空闲提醒阈值已更新");
  };

  // ===== 外观主题:模式 / 预设 / 自定义主色与进行中色,改动即存即生效 =====
  const themeModeSel = document.querySelector<HTMLSelectElement>("#set-theme-mode")!;
  const accentInput = document.querySelector<HTMLInputElement>("#set-theme-accent")!;
  const doingInput = document.querySelector<HTMLInputElement>("#set-theme-doing")!;
  let themeState = await loadThemeSettings();

  const refreshThemeInputs = () => {
    themeModeSel.value = themeState.mode;
    // 自定义被清空时展示内置默认色,方便用户从默认色起步微调
    accentInput.value = themeState.accent || "#4f6ef7";
    doingInput.value = themeState.doing || "#18a05e";
  };
  const applyThemeState = async () => {
    await saveThemeSettings(themeState);
    refreshThemeInputs();
  };
  themeModeSel.onchange = () => {
    themeState.mode = themeModeSel.value as ThemeSettings["mode"];
    void applyThemeState();
  };
  accentInput.oninput = () => {
    themeState.accent = accentInput.value;
    void applyThemeState();
  };
  doingInput.oninput = () => {
    themeState.doing = doingInput.value;
    void applyThemeState();
  };
  document.querySelector("#btn-theme-reset")!.addEventListener("click", () => {
    themeState.accent = "";
    themeState.doing = "";
    void applyThemeState();
  });

  const presetBox = document.querySelector<HTMLDivElement>("#theme-presets")!;
  for (const p of THEME_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-swatch";
    btn.title = p.name;
    btn.innerHTML = `<span class="sw" style="background:${p.accent}"></span><span class="sw" style="background:${p.doing}"></span><span class="sw-name"></span>`;
    btn.querySelector(".sw-name")!.textContent = p.name;
    btn.onclick = () => {
      themeState.accent = p.accent;
      themeState.doing = p.doing;
      void applyThemeState();
    };
    presetBox.append(btn);
  }
  refreshThemeInputs();

  // ===== 桌宠外观:表情 / 大小 / 自定义图片 / 动作动画(待机/工作/提醒三槽位),改动即存并实时推给桌宠窗口 =====
  const PET_FACES = ["🐱", "🐶", "🦊", "🐼", "🐸", "🐵", "🐰", "🐻", "🐥", "🦄", "🤖", "👾", "🌟", "🍊"];
  let petFace = (await invoke<string | null>("settings_get", { key: "pet_face" })) || "🐱";
  let petImage = (await invoke<string | null>("settings_get", { key: "pet_image" })) || "";
  let petSize = Number((await invoke<string | null>("settings_get", { key: "pet_size" })) || "64") || 64;
  // 动作槽位 = { frames: 素材名列表(按播放顺序), ms: 帧间隔, durations?: 每帧时长覆盖 }
  type SlotKey = "idle" | "work" | "alert";
  const SLOT_KEYS: SlotKey[] = ["idle", "work", "alert"];
  const SLOT_DEFS: { key: SlotKey; label: string; desc: string }[] = [
    { key: "idle", label: "待机动画", desc: "没有任务进行时循环播放" },
    { key: "work", label: "工作动画", desc: "有任务进行中时循环播放,未配置则回落待机" },
    { key: "alert", label: "提醒动画", desc: "任务到点提醒时播一遍,播完自动回落" },
  ];
  interface SlotConfig {
    frames: string[];
    ms: number;
    durations?: number[];
  }
  const emptySlot = (): SlotConfig => ({ frames: [], ms: 200 });
  let petActions: Record<SlotKey, SlotConfig> = { idle: emptySlot(), work: emptySlot(), alert: emptySlot() };
  {
    const str = await invoke<string | null>("settings_get", { key: "pet_actions" });
    if (str) {
      try {
        const parsed = JSON.parse(str);
        for (const key of SLOT_KEYS) {
          const a = parsed?.[key];
          if (a && Array.isArray(a.frames)) {
            petActions[key] = {
              frames: a.frames.filter((n: unknown) => typeof n === "string"),
              ms: Math.max(40, Number(a.ms) || 200),
              durations: Array.isArray(a.durations)
                ? a.durations.map((d: unknown) => Math.max(40, Number(d) || 200))
                : undefined,
            };
          }
        }
      } catch {
        /* 解析不了当未配置 */
      }
    } else {
      // 旧数据迁移:上一版的单一帧序列当作待机动画
      try {
        const legacy = JSON.parse((await invoke<string | null>("settings_get", { key: "pet_frames" })) || "[]");
        if (Array.isArray(legacy) && legacy.length > 0) {
          petActions.idle = {
            frames: legacy,
            ms: Math.max(
              40,
              Number((await invoke<string | null>("settings_get", { key: "pet_frame_ms" })) || "200") || 200
            ),
          };
        }
      } catch {
        /* 无旧数据 */
      }
    }
  }

  const sizeRange = document.querySelector<HTMLInputElement>("#set-pet-size")!;
  const sizeVal = document.querySelector<HTMLElement>("#pet-size-val")!;
  const previewEl = document.querySelector<HTMLDivElement>("#pet-preview")!;
  const assetMsg = document.querySelector<HTMLElement>("#pet-asset-msg")!;
  const actionsBox = document.querySelector<HTMLDivElement>("#pet-actions")!;

  const mimeOf = (name: string) => {
    const ext = name.split(".").pop() ?? "";
    return ext === "jpg" ? "jpeg" : ext || "png";
  };

  // 帧图 data URL 缓存:槽位渲染、预览、排序时反复要用
  const frameUrlCache = new Map<string, string>();
  async function loadFrameUrl(name: string): Promise<string | null> {
    const hit = frameUrlCache.get(name);
    if (hit) return hit;
    try {
      const url = `data:image/${mimeOf(name)};base64,${await invoke<string>("pet_asset_read", { name })}`;
      frameUrlCache.set(name, url);
      return url;
    } catch {
      return null;
    }
  }

  // 文件 → 存为桌宠素材,返回素材名
  async function saveFileAsAsset(base: string, file: File): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("读取文件失败"));
      r.readAsDataURL(file);
    });
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const ext = (file.name.split(".").pop() ?? "png").toLowerCase();
    return invoke<string>("pet_asset_save", { name: `${base}.${ext}`, dataBase64: b64 });
  }

  // 帧图放进容器循环播放(单帧静态显示),返回停止函数
  function animateFramesIn(box: HTMLElement, urls: string[], cfg: SlotConfig): () => void {
    box.innerHTML = "";
    const imgs = urls.map((src) => {
      const im = new Image();
      im.src = src;
      im.draggable = false;
      return im;
    });
    imgs.forEach((im, i) => {
      im.hidden = i !== 0;
      box.append(im);
    });
    if (imgs.length < 2) return () => {};
    const dur = (i: number) => Math.max(40, Number(cfg.durations?.[i]) || cfg.ms);
    let i = 0;
    let t = 0;
    const tick = () => {
      i = (i + 1) % imgs.length;
      imgs.forEach((im, k) => (im.hidden = k !== i));
      t = window.setTimeout(tick, dur(i));
    };
    t = window.setTimeout(tick, dur(0));
    return () => clearTimeout(t);
  }

  let previewSeq = 0;
  let previewStop: (() => void) | undefined;

  // 大预览:配了待机动画就播它,否则显示单图 / 表情
  async function renderPetPreview() {
    const seq = ++previewSeq;
    previewStop?.();
    previewStop = undefined;
    sizeVal.textContent = String(petSize);
    previewEl.style.width = `${petSize + 12}px`;
    previewEl.style.height = `${petSize + 12}px`;
    const idle = petActions.idle;
    if (idle.frames.length > 0) {
      const urls = (await Promise.all(idle.frames.map(loadFrameUrl))).filter((u): u is string => !!u);
      if (seq !== previewSeq || urls.length === 0) return;
      previewStop = animateFramesIn(previewEl, urls, idle);
      return;
    }
    if (petImage) {
      try {
        const b64 = await invoke<string>("pet_asset_read", { name: petImage });
        previewEl.innerHTML = `<img alt="桌宠预览" src="data:image/${mimeOf(petImage)};base64,${b64}" />`;
        return;
      } catch {
        /* 素材读不到就回退表情 */
      }
    }
    previewEl.textContent = petFace;
  }

  const framesLabel = (cfg: SlotConfig) => `${cfg.ms}ms(约 ${Math.round(1000 / cfg.ms)} 帧/秒)`;

  const swapFrames = (cfg: SlotConfig, i: number, j: number) => {
    if (j < 0 || j >= cfg.frames.length) return;
    [cfg.frames[i], cfg.frames[j]] = [cfg.frames[j], cfg.frames[i]];
    if (cfg.durations) {
      [cfg.durations[i], cfg.durations[j]] = [cfg.durations[j], cfg.durations[i]];
    }
  };

  // 动作槽位区:每个槽位一张卡(逐帧导入 / 横版雪碧图 / 帧列表 / 帧间隔 / 小预览),默认折叠
  let slotStops: Array<() => void> = [];
  const slotOpen: Record<SlotKey, boolean> = { idle: false, work: false, alert: false };

  async function renderActions() {
    slotStops.forEach((stop) => stop());
    slotStops = [];
    actionsBox.innerHTML = "";
    for (const def of SLOT_DEFS) {
      const cfg = petActions[def.key];
      const card = document.createElement("div");
      card.className = "pet-slot";

      const head = document.createElement("div");
      head.className = "pet-slot-head";
      const fold = document.createElement("span");
      fold.className = "slot-fold";
      const title = document.createElement("b");
      title.textContent = def.label;
      const desc = document.createElement("span");
      desc.className = "hint";
      desc.textContent = def.desc;
      const slotPreview = document.createElement("div");
      slotPreview.className = "slot-preview";
      head.append(fold, title, desc, slotPreview);
      head.title = "点击展开/收起";

      const bodyWrap = document.createElement("div");
      bodyWrap.className = "pet-slot-body";
      const syncFold = () => {
        const open = slotOpen[def.key];
        fold.textContent = open ? "▾" : "▸";
        bodyWrap.hidden = !open;
      };
      head.onclick = () => {
        slotOpen[def.key] = !slotOpen[def.key];
        syncFold();
      };

      const rowFrame = document.createElement("div");
      rowFrame.className = "pet-asset-row";
      const rowSheet = document.createElement("div");
      rowSheet.className = "pet-asset-row";
      const mkHint = (text: string) => {
        const s = document.createElement("span");
        s.className = "hint asset-lab";
        s.textContent = text;
        return s;
      };
      const fileFrames = document.createElement("input");
      fileFrames.type = "file";
      fileFrames.multiple = true;
      fileFrames.accept = ".png,.jpg,.jpeg,.gif,.webp";
      fileFrames.title = "多选图片,每张是一帧,按顺序追加";
      const fileSheet = document.createElement("input");
      fileSheet.type = "file";
      fileSheet.accept = ".png,.webp";
      fileSheet.title = "横向平铺帧的雪碧图,按图高(方帧)自动等分切帧";
      const btnClear = document.createElement("button");
      btnClear.type = "button";
      btnClear.className = "btn-mini";
      btnClear.textContent = "清空";
      rowFrame.append(mkHint("帧图"), fileFrames);
      rowSheet.append(mkHint("横版雪碧图"), fileSheet, btnClear);

      const grid = document.createElement("div");
      grid.className = "frame-grid";
      const urls = (await Promise.all(cfg.frames.map(loadFrameUrl))).filter((u): u is string => !!u);
      for (let i = 0; i < cfg.frames.length; i++) {
        const item = document.createElement("div");
        item.className = "frame-item";
        const im = new Image();
        im.draggable = false;
        const u = urls[i];
        if (u) im.src = u;
        const idx = document.createElement("span");
        idx.className = "frame-idx";
        idx.textContent = String(i + 1);
        const ops = document.createElement("div");
        ops.className = "frame-ops";
        const mkBtn = (label: string, tip: string, fn: () => void) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.title = tip;
          b.onclick = async () => {
            fn();
            await applyPetLook();
          };
          return b;
        };
        const durInput = document.createElement("input");
        durInput.type = "number";
        durInput.className = "frame-dur";
        durInput.min = "40";
        durInput.max = "3000";
        durInput.step = "20";
        durInput.value = String(cfg.durations?.[i] ?? cfg.ms);
        durInput.title = "此帧停留时长(ms);改回帧间隔即取消覆盖";
        durInput.onchange = async () => {
          const v = Math.max(40, Number(durInput.value) || cfg.ms);
          if (!cfg.durations) cfg.durations = cfg.frames.map(() => cfg.ms);
          cfg.durations[i] = v;
          if (cfg.durations.every((d) => d === cfg.ms)) cfg.durations = undefined;
          await applyPetLook();
        };
        ops.append(
          mkBtn("◀", "前移一位", () => swapFrames(cfg, i, i - 1)),
          mkBtn("▶", "后移一位", () => swapFrames(cfg, i, i + 1)),
          durInput,
          mkBtn("✕", "删除此帧", () => {
            cfg.frames.splice(i, 1);
            cfg.durations?.splice(i, 1);
          })
        );
        item.append(im, idx, ops);
        grid.append(item);
      }

      const msRow = document.createElement("div");
      msRow.className = "field-inline pet-frame-ms-row";
      const msLabel = document.createElement("label");
      msLabel.textContent = "帧间隔";
      const msRange = document.createElement("input");
      msRange.type = "range";
      msRange.min = "60";
      msRange.max = "1000";
      msRange.step = "20";
      msRange.value = String(cfg.ms);
      const msVal = document.createElement("span");
      msVal.className = "hint";
      msVal.textContent = framesLabel(cfg);
      msRange.oninput = () => {
        cfg.ms = Number(msRange.value) || 200;
        msVal.textContent = framesLabel(cfg);
      };
      msRange.onchange = () => void applyPetLook();
      msRow.append(msLabel, msRange, msVal);

      fileFrames.addEventListener("change", async () => {
        const files = Array.from(fileFrames.files ?? []);
        fileFrames.value = "";
        if (files.length === 0) return;
        if (files.some((f) => f.size > 5 * 1024 * 1024)) {
          assetMsg.textContent = "⚠ 有图片超过 5MB,请压缩后再试";
          return;
        }
        assetMsg.textContent = "导入中…";
        try {
          for (const [k, file] of files.entries()) {
            cfg.frames.push(await saveFileAsAsset(`pet-anim-${Date.now()}-${def.key}-${k}`, file));
          }
          await applyPetLook();
          assetMsg.textContent = `✓ 已导入 ${files.length} 帧到「${def.label}」,按顺序循环播放`;
        } catch (err) {
          assetMsg.textContent = String(err);
        }
      });

      fileSheet.addEventListener("change", async () => {
        const file = fileSheet.files?.[0];
        fileSheet.value = "";
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          assetMsg.textContent = "⚠ 图片超过 5MB,请压缩后再试";
          return;
        }
        assetMsg.textContent = "切分雪碧图…";
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error("读取文件失败"));
            r.readAsDataURL(file);
          });
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error("图片解码失败"));
            im.src = dataUrl;
          });
          // 横版雪碧图按方帧约定:帧宽 = 图高,横向等分
          const fw = img.naturalHeight;
          const count = fw > 0 ? Math.floor(img.naturalWidth / fw) : 0;
          if (count < 2) {
            throw new Error("切不出 2 帧:雪碧图需为方帧横向平铺(如 4 帧 128×128 → 512×128)");
          }
          const canvas = document.createElement("canvas");
          canvas.width = fw;
          canvas.height = fw;
          const ctx = canvas.getContext("2d")!;
          for (let k = 0; k < count; k++) {
            ctx.clearRect(0, 0, fw, fw);
            ctx.drawImage(img, k * fw, 0, fw, fw, 0, 0, fw, fw);
            const b64 = canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
            cfg.frames.push(
              await invoke<string>("pet_asset_save", {
                name: `pet-sheet-${Date.now()}-${def.key}-${k}.png`,
                dataBase64: b64,
              })
            );
          }
          const rem = img.naturalWidth - count * fw;
          await applyPetLook();
          assetMsg.textContent =
            `✓ 已切分 ${count} 帧到「${def.label}」` + (rem > 2 ? `(尾部 ${rem}px 不足一帧已舍弃)` : "");
        } catch (err) {
          assetMsg.textContent = String(err);
        }
      });

      btnClear.onclick = async () => {
        if (cfg.frames.length === 0) return;
        cfg.frames = [];
        cfg.durations = undefined;
        assetMsg.textContent = `已清空「${def.label}」`;
        await applyPetLook();
      };

      bodyWrap.append(rowFrame, rowSheet, grid, msRow);
      syncFold();
      card.append(head, bodyWrap);
      actionsBox.append(card);
      slotStops.push(animateFramesIn(slotPreview, urls, cfg));
    }
  }

  async function applyPetLook() {
    await invoke("settings_set", { key: "pet_face", value: petFace });
    await invoke("settings_set", { key: "pet_image", value: petImage });
    await invoke("settings_set", { key: "pet_size", value: String(petSize) });
    await invoke("settings_set", { key: "pet_actions", value: JSON.stringify(petActions) });
    await emit("pet-settings-changed", {}).catch(() => {});
    await Promise.all([renderPetPreview(), renderActions()]);
  }

  const faceGrid = document.querySelector<HTMLDivElement>("#pet-faces")!;
  for (const f of PET_FACES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "face-btn";
    b.textContent = f;
    b.onclick = () => {
      petFace = f;
      petImage = "";
      for (const key of SLOT_KEYS) petActions[key] = emptySlot();
      assetMsg.textContent = "";
      void applyPetLook();
    };
    faceGrid.append(b);
  }

  sizeRange.value = String(petSize);
  sizeRange.oninput = () => {
    petSize = Number(sizeRange.value);
    sizeVal.textContent = String(petSize);
  };
  sizeRange.onchange = () => void applyPetLook();

  document.querySelector<HTMLInputElement>("#set-pet-image")!.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      assetMsg.textContent = "⚠ 图片超过 5MB,请压缩后再试";
      return;
    }
    assetMsg.textContent = "导入中…";
    try {
      petImage = await saveFileAsAsset(`pet-${Date.now()}`, file);
      for (const key of SLOT_KEYS) petActions[key] = emptySlot(); // 与动画互斥,后设的生效
      await applyPetLook();
      assetMsg.textContent = "✓ 已应用自定义图片";
    } catch (err) {
      assetMsg.textContent = String(err);
    }
  });

  document.querySelector("#btn-pet-image-clear")!.addEventListener("click", () => {
    petImage = "";
    assetMsg.textContent = "";
    void applyPetLook();
  });

  void renderPetPreview();
  void renderActions();
}

// ============ 插件页 ============

let pluginsInited = false;
let pluginHost: PluginHost | null = null;
let editingPluginId: string | null = null; // null = 新建

function renderPluginList(list: PluginEntry[]) {
  const ul = document.querySelector<HTMLUListElement>("#plugin-list")!;
  ul.innerHTML = "";
  if (list.length === 0) {
    ul.innerHTML = `<li class="prompt-empty">还没有插件,从下方示例一键添加,或点右上「＋ 新建插件」写一个</li>`;
    return;
  }
  for (const p of list) {
    const li = document.createElement("li");
    li.className = "plugin-item";

    const info = document.createElement("label");
    info.className = "plugin-info";
    info.innerHTML = `<input type="checkbox" ${p.enabled ? "checked" : ""} />
      <span class="profile-text"><b></b><em></em></span>`;
    info.querySelector("b")!.textContent = `${p.name}  v${p.version}`;
    info.querySelector("em")!.textContent = p.description || "(无简介)";
    info.title = p.enabled ? "点击停用" : "点击启用";
    info.querySelector("input")!.onchange = async (e) => {
      p.enabled = (e.target as HTMLInputElement).checked;
      await savePluginList(list);
      await pluginHost?.remountAll();
    };

    const editBtn = document.createElement("button");
    editBtn.className = "btn-mini";
    editBtn.textContent = "编辑";
    editBtn.onclick = () => openPluginForm(p);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-mini danger";
    delBtn.textContent = "删除";
    delBtn.onclick = async () => {
      const next = list.filter((x) => x.id !== p.id);
      await savePluginList(next);
      renderPluginList(next);
      await pluginHost?.remountAll();
    };

    li.append(info, editBtn, delBtn);
    ul.append(li);
  }
}

function openPluginForm(p?: PluginEntry) {
  editingPluginId = p?.id ?? null;
  document.querySelector<HTMLInputElement>("#pl-name")!.value = p?.name ?? "";
  document.querySelector<HTMLInputElement>("#pl-version")!.value = p?.version ?? "0.1.0";
  document.querySelector<HTMLInputElement>("#pl-desc")!.value = p?.description ?? "";
  document.querySelector<HTMLTextAreaElement>("#pl-code")!.value =
    p?.code ??
    `zda.register({
  render(el, ctx) {
    el.innerHTML = "<b>你好,插件!</b>";
  }
});
`;
  document.querySelector<HTMLElement>("#pl-msg")!.textContent = "";
  document.querySelector<HTMLElement>("#plugin-form")!.hidden = false;
}

async function initPluginsOnce() {
  if (pluginsInited) return;
  pluginsInited = true;
  pluginHost = new PluginHost(document.querySelector<HTMLDivElement>("#plugin-panels")!);
  await pluginHost.remountAll();
  renderPluginList(await loadPluginList());

  document.querySelector("#btn-plugin-add")!.addEventListener("click", () => openPluginForm());
  document.querySelector("#plugin-cancel")!.addEventListener("click", () => {
    document.querySelector<HTMLElement>("#plugin-form")!.hidden = true;
  });
  document.querySelector("#plugin-save")!.addEventListener("click", async () => {
    const msg = document.querySelector<HTMLElement>("#pl-msg")!;
    const name = document.querySelector<HTMLInputElement>("#pl-name")!.value.trim();
    const version = document.querySelector<HTMLInputElement>("#pl-version")!.value.trim() || "0.1.0";
    const description = document.querySelector<HTMLInputElement>("#pl-desc")!.value.trim();
    const code = document.querySelector<HTMLTextAreaElement>("#pl-code")!.value;
    if (!name || !code.trim()) {
      msg.textContent = "插件名和代码都不能为空";
      return;
    }
    const list = await loadPluginList();
    const old = editingPluginId ? list.find((p) => p.id === editingPluginId) : undefined;
    const entry: PluginEntry = {
      id: editingPluginId ?? `p${Date.now()}`,
      name,
      version,
      description,
      enabled: old?.enabled ?? true,
      code,
    };
    const next = editingPluginId ? list.map((p) => (p.id === entry.id ? entry : p)) : [...list, entry];
    await savePluginList(next);
    document.querySelector<HTMLElement>("#plugin-form")!.hidden = true;
    renderPluginList(next);
    await pluginHost!.remountAll();
    msg.textContent = editingPluginId ? "✓ 已更新" : "✓ 插件已添加并启用";
  });

  // 示例插件一键添加
  const tplUl = document.querySelector<HTMLUListElement>("#plugin-templates")!;
  for (const t of PLUGIN_TEMPLATES) {
    const li = document.createElement("li");
    li.className = "plugin-item";
    const info = document.createElement("span");
    info.className = "plugin-info";
    info.innerHTML = `<span class="profile-text"><b></b><em></em></span>`;
    info.querySelector("b")!.textContent = t.name;
    info.querySelector("em")!.textContent = t.desc;
    const addBtn = document.createElement("button");
    addBtn.className = "btn-mini";
    addBtn.textContent = "添加";
    addBtn.onclick = async () => {
      const list = await loadPluginList();
      if (list.some((p) => p.id === t.id)) {
        document.querySelector<HTMLElement>("#pl-msg")!.textContent = `「${t.name}」已经添加过了`;
        return;
      }
      list.push({
        id: t.id,
        name: t.name,
        version: "0.1.0",
        description: t.desc,
        enabled: true,
        code: t.code,
      });
      await savePluginList(list);
      renderPluginList(list);
      await pluginHost!.remountAll();
      switchTab("plugins");
    };
    li.append(info, addBtn);
    tplUl.append(li);
  }
}

// ============ 复盘页 ============

async function refreshReviewStats() {
  const [logs, tasks] = await Promise.all([
    invoke<LogWithTask[]>("logs_today"),
    invoke<Task[]>("task_list"),
  ]);
  const box = document.querySelector<HTMLElement>("#review-stats")!;
  const totalMin = logs.reduce((s, l) => s + (l.actual_minutes ?? 0), 0);
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const rows = logs
    .map((l) => {
      const est = l.estimated_minutes;
      const act = l.actual_minutes;
      const diff = est && act ? act - est : null;
      const mark = diff === null ? "" : diff > 5 ? " ⬆超时" : diff < -5 ? " ⬇提前" : " ✓准点";
      return `${l.task_name}:${est ? `预估 ${est} 分` : "未预估"} / 实际 ${act ?? "?"} 分${mark}`;
    })
    .join("\n");
  box.textContent = `今日完成 ${doneCount} 个任务,累计投入 ${totalMin} 分钟,执行 ${logs.length} 次。\n${rows || "(今天还没有执行记录)"}`;
  box.hidden = false;
}

async function aiReview() {
  const out = document.querySelector<HTMLElement>("#review-out")!;
  out.textContent = "AI 复盘生成中…";
  try {
    const [logs, tasks] = await Promise.all([
      invoke<LogWithTask[]>("logs_today"),
      invoke<Task[]>("task_list"),
    ]);
    const reply = await invoke<string>("llm_chat", {
      messages: [
        {
          role: "system",
          content:
            "你是效率复盘助手。根据用户给出的今日任务与执行记录,输出简洁复盘:1)完成情况点评 2)预估偏差分析(哪类任务经常超时/提前,给出新的预估建议) 3)明天最多3条改进建议。用中文,总长不超过300字。",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              任务池: tasks.map((t) => ({ 名称: t.name, 类型: t.kind, 状态: t.status, 预估分: t.estimated_minutes })),
              今日执行: logs.map((l) => ({
                任务: l.task_name,
                开始: l.started_at,
                结束: l.ended_at,
                预估分: l.estimated_minutes,
                实际分: l.actual_minutes,
              })),
            },
            null,
            1
          ),
        },
      ],
    });
    out.textContent = reply;
  } catch (err) {
    out.textContent = String(err);
  }
}

// ============ 入口:按窗口标签分发视图 ============

const label = getCurrentWindow().label;

// 所有窗口禁用浏览器默认右键菜单(带"检查"那个);横条/桌宠有自己的右键逻辑
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.body.classList.add(label === "main" ? "view-main" : "view-alt");

// 主题:所有窗口(主面板/横条/桌宠/空闲弹窗)统一应用,设置改动实时生效
initThemeLive();

if (label === "timeline-bar") {
  initBar();
} else if (label === "pet") {
  initPet();
} else if (label === "idle-prompt") {
  initPrompt();
} else if (label === "task-panel") {
  initTaskPanel();
} else {
  listen<{ id: number; name: string; content: string | null; at: string }>("task-due", (e) => {
    toast(`⏰ ${e.payload.at} 到点了`, e.payload.name);
    refresh();
  });

  // 横条/空闲弹窗里做了开始/暂停/完成后,任务池同步刷新
  listen("tasks-changed", () => {
    void refresh();
  });

  // 横条右键「设置」:跳到设置页
  listen("open-settings", () => switchTab("settings"));

  // 横条右键改了视图模式后,设置页下拉跟着同步(两边共用 bar_view_mode 这一份配置)
  void listen("bar-settings-changed", async () => {
    const sel = document.querySelector<HTMLSelectElement>("#set-view-mode");
    if (!sel || !settingsInited) return;
    const mode = await invoke<string | null>("settings_get", { key: "bar_view_mode" });
    sel.value = mode === "half" ? "half" : "full";
  });

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab!))
  );

  // 按天翻页
  document.querySelector("#day-prev")!.addEventListener("click", () => {
    const d = new Date(`${viewDate}T00:00:00`);
    d.setDate(d.getDate() - 1);
    viewDate = toDateStr(d);
    updateDayLabel();
    void refresh();
  });
  document.querySelector("#day-next")!.addEventListener("click", () => {
    const d = new Date(`${viewDate}T00:00:00`);
    d.setDate(d.getDate() + 1);
    viewDate = toDateStr(d);
    updateDayLabel();
    void refresh();
  });
  document.querySelector("#day-today")!.addEventListener("click", () => {
    viewDate = toDateStr(new Date());
    updateDayLabel();
    void refresh();
  });
  updateDayLabel();

  document.querySelector("#btn-finish")?.addEventListener("click", async () => {
    if (!openLog) return;
    await invoke("task_finish", { logId: openLog.logId });
    await refresh();
  });

  document.querySelector("#detail-mask")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) (e.currentTarget as HTMLElement).hidden = true;
  });

  const form = document.querySelector<HTMLFormElement>("#task-form")!;
  const cronField = document.querySelector<HTMLElement>("#field-cron")!;
  const dueField = document.querySelector<HTMLElement>("#field-due")!;

  form.addEventListener("change", () => {
    const recurring = form.kind.value === "recurring";
    cronField.hidden = !recurring;
    dueField.hidden = recurring;
  });

  // cron 预设快捷填充
  document.querySelectorAll<HTMLButtonElement>(".cron-chips .chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      document.querySelector<HTMLInputElement>("#task-cron")!.value = chip.dataset.cron!;
    })
  );

  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    try {
      await invoke("task_create", {
        name: form["task-name"].value,
        content: form["task-content"].value || null,
        kind: form.kind.value,
        cron: form.kind.value === "recurring" ? form["task-cron"].value : null,
        startTime: null,
        estimatedMinutes: form["task-est"].value ? Number(form["task-est"].value) : null,
        priority: null,
        onceDue:
          form.kind.value === "once" && form["task-due"].value
            ? new Date(form["task-due"].value).toISOString()
            : null,
      });
      form.reset();
      cronField.hidden = true;
      dueField.hidden = false;
      switchTab("pool");
    } catch (err) {
      errEl.textContent = String(err);
    }
  };

  document.querySelector("#btn-cancel")?.addEventListener("click", () => switchTab("pool"));

  const aiParseBtn = document.querySelector<HTMLButtonElement>("#btn-ai-parse")!;
  aiParseBtn.addEventListener("click", async () => {
    const text = document.querySelector<HTMLTextAreaElement>("#ai-text")!.value.trim();
    const msg = document.querySelector<HTMLElement>("#ai-msg")!;
    if (!text) return;
    msg.textContent = "AI 解析中…";
    aiParseBtn.disabled = true;
    try {
      const n = await aiCreateTasks(text);
      msg.textContent = `✓ 创建了 ${n} 个任务`;
      document.querySelector<HTMLTextAreaElement>("#ai-text")!.value = "";
      switchTab("pool");
    } catch (err) {
      msg.textContent = String(err);
    } finally {
      aiParseBtn.disabled = false;
    }
  });

  document.querySelector("#btn-ai-review")?.addEventListener("click", () => aiReview());

  refresh();
}
