"use client";

import { useEffect, useState } from "react";
import { applyTheme, readTheme, type Theme } from "@/lib/theme";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(readTheme());
    const onChange = () => setTheme(readTheme());
    window.addEventListener("rv2-theme-change", onChange);
    return () => window.removeEventListener("rv2-theme-change", onChange);
  }, []);

  const flip = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    applyTheme(next);
    setTheme(next);
  };

  const isLight = theme === "light";

  return (
    <button
      type="button"
      onClick={flip}
      className="ml-auto flex items-center gap-2 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800/60 hover:text-slate-100"
      title={isLight ? "Switch to dark mode" : "Switch to day mode"}
      aria-label={isLight ? "Switch to dark mode" : "Switch to day mode"}
    >
      <span aria-hidden>{isLight ? "🌙" : "☀️"}</span>
      <span>{isLight ? "Dark" : "Day"}</span>
    </button>
  );
}
