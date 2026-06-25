export type Theme = "dark" | "light";

const KEY = "rv2.theme";
export const THEME_EVENT = "rv2-theme-change";

export function readTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

export function toggleTheme(): Theme {
  const next: Theme = readTheme() === "light" ? "dark" : "light";
  applyTheme(next);
  return next;
}
