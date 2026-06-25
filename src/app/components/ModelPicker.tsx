"use client";

import type { ModelInfo } from "@/lib/api";
import { useModelPrefs } from "@/lib/prefs";

type Props = {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
  selectClassName?: string;
};

export default function ModelPicker({ models, value, onChange, selectClassName }: Props) {
  const { prefs, toggleFavourite } = useModelPrefs();
  const favSet = new Set(prefs.favourites);
  const favModels = models.filter((m) => favSet.has(m.id));
  const otherModels = models.filter((m) => !favSet.has(m.id));
  const isFav = !!value && favSet.has(value);
  const isDefault = !!value && prefs.defaultModel === value;

  const selClass =
    selectClassName ??
    "min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-sm text-slate-200";

  return (
    <div className="flex items-center gap-1.5">
      <select className={selClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {models.length === 0 && <option value="">No models found</option>}
        {favModels.length > 0 && (
          <optgroup label="★ Favourites">
            {favModels.map((m) => (
              <option key={m.id} value={m.id}>
                ★ {m.label}
                {prefs.defaultModel === m.id ? " (default)" : ""}
              </option>
            ))}
          </optgroup>
        )}
        {favModels.length > 0 ? (
          <optgroup label="All models">
            {otherModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {prefs.defaultModel === m.id ? " (default)" : ""}
              </option>
            ))}
          </optgroup>
        ) : (
          otherModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {prefs.defaultModel === m.id ? " (default)" : ""}
            </option>
          ))
        )}
      </select>
      <button
        type="button"
        onClick={() => toggleFavourite(value)}
        disabled={!value}
        aria-pressed={isFav}
        title={isFav ? "Remove from favourites" : "Add to favourites (becomes the default)"}
        className={`shrink-0 rounded-md border px-2 py-1.5 text-sm leading-none transition disabled:opacity-40 ${
          isFav
            ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
            : "border-slate-700 text-slate-400 hover:text-amber-300"
        }`}
      >
        {isFav ? "★" : "☆"}
      </button>
      {isDefault && (
        <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
          default
        </span>
      )}
    </div>
  );
}
