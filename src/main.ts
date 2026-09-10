import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
}

interface LogWithTask extends TaskLog {
  task_name: string;
  estimated_minutes: number | null;
  actual_minutes: number | null;
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

// ============ 主面板(任务池 / 新增 / 复盘 / 设置) ============

const listEl = document.querySelector<HTMLUListElement>("#task-list")!;
const errEl = document.querySelector<HTMLElement>("#task-err")!;
const bannerEl = document.querySelector<HTMLElement>("#doing-banner")!;
const doingNameEl = document.querySelector<HTMLElement>("#doing-name")!;
const emptyEl = document.querySelector<HTMLElement>("#empty-hint")!;

let openLog: { taskId: number; logId: number } | null = null;

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
  emptyEl.hidden = tasks.length > 0;

  listEl.innerHTML = "";
  for (const t of tasks) {
    const li = document.createElement("li");
    li.className = `task task-${t.status}`;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.name;
    if (t.content) {
      li.title = t.content;
      name.style.borderBottom = "1px dotted currentColor";
      name.style.cursor = "help";
    }

    const badge = document.createElement("span");
    badge.className = `badge${t.kind === "recurring" ? " badge-recurring" : ""}${
      t.status === "doing" ? " badge-doing" : ""
    }`;
    badge.textContent =
      t.status === "doing" ? "进行中" : t.kind === "recurring" ? "周期" : "一次性";

    const detail = document.createElement("span");
    detail.className = "detail";
    const when =
      t.kind === "recurring"
        ? `cron ${t.cron}`
        : t.once_due
          ? new Date(t.once_due).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
          : "未定时间";
    detail.textContent = `${when}${t.estimated_minutes ? ` · 约 ${t.estimated_minutes} 分钟` : ""}`;

    li.append(name, badge, detail);

    if (t.status === "todo") {
      const startBtn = document.createElement("button");
      startBtn.textContent = "开始";
      startBtn.onclick = async () => {
        await invoke("task_start", { id: t.id, source: "user" });
        await refresh();
      };
      li.append(startBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.textContent = "删除";
    delBtn.className = "danger";
    delBtn.onclick = async () => {
      await invoke("task_delete", { id: t.id });
      await refresh();
    };
    li.append(delBtn);
    listEl.append(li);
  }
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
      start_time: null,
      estimated_minutes: typeof t.estimated_minutes === "number" ? Math.round(t.estimated_minutes) : null,
      priority: null,
      once_due: typeof t.once_due === "string" ? t.once_due : null,
    });
    created += 1;
  }
  return created;
}

// ============ 设置页 ============

let settingsInited = false;

async function initSettingsOnce() {
  if (settingsInited) return;
  settingsInited = true;

  const presetSel = document.querySelector<HTMLSelectElement>("#set-preset")!;
  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSel.append(opt);
  }
  const models = document.querySelector<HTMLDataListElement>("#set-models")!;

  function applyPreset(id: string) {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    document.querySelector<HTMLInputElement>("#set-baseurl")!.value = p.baseUrl;
    models.innerHTML = "";
    for (const m of p.models) {
      const o = document.createElement("option");
      o.value = m;
      models.append(o);
    }
    document.querySelector<HTMLInputElement>("#set-model")!.value = p.models[0] ?? "";
  }
  presetSel.onchange = () => applyPreset(presetSel.value);

  // 载入已存配置
  const [baseUrl, apiKey, model, threshold] = await Promise.all([
    invoke<string | null>("settings_get", { key: "llm_base_url" }),
    invoke<string | null>("settings_get", { key: "llm_api_key" }),
    invoke<string | null>("settings_get", { key: "llm_model" }),
    invoke<string | null>("settings_get", { key: "idle_threshold_minutes" }),
  ]);
  if (baseUrl) {
    const match = PROVIDER_PRESETS.find((p) => p.baseUrl === baseUrl);
    if (match) presetSel.value = match.id;
    else presetSel.value = "custom";
    document.querySelector<HTMLInputElement>("#set-baseurl")!.value = baseUrl;
    document.querySelector<HTMLInputElement>("#set-model")!.value = model ?? "";
  } else {
    applyPreset(presetSel.value);
  }
  document.querySelector<HTMLInputElement>("#set-key")!.value = apiKey ?? "";
  document.querySelector<HTMLInputElement>("#set-threshold")!.value = threshold ?? "15";

  document.querySelector("#set-save")!.addEventListener("click", async () => {
    const msg = document.querySelector<HTMLElement>("#set-msg")!;
    msg.textContent = "";
    try {
      await invoke("settings_set", {
        key: "llm_base_url",
        value: document.querySelector<HTMLInputElement>("#set-baseurl")!.value.trim(),
      });
      await invoke("settings_set", {
        key: "llm_api_key",
        value: document.querySelector<HTMLInputElement>("#set-key")!.value.trim(),
      });
      await invoke("settings_set", {
        key: "llm_model",
        value: document.querySelector<HTMLInputElement>("#set-model")!.value.trim(),
      });
      await invoke("settings_set", {
        key: "idle_threshold_minutes",
        value: document.querySelector<HTMLInputElement>("#set-threshold")!.value || "15",
      });
      msg.textContent = "✓ 已保存";
    } catch (err) {
      msg.textContent = String(err);
    }
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

// ============ 入口路由:按窗口标签分发视图 ============

const label = getCurrentWindow().label;
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

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab!))
  );

  document.querySelector("#btn-finish")?.addEventListener("click", async () => {
    if (!openLog) return;
    await invoke("task_finish", { logId: openLog.logId });
    await refresh();
  });

  const form = document.querySelector<HTMLFormElement>("#task-form")!;
  const cronField = document.querySelector<HTMLElement>("#field-cron")!;
  const dueField = document.querySelector<HTMLElement>("#field-due")!;

  form.addEventListener("change", () => {
    const recurring = form.kind.value === "recurring";
    cronField.hidden = !recurring;
    dueField.hidden = recurring;
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    try {
      await invoke("task_create", {
        name: form["task-name"].value,
        content: form["task-content"].value || null,
        kind: form.kind.value,
        cron: form.kind.value === "recurring" ? form["task-cron"].value : null,
        start_time: null,
        estimated_minutes: form["task-est"].value ? Number(form["task-est"].value) : null,
        priority: null,
        once_due:
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
