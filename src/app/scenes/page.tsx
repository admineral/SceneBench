"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Scene } from "@/lib/api";
import ClipperTimeline from "../components/ClipperTimeline";
import SceneInference from "../components/SceneInference";

type Range = { start: number; end: number };

const LEVELS = [1, 2, 3];
const QUICK_LABELS = [
  "car_front",
  "car_rear",
  "car_side",
  "2 cars",
  "3+ cars",
  "bike",
  "dropout",
  "occlusion",
  "flicker",
  "light_issue",
];

export default function ScenesPage() {
  const [level, setLevel] = useState(2);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [selection, setSelection] = useState<Range | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);

  // editor form
  const [name, setName] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [customLabel, setCustomLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Free-typing drafts for the Start/End number inputs. Driving them straight off
  // `selection` makes typing impossible (clearing -> Number("") = 0, and "1." parses
  // back to "1"), so we keep the raw text and only mirror `selection` while unfocused.
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const startFocused = useRef(false);
  const endFocused = useRef(false);

  const [analyzeFor, setAnalyzeFor] = useState<{ start: number; end: number; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // inline edit (rename + retime directly in the Saved scenes list)
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineName, setInlineName] = useState("");
  // Kept as raw text so manual typing (clearing, decimals) works in the inputs.
  const [inlineStart, setInlineStart] = useState("");
  const [inlineEnd, setInlineEnd] = useState("");
  const [inlineSaving, setInlineSaving] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRaf = useRef<number>(0);

  const loadScenes = useCallback(async () => {
    try {
      setScenes(await api.listScenes(level));
    } catch {
      setError("Could not load scenes. Is the backend running?");
    }
  }, [level]);

  useEffect(() => {
    loadScenes();
  }, [loadScenes]);

  // Reset preview state when switching level.
  useEffect(() => {
    cancelAnimationFrame(previewRaf.current);
    previewRaf.current = 0;
    setDuration(0);
    setCurrentTime(0);
    setSelection(null);
    setAnalyzeFor(null);
    setName("");
    setLabels([]);
    setCustomLabel("");
    setNotes("");
    setEditingId(null);
    setInlineEditId(null);
    setInlineName("");
    setInlineStart("");
    setInlineEnd("");
  }, [level]);

  useEffect(() => {
    let cancelled = false;
    api.rawVideoInfo(level)
      .then((info) => {
        if (!cancelled && info.duration_sec) {
          setDuration((cur) => Math.max(cur, info.duration_sec ?? 0));
        }
      })
      .catch(() => {
        /* Keep the metadata-derived duration if source info is unavailable. */
      });
    return () => {
      cancelled = true;
    };
  }, [level]);

  // Mirror selection into the Start/End text fields, but never while the user is
  // typing in them (so partial input like "1." or an empty field is preserved).
  useEffect(() => {
    if (!startFocused.current) setStartText(selection ? String(round1(selection.start)) : "");
    if (!endFocused.current) setEndText(selection ? String(round1(selection.end)) : "");
  }, [selection]);

  // Bulletproof duration capture: HTML5 metadata can load before React attaches
  // its listeners, so poll until the duration is available.
  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current;
      if (v && v.duration && isFinite(v.duration)) {
        setDuration((cur) => Math.max(cur, v.duration));
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [level]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => {
      if (v.duration && isFinite(v.duration)) {
        setDuration((cur) => Math.max(cur, v.duration));
      }
    };
    // The native `timeupdate` event only fires a few times per second, so the
    // readout jumps while playing. Poll currentTime every animation frame during
    // playback for a smooth, frame-granular display.
    const tick = () => {
      setCurrentTime(v.currentTime);
      if (!v.paused && !v.ended) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      cancelAnimationFrame(raf);
      setCurrentTime(v.currentTime);
    };
    onMeta(); // metadata may already be loaded before listeners attach
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("durationchange", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("playing", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    if (!v.paused) onPlay(); // already playing when listeners attach
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("durationchange", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("playing", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
    };
  }, [level]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(duration || t, t));
    setCurrentTime(target);
    const mediaDuration = v.duration && isFinite(v.duration) ? v.duration : duration;
    v.currentTime = Math.max(0, Math.min(mediaDuration || target, target));
  };

  const setIn = () => {
    setSelection((s) => {
      const end = s ? Math.max(currentTime + 0.1, s.end) : Math.min(duration, currentTime + 2);
      return { start: currentTime, end };
    });
  };
  const setOut = () => {
    setSelection((s) => {
      const start = s ? Math.min(s.start, currentTime - 0.1) : Math.max(0, currentTime - 2);
      return { start: Math.max(0, start), end: currentTime };
    });
  };

  const previewClip = () => {
    if (!selection) return;
    const v = videoRef.current;
    if (!v) return;
    const start = Math.max(0, selection.start);
    const end = Math.min(duration || selection.end, selection.end);
    if (!(end > start)) return;

    // Cancel any preview already in flight.
    cancelAnimationFrame(previewRaf.current);
    previewRaf.current = 0;

    // Frame-accurate stop: poll currentTime each frame and pause exactly at `end`.
    const runStopLoop = () => {
      const tick = () => {
        if (v.paused || v.ended || v.currentTime >= end) {
          if (!v.paused) v.pause();
          previewRaf.current = 0;
          return;
        }
        previewRaf.current = requestAnimationFrame(tick);
      };
      previewRaf.current = requestAnimationFrame(tick);
    };

    // Seek to the start first and wait for it to land, otherwise the stale
    // (pre-seek) currentTime can already be >= end and pause us instantly.
    const begin = () => {
      v.play()
        .then(runStopLoop)
        .catch(() => runStopLoop());
    };
    if (Math.abs(v.currentTime - start) < 0.03) {
      begin();
    } else {
      const onSeeked = () => {
        v.removeEventListener("seeked", onSeeked);
        begin();
      };
      v.addEventListener("seeked", onSeeked);
      v.currentTime = start;
    }
  };

  const toggleLabel = (l: string) =>
    setLabels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  const addCustomLabel = () => {
    const l = customLabel.trim();
    if (l && !labels.includes(l)) setLabels((cur) => [...cur, l]);
    setCustomLabel("");
  };

  const resetForm = () => {
    setName("");
    setLabels([]);
    setNotes("");
    setEditingId(null);
  };

  const updateSelectionField = (field: "start" | "end", value: number) => {
    setSelection((s) => {
      const base = s ?? { start: 0, end: Math.min(duration || 2, 2) };
      const next = { ...base, [field]: value };
      if (next.end <= next.start) next.end = next.start + 0.1;
      return next;
    });
  };

  const save = async () => {
    if (!selection) {
      setError("Select a time range first (drag the timeline or use Set In/Out).");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      level,
      name: name.trim(),
      start: selection.start,
      end: selection.end,
      labels,
      notes: notes.trim(),
    };
    try {
      if (editingId) await api.updateScene(editingId, payload);
      else await api.createScene(payload);
      await loadScenes();
      resetForm();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const editScene = (sc: Scene) => {
    setEditingId(sc.id);
    setName(sc.name);
    setLabels(sc.labels);
    setNotes(sc.notes);
    setSelection({ start: sc.start, end: sc.end });
    seek(sc.start);
  };

  const removeScene = async (id: string) => {
    if (!confirm("Delete this scene?")) return;
    try {
      await api.deleteScene(id);
      if (editingId === id) resetForm();
      await loadScenes();
    } catch (e) {
      setError(String(e));
    }
  };

  const startInlineEdit = (sc: Scene) => {
    setInlineEditId(sc.id);
    setInlineName(sc.name);
    setInlineStart(String(round1(sc.start)));
    setInlineEnd(String(round1(sc.end)));
  };

  const cancelInlineEdit = () => {
    setInlineEditId(null);
    setInlineSaving(false);
  };

  const saveInlineEdit = async (sc: Scene) => {
    let start = parseFloat(inlineStart);
    let end = parseFloat(inlineEnd);
    if (!isFinite(start)) start = sc.start;
    if (!isFinite(end)) end = sc.end;
    start = Math.max(0, start);
    if (end <= start) end = start + 0.1;
    setInlineSaving(true);
    setError(null);
    try {
      // Preserve labels/notes; only name + timestamps are edited inline.
      await api.updateScene(sc.id, {
        level: sc.level,
        name: inlineName.trim(),
        start,
        end,
        labels: sc.labels,
        notes: sc.notes,
      });
      await loadScenes();
      cancelInlineEdit();
    } catch (e) {
      setError(String(e));
      setInlineSaving(false);
    }
  };

  return (
    <main className="mx-auto max-w-[1500px] px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Scene Library</h1>
          <p className="text-xs text-slate-500">
            Clip and label important moments across the level videos. Stored as JSON on the backend.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                level === l ? "bg-sky-500 text-slate-950" : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              Level {l}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Left: preview + timeline */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              key={level}
              src={api.rawVideoUrl(level)}
              controls
              preload="metadata"
              className="max-h-[55vh] w-full bg-black"
            />
          </div>

          {/* transport */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-md bg-slate-900 px-2 py-1 font-mono text-slate-300">
              {currentTime.toFixed(2)}s / {duration ? duration.toFixed(0) : "…"}s
            </span>
            <Btn onClick={setIn}>⟦ Set In</Btn>
            <Btn onClick={setOut}>Set Out ⟧</Btn>
            <Btn onClick={previewClip} disabled={!selection}>▶ Preview clip</Btn>
            <Btn onClick={() => setSelection(null)} disabled={!selection}>Clear</Btn>
            <div className="mx-1 h-5 w-px bg-slate-700" />
            <button
              onClick={() =>
                selection &&
                setAnalyzeFor({ start: selection.start, end: selection.end, key: `sel-${Date.now()}` })
              }
              disabled={!selection}
              className="rounded-md border border-sky-700 bg-sky-900/30 px-2.5 py-1 text-sm text-sky-300 transition hover:bg-sky-900/50 disabled:opacity-40"
            >
              ⚡ Inference on selection
            </button>
          </div>

          <ClipperTimeline
            duration={duration}
            currentTime={currentTime}
            selection={selection}
            scenes={scenes}
            activeSceneId={editingId}
            onSeek={seek}
            onSelect={setSelection}
          />

          {/* inference */}
          {analyzeFor && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">Live inference & plot</h3>
                <button
                  onClick={() => setAnalyzeFor(null)}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Close ✕
                </button>
              </div>
              <SceneInference
                key={analyzeFor.key}
                level={level}
                start={analyzeFor.start}
                end={analyzeFor.end}
              />
            </div>
          )}
        </div>

        {/* Right: editor + list */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-200">
              {editingId ? "Edit scene" : "New scene"}
            </h3>
            <div className="flex flex-col gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">Name</span>
                <input
                  className="w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 py-2 text-sm text-slate-100"
                  value={name}
                  placeholder="e.g. car_rear dropout at junction"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-400">Start (s)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    className="w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 py-2 text-sm text-slate-100"
                    value={startText}
                    onFocus={() => (startFocused.current = true)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setStartText(raw);
                      if (raw.trim() !== "" && Number.isFinite(Number(raw)))
                        updateSelectionField("start", Number(raw));
                    }}
                    onBlur={() => {
                      startFocused.current = false;
                      setStartText(selection ? String(round1(selection.start)) : "");
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-400">End (s)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    className="w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 py-2 text-sm text-slate-100"
                    value={endText}
                    onFocus={() => (endFocused.current = true)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setEndText(raw);
                      if (raw.trim() !== "" && Number.isFinite(Number(raw)))
                        updateSelectionField("end", Number(raw));
                    }}
                    onBlur={() => {
                      endFocused.current = false;
                      setEndText(selection ? String(round1(selection.end)) : "");
                    }}
                  />
                </label>
              </div>

              <div>
                <span className="mb-1 block text-xs text-slate-400">Labels</span>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_LABELS.map((l) => (
                    <button
                      key={l}
                      onClick={() => toggleLabel(l)}
                      className={`rounded-full border px-2 py-0.5 text-xs transition ${
                        labels.includes(l)
                          ? "border-sky-500 bg-sky-500/20 text-sky-200"
                          : "border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    className="flex-1 rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100"
                    placeholder="custom label…"
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addCustomLabel()}
                  />
                  <button
                    onClick={addCustomLabel}
                    className="rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800"
                  >
                    Add
                  </button>
                </div>
                {labels.filter((l) => !QUICK_LABELS.includes(l)).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {labels
                      .filter((l) => !QUICK_LABELS.includes(l))
                      .map((l) => (
                        <span
                          key={l}
                          className="inline-flex items-center gap-1 rounded-full border border-sky-500 bg-sky-500/20 px-2 py-0.5 text-xs text-sky-200"
                        >
                          {l}
                          <button onClick={() => toggleLabel(l)} className="text-sky-300">
                            ✕
                          </button>
                        </span>
                      ))}
                  </div>
                )}
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">Notes</span>
                <textarea
                  className="w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 py-2 text-sm text-slate-100"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>

              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={saving || !selection}
                  className="flex-1 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
                >
                  {saving ? "Saving…" : editingId ? "Update scene" : "Save scene"}
                </button>
                {editingId && (
                  <button
                    onClick={resetForm}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* saved scenes */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-200">
              Saved scenes · Level {level} ({scenes.length})
            </h3>
            {scenes.length === 0 ? (
              <p className="text-sm text-slate-500">No scenes saved for this level yet.</p>
            ) : (
              <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
                {scenes.map((sc) => {
                  const isInlineEditing = inlineEditId === sc.id;
                  return (
                  <li
                    key={sc.id}
                    className={`rounded-lg border p-2.5 ${
                      isInlineEditing
                        ? "border-sky-500/60 bg-sky-500/5"
                        : editingId === sc.id
                        ? "border-emerald-500/50 bg-emerald-500/5"
                        : "border-slate-800"
                    }`}
                  >
                    {isInlineEditing ? (
                      <div className="flex flex-col gap-2">
                        <label className="block">
                          <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-400">
                            Name
                          </span>
                          <input
                            autoFocus
                            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                            value={inlineName}
                            placeholder="Scene name"
                            onChange={(e) => setInlineName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveInlineEdit(sc);
                              if (e.key === "Escape") cancelInlineEdit();
                            }}
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-400">
                              Start (s)
                            </span>
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                              value={inlineStart}
                              onChange={(e) => setInlineStart(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveInlineEdit(sc);
                                if (e.key === "Escape") cancelInlineEdit();
                              }}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-400">
                              End (s)
                            </span>
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                              value={inlineEnd}
                              onChange={(e) => setInlineEnd(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveInlineEdit(sc);
                                if (e.key === "Escape") cancelInlineEdit();
                              }}
                            />
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveInlineEdit(sc)}
                            disabled={inlineSaving}
                            className="flex-1 rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
                          >
                            {inlineSaving ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={cancelInlineEdit}
                            disabled={inlineSaving}
                            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => editScene(sc)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-sm font-medium text-slate-100">{sc.name}</div>
                        <div className="font-mono text-xs text-slate-500">
                          {sc.start.toFixed(2)}–{sc.end.toFixed(2)}s ({(sc.end - sc.start).toFixed(2)}s)
                        </div>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() => startInlineEdit(sc)}
                          className="text-xs text-slate-500 hover:text-sky-300"
                          title="Rename / retime"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => removeScene(sc.id)}
                          className="text-xs text-slate-500 hover:text-red-400"
                          title="Delete"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    {sc.labels.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {sc.labels.map((l) => (
                          <span key={l} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                    {sc.notes && <p className="mt-1 text-xs text-slate-500">{sc.notes}</p>}
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => {
                          seek(sc.start);
                          setSelection({ start: sc.start, end: sc.end });
                        }}
                        className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => startInlineEdit(sc)}
                        className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() =>
                          setAnalyzeFor({ start: sc.start, end: sc.end, key: `${sc.id}-${Date.now()}` })
                        }
                        className="rounded border border-sky-700 px-2 py-1 text-xs text-sky-300 hover:bg-sky-900/40"
                      >
                        Run inference
                      </button>
                    </div>
                      </>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Btn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-sm text-slate-200 transition hover:bg-slate-800 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function round1(n: number): number {
  return Math.round(n * 100) / 100;
}
