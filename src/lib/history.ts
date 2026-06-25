"use client";

// Persistent run history for the Inspector. Stored in localStorage so past
// runs survive reloads. Browser-local results store the source video URL along
// with the confidence plots, health, and events, so old entries do not depend
// on the in-memory job map.

import type { AnalysisResult } from "./api";

export type RunRecord = {
  id: string; // backend job id
  at: number;
  label: string;
  model: string;
  level: number | null;
  start: number;
  end: number;
  result: AnalysisResult;
};

const KEY = "rv2.runHistory";
const MAX_RUNS = 20;

export function loadHistory(): RunRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as RunRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: RunRecord[]): void {
  if (typeof window === "undefined") return;
  // Newest first; keep the most recent runs and, if the browser refuses the
  // write (quota), drop the oldest entries until it fits.
  let list = history.slice(0, MAX_RUNS);
  while (list.length > 0) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(list));
      return;
    } catch {
      list = list.slice(0, list.length - 1);
    }
  }
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
