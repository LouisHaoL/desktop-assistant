import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { initBar } from "./bar";
import { initPet } from "./pet";
import { initPrompt } from "./prompt";
import { PROVIDER_PRESETS } from "./providers";

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

function toast(title: string, body: string, ms = 8000) {
  const box = document.querySelector<HTMLDivElement>("#toasts")!;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="toast-title"></div><div class="toast-body"></div>`;
  el.querySelector<HTMLElement>(".toast-title")!.textContent = title;
  el.querySelector<HTMLElement>(".toast-body")!.textContent = body;
  el.onclick = () => el.remove();
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

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
}

async function refresh() {
  const tasks = await invoke<Task[]>("task_list");

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
  const dayTasks = await invoke<Task[]>("tasks_for_day", { date: viewDate }).catch(() => []);
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
  if (dayTasks.length === 0) return;
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

  // 时间轴设置
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
    const bar = await WebviewWindow.getByLabel("timeline-bar");
    bar?.emit("bar-settings-changed", {});
  };
  const barVisible = document.querySelector<HTMLInputElement>("#set-bar-visible")!;
  const bar = await WebviewWindow.getByLabel("timeline-bar");
  barVisible.checked = bar ? await bar.isVisible() : true;
  barVisible.onchange = async () => {
    const w = await WebviewWindow.getByLabel("timeline-bar");
    if (!w) return;
    if (barVisible.checked) await w.show();
    else await w.hide();
  };

  // 空闲阈值
  const threshold = await invoke<string | null>("settings_get", { key: "idle_threshold_minutes" });
  document.querySelector<HTMLInputElement>("#set-threshold")!.value = threshold ?? "15";
  document.querySelector("#set-save-misc")!.addEventListener("click", async () => {
    await invoke("settings_set", {
      key: "idle_threshold_minutes",
      value: document.querySelector<HTMLInputElement>("#set-threshold")!.value || "15",
    });
    toast("已保存", "空闲提醒阈值已更新");
  });
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

if (label === "timeline-bar") {
  initBar();
} else if (label === "pet") {
  initPet();
} else if (label === "idle-prompt") {
  initPrompt();
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
