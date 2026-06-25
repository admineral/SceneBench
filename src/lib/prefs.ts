"use client";

// Per-browser user preferences for the detector controls: favourite models, a
// default model, and a default confidence. Persisted to localStorage and kept
// in sync across mounted components via a custom event.

import { useEffect, useState } from "react";

const KEY = "rv2.modelPrefs";
const EVT = "rv2-prefs-change";

export type ModelPrefs = {
  favourites: string[];
  defaultModel: string;
  defaultConf: number;
};

const DEFAULT_PREFS: ModelPrefs = {
  favourites: [],
  defaultModel: "",
  defaultConf: 0.15,
};

export function readModelPrefs(): ModelPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<ModelPrefs>;
    return {
      favourites: Array.isArray(p.favourites) ? p.favourites.filter((x) => typeof x === "string") : [],
      defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : "",
      defaultConf: typeof p.defaultConf === "number" ? p.defaultConf : DEFAULT_PREFS.defaultConf,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeModelPrefs(prefs: ModelPrefs) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(prefs));
  window.dispatchEvent(new CustomEvent(EVT));
}

export function useModelPrefs() {
  // Start from defaults so server and first client render match, then hydrate
  // from localStorage on mount.
  const [prefs, setPrefs] = useState<ModelPrefs>(DEFAULT_PREFS);

  useEffect(() => {
    setPrefs(readModelPrefs());
    const onChange = () => setPrefs(readModelPrefs());
    window.addEventListener(EVT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const toggleFavourite = (id: string) => {
    if (!id) return;
    const cur = readModelPrefs();
    const removing = cur.favourites.includes(id);
    const favourites = removing
      ? cur.favourites.filter((x) => x !== id)
      : [...cur.favourites, id];
    // The default model always tracks the most recently favourited model.
    // When adding, that's the model just starred. When removing the current
    // default, fall back to the newest remaining favourite (or none).
    let defaultModel = cur.defaultModel;
    if (!removing) {
      defaultModel = id;
    } else if (cur.defaultModel === id) {
      defaultModel = favourites[favourites.length - 1] ?? "";
    }
    writeModelPrefs({ ...cur, favourites, defaultModel });
  };

  const setDefaultModel = (id: string) => writeModelPrefs({ ...readModelPrefs(), defaultModel: id });
  const setDefaultConf = (conf: number) => writeModelPrefs({ ...readModelPrefs(), defaultConf: conf });
  const setDefaults = (id: string, conf: number) =>
    writeModelPrefs({ ...readModelPrefs(), defaultModel: id, defaultConf: conf });

  return { prefs, toggleFavourite, setDefaultModel, setDefaultConf, setDefaults };
}
