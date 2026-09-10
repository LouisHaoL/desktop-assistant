import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * 主题系统:所有窗口共用。
 * - 模式:跟随系统 / 强制浅色 / 强制深色(styles.css 按 data-scheme 切换调色板)
 * - 主色 / 进行中色:覆盖 CSS 变量,派生色(--accent-soft)按当前明暗自动混合
 * - 设置页改完 emit "theme-changed",各窗口监听后实时重刷
 */

export interface ThemePreset {
  id: string;
  name: string;
  accent: string;
  doing: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: "default", name: "默认蓝", accent: "#4f6ef7", doing: "#18a05e" },
  { id: "mint", name: "薄荷", accent: "#0d9f6e", doing: "#f59e0b" },
  { id: "sunset", name: "落日橙", accent: "#ea7317", doing: "#e11d48" },
  { id: "sakura", name: "樱粉", accent: "#e2599b", doing: "#8b5cf6" },
  { id: "ocean", name: "海盐", accent: "#0ea5e9", doing: "#14b8a6" },
  { id: "grape", name: "葡萄", accent: "#8b5cf6", doing: "#22c55e" },
];

export interface ThemeSettings {
  mode: "auto" | "light" | "dark";
  accent: string; // 空 = 用内置默认
  doing: string;
}

const DEFAULTS: ThemeSettings = { mode: "auto", accent: "", doing: "" };

export async function loadThemeSettings(): Promise<ThemeSettings> {
  try {
    const [mode, accent, doing] = await Promise.all([
      invoke<string | null>("settings_get", { key: "theme_mode" }),
      invoke<string | null>("settings_get", { key: "theme_accent" }),
      invoke<string | null>("settings_get", { key: "theme_doing" }),
    ]);
    return {
      mode: mode === "light" || mode === "dark" ? mode : "auto",
      accent: accent ?? "",
      doing: doing ?? "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveThemeSettings(s: ThemeSettings) {
  await invoke("settings_set", { key: "theme_mode", value: s.mode });
  await invoke("settings_set", { key: "theme_accent", value: s.accent });
  await invoke("settings_set", { key: "theme_doing", value: s.doing });
  await emit("theme-changed", {}).catch(() => {});
}

// ---- 颜色小工具 ----

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 把前景色按不透明度混入底色,返回不透明 hex(透明变量在某些组件上会露底) */
export function mixOver(fg: string, bg: string, alpha: number): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  if (!f || !b) return fg;
  const ch = (i: number) => Math.round(f[i] * alpha + b[i] * (1 - alpha));
  return `#${ch(0).toString(16).padStart(2, "0")}${ch(1).toString(16).padStart(2, "0")}${ch(2)
    .toString(16)
    .padStart(2, "0")}`;
}

/** 浅色/深色两套底色,与 styles.css 里的调色板保持一致 */
const CARD_LIGHT = "#ffffff";
const CARD_DARK = "#22242a";

function resolvedScheme(s: ThemeSettings): "light" | "dark" {
  if (s.mode === "light" || s.mode === "dark") return s.mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 把主题真正刷到 documentElement 上。每个窗口启动时调一次 + 监听 theme-changed */
export async function applyTheme(): Promise<ThemeSettings> {
  const s = await loadThemeSettings();
  const root = document.documentElement;
  const scheme = resolvedScheme(s);
  root.dataset.scheme = scheme;
  root.style.setProperty("color-scheme", scheme);

  if (s.accent) {
    root.style.setProperty("--accent", s.accent);
    // 浅色模式淡底=主色混白;深色模式=主色混深卡片色
    const softBg = scheme === "light" ? CARD_LIGHT : CARD_DARK;
    root.style.setProperty("--accent-soft", mixOver(s.accent, softBg, scheme === "light" ? 0.12 : 0.28));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-soft");
  }
  if (s.doing) root.style.setProperty("--doing", s.doing);
  else root.style.removeProperty("--doing");
  return s;
}

/** 主窗口等所有窗口启动时挂:应用一次 + 跟随系统变化 + 设置改动实时生效 */
export function initThemeLive() {
  void applyTheme();
  void listen("theme-changed", () => void applyTheme());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    void loadThemeSettings().then((s) => {
      if (s.mode === "auto") void applyTheme();
    });
  });
}
