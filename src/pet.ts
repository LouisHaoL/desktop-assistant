import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Task {
  id: number;
  name: string;
  content: string | null;
  status: string;
}

interface Occurrence {
  task_id: number;
  name: string;
  start_minute: number;
}

const IDLE_LINES = ["今天也要加油鸭~", "没任务就摸会儿鱼吧 🐟", "点我可以看任务哦", "记得多喝水!"];

const WIN = getCurrentWindow();

// ---- 外观设置(设置页改动会广播 pet-settings-changed) ----
let petFace = "🐱";
let petImageDataUrl: string | null = null; // null = 用表情
let petSize = 64;
type SlotName = "idle" | "work" | "alert";
interface SlotAnim {
  urls: string[];
  ms: number;
  durations?: number[]; // 每帧停留时长覆盖(ms),与 urls 等长
}
let petAnims: Partial<Record<SlotName, SlotAnim>> = {};
let statusSlot: SlotName = "idle"; // 状态槽位:有任务进行中为 work,否则 idle

function mimeOf(name: string): string {
  const ext = name.split(".").pop() ?? "";
  return ext === "jpg" ? "jpeg" : ext || "png";
}

export async function initPet() {
  const root = document.querySelector<HTMLDivElement>("#view-root")!;
  root.hidden = false;
  root.innerHTML = `
    <div class="pet-wrap" id="pet-wrap">
      <div class="pet-bubble" id="pet-bubble">加载中…</div>
      <div class="pet-body" id="pet-body" title="按住拖动;单击说话;右键菜单">
        <span class="pet-face" id="pet-face"></span>
        <span class="pet-status-dot" id="pet-dot"></span>
      </div>
      <div class="pet-menu" id="pet-menu" hidden>
        <button type="button" data-act="lock"></button>
        <button type="button" data-act="open-main">📋 打开主面板</button>
        <button type="button" data-act="appearance">🎨 外观设置</button>
      </div>
    </div>`;

  const bubble = root.querySelector<HTMLDivElement>("#pet-bubble")!;
  const dot = root.querySelector<HTMLElement>("#pet-dot")!;
  const bodyEl = root.querySelector<HTMLElement>("#pet-body")!;
  const faceEl = root.querySelector<HTMLElement>("#pet-face")!;
  const menuEl = root.querySelector<HTMLDivElement>("#pet-menu")!;
  let msgIndex = 0;
  let statusText = "";
  let locked = false;

  // ---- 外观:动作动画(待机/工作/提醒三槽位)/ 单图 / 表情 + 大小;设置页改动实时重刷 ----
  let animTimer: number | undefined;
  let animSeq = 0; // 重入守卫:新一轮播放/切换会让上一轮的异步加载作废

  const stopAnimTimer = () => {
    if (animTimer) {
      clearTimeout(animTimer);
      animTimer = undefined;
    }
  };

  function frameDuration(anim: SlotAnim, i: number): number {
    return Math.max(40, Number(anim.durations?.[i]) || anim.ms);
  }

  // 把帧全部预解码后叠放进 faceEl,播放时只切 hidden,不闪不重排;seq 过期则不动 DOM
  async function mountFrames(urls: string[], seq: number) {
    const imgs = await Promise.all(
      urls.map((src) => {
        const im = new Image();
        im.src = src;
        return im.decode().then(
          () => im,
          () => im
        );
      })
    );
    if (seq !== animSeq) return [];
    faceEl.textContent = "";
    imgs.forEach((im, i) => {
      im.className = "pet-img";
      im.alt = "桌宠";
      im.draggable = false;
      im.hidden = i !== 0;
      faceEl.append(im);
    });
    return imgs;
  }

  // 按状态槽位渲染:工作动画(回落待机)→ 待机动画 → 静态图/表情
  function renderCurrentLook() {
    const seq = ++animSeq;
    stopAnimTimer();
    bodyEl.style.width = `${petSize}px`;
    bodyEl.style.height = `${petSize}px`;
    const slot: SlotName | null =
      statusSlot === "work" && petAnims.work ? "work" : petAnims.idle ? "idle" : null;
    const anim = slot ? petAnims[slot] : undefined;
    if (anim) {
      void mountFrames(anim.urls, seq).then((imgs) => {
        if (seq !== animSeq || imgs.length < 2) return;
        let idx = 0;
        const tick = () => {
          if (seq !== animSeq) return;
          idx = (idx + 1) % imgs.length;
          imgs.forEach((im, i) => (im.hidden = i !== idx));
          animTimer = window.setTimeout(tick, frameDuration(anim, idx));
        };
        animTimer = window.setTimeout(tick, frameDuration(anim, 0));
      });
    } else if (petImageDataUrl) {
      void mountFrames([petImageDataUrl], seq);
    } else {
      faceEl.textContent = petFace;
      faceEl.style.fontSize = `${Math.round(petSize * 0.75)}px`;
    }
  }

  // 提醒动画:播一遍后自动回落到状态动画(VPet 式 Start→End)
  function playAlertOnce() {
    const anim = petAnims.alert;
    if (!anim || anim.urls.length === 0) return; // 未配提醒动画就只有气泡
    const seq = ++animSeq;
    stopAnimTimer();
    bodyEl.style.width = `${petSize}px`;
    bodyEl.style.height = `${petSize}px`;
    void mountFrames(anim.urls, seq).then((imgs) => {
      if (seq !== animSeq || imgs.length < 2) return;
      let idx = 0;
      const tick = () => {
        if (seq !== animSeq) return;
        if (idx >= imgs.length - 1) {
          renderCurrentLook(); // 播完回落 idle/work
          return;
        }
        idx += 1;
        imgs.forEach((im, i) => (im.hidden = i !== idx));
        animTimer = window.setTimeout(tick, frameDuration(anim, idx));
      };
      animTimer = window.setTimeout(tick, frameDuration(anim, idx));
    });
  }

  function setSlot(s: SlotName) {
    if (statusSlot === s) return;
    statusSlot = s;
    renderCurrentLook();
  }

  async function applyAppearance() {
    const seq = ++animSeq;
    stopAnimTimer();
    try {
      petFace = (await invoke<string | null>("settings_get", { key: "pet_face" })) || "🐱";
      petSize = Number((await invoke<string | null>("settings_get", { key: "pet_size" })) || "64") || 64;
      const image = (await invoke<string | null>("settings_get", { key: "pet_image" })) || "";
      petImageDataUrl = image
        ? `data:image/${mimeOf(image)};base64,${await invoke<string>("pet_asset_read", { name: image })}`
        : null;

      // 动作动画:pet_actions = { idle/work/alert: { frames: 素材名列表, ms, durations? } }
      let actions: Record<string, { frames?: unknown; ms?: unknown; durations?: unknown }> = {};
      const actionsStr = await invoke<string | null>("settings_get", { key: "pet_actions" });
      if (actionsStr) {
        try {
          const parsed = JSON.parse(actionsStr);
          if (parsed && typeof parsed === "object") actions = parsed;
        } catch {
          /* 解析不了当没有 */
        }
      } else {
        // 旧数据:上一版的单一帧序列当作待机动画
        try {
          const legacy = JSON.parse(
            (await invoke<string | null>("settings_get", { key: "pet_frames" })) || "[]"
          );
          if (Array.isArray(legacy) && legacy.length > 0) {
            actions.idle = {
              frames: legacy,
              ms: Number((await invoke<string | null>("settings_get", { key: "pet_frame_ms" })) || "200") || 200,
            };
          }
        } catch {
          /* 无旧数据 */
        }
      }

      const loadUrls = async (frames: unknown): Promise<string[]> => {
        if (!Array.isArray(frames)) return [];
        const urls = await Promise.all(
          frames.filter((n): n is string => typeof n === "string").map(async (n) => {
            try {
              return `data:image/${mimeOf(n)};base64,${await invoke<string>("pet_asset_read", { name: n })}`;
            } catch {
              return null; // 某帧读不到就跳过,别整组播不了
            }
          })
        );
        return urls.filter((u): u is string => !!u);
      };

      petAnims = {};
      for (const slot of ["idle", "work", "alert"] as SlotName[]) {
        const a = actions[slot];
        if (!a || typeof a !== "object") continue;
        const urls = await loadUrls(a.frames);
        if (urls.length === 0) continue;
        const durations = Array.isArray(a.durations)
          ? a.durations.map((d) => Math.max(40, Number(d) || 200))
          : undefined;
        petAnims[slot] = {
          urls,
          ms: Math.max(40, Number(a.ms) || 200),
          durations: durations && durations.length >= urls.length ? durations.slice(0, urls.length) : undefined,
        };
      }
    } catch {
      /* 读不到就用默认外观 */
    }
    if (seq !== animSeq) return;
    renderCurrentLook();
  }

  // ---- 锁定 / 解锁拖动,状态存 settings,由右键菜单切换 ----
  async function applyLock() {
    try {
      locked = (await invoke<string | null>("settings_get", { key: "pet_locked" })) === "1";
    } catch {
      locked = false;
    }
    menuEl.querySelector<HTMLButtonElement>('[data-act="lock"]')!.textContent = locked
      ? "🔓 解锁拖动"
      : "🔒 锁定位置";
  }

  // ---- 手动拖拽:按住移动超过 4px 就开始拖窗口;没移动的算单击(说话) ----
  let downPos: { x: number; y: number } | null = null;
  bodyEl.addEventListener("mousedown", (e) => {
    if (locked || e.button !== 0) return;
    downPos = { x: e.clientX, y: e.clientY };
  });
  bodyEl.addEventListener("mousemove", (e) => {
    if (!downPos) return;
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) {
      downPos = null;
      void WIN.startDragging();
    }
  });
  window.addEventListener("mouseup", () => (downPos = null));

  // ---- 右键菜单:锁定/解锁、打开主面板 ----
  bodyEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    menuEl.querySelector<HTMLButtonElement>('[data-act="lock"]')!.textContent = locked
      ? "🔓 解锁拖动"
      : "🔒 锁定位置";
    menuEl.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
    menuEl.style.top = `${Math.min(e.clientY + 6, window.innerHeight - 130)}px`;
    menuEl.hidden = false;
  });
  document.addEventListener("mousedown", (e) => {
    if (menuEl.hidden) return;
    if (!menuEl.contains(e.target as HTMLElement)) menuEl.hidden = true;
  });
  menuEl.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    menuEl.hidden = true;
    if (btn.dataset.act === "lock") {
      const next = locked ? "0" : "1";
      await invoke("settings_set", { key: "pet_locked", value: next });
      locked = next === "1";
      await applyLock();
      speak(locked ? "我站在这儿不动了" : "可以拖动我啦~");
    } else if (btn.dataset.act === "open-main") {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const main = await WebviewWindow.getByLabel("main");
      if (main) {
        await main.show();
        await main.setFocus();
      }
    } else if (btn.dataset.act === "appearance") {
      // 打开主面板并直达设置页的桌宠外观卡片
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const main = await WebviewWindow.getByLabel("main");
      if (main) {
        await main.show();
        await main.setFocus();
      }
      await emit("open-settings", {});
    }
  });

  // ---- 位置记忆 ----
  let saveTimer: number | undefined;
  void WIN.onMoved(async ({ payload }) => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        const sc = await WIN.scaleFactor();
        await invoke("settings_set", { key: "pet_x", value: String(Math.round(payload.x / sc)) });
        await invoke("settings_set", { key: "pet_y", value: String(Math.round(payload.y / sc)) });
      } catch {
        /* 存不上就下次还用默认位置 */
      }
    }, 600);
  });

  async function refreshStatus() {
    try {
      const tasks = await invoke<Task[]>("task_list");
      const doing = tasks.find((t) => t.status === "doing");
      if (doing) {
        dot.classList.add("busy");
        statusText = `正在做:${doing.name}`;
        setSlot("work");
        return;
      }
      dot.classList.remove("busy");
      setSlot("idle");
      const occ = await invoke<Occurrence[]>("timeline_today").catch(() => [] as Occurrence[]);
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const next = occ
        .filter((o) => o.start_minute >= nowMin)
        .sort((a, b) => a.start_minute - b.start_minute)[0];
      statusText = next
        ? `下个任务 ${String(Math.floor(next.start_minute / 60)).padStart(2, "0")}:${String(
            next.start_minute % 60
          ).padStart(2, "0")} ${next.name}`
        : "今天没有安排~";
    } catch {
      statusText = "唤醒失败,戳戳我?";
    }
  }

  function speak(text: string) {
    bubble.textContent = text;
    bubble.classList.add("show");
    setTimeout(() => bubble.classList.remove("show"), 8000);
  }

  faceEl.addEventListener("click", () => {
    msgIndex += 1;
    const lines = [statusText, ...IDLE_LINES];
    speak(lines[msgIndex % lines.length]);
  });

  // 到点提醒也要从桌宠嘴里说出来(系统通知可能被吞);配了提醒动画就顺带演一遍
  void listen<{ name: string; at: string }>("task-due", (e) => {
    speak(`⏰ ${e.payload.at} 该做「${e.payload.name}」啦`);
    playAlertOnce();
  });

  // 设置页换了表情/图片/大小后实时重刷
  void listen("pet-settings-changed", () => void applyAppearance());

  // 任务有增删改/状态变化时立刻刷新状态文案,不等下一轮轮询
  void listen("tasks-changed", () => void refreshStatus());

  setInterval(refreshStatus, 30_000);
  void applyLock();
  await applyAppearance();
  refreshStatus().then(() => speak(statusText));
}
