"use client";

import type { ModelInfo } from "@/lib/api";

type Props = {
  model: ModelInfo | undefined;
};

function fmtCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k (${n.toLocaleString()})` : n.toLocaleString();
}

export default function ModelDetails({ model }: Props) {
  if (!model?.summary && !model?.architecture && !model?.dataset) {
    return null;
  }

  const rows: Array<{ label: string; value: string }> = [];
  if (model.architecture) rows.push({ label: "Architecture", value: model.architecture });
  if (model.imgsz != null) rows.push({ label: "Input size", value: `${model.imgsz}px` });
  if (model.dataset) rows.push({ label: "Dataset", value: model.dataset });
  if (model.train_images != null) {
    rows.push({ label: "Train images", value: fmtCount(model.train_images) });
  }
  if (model.total_images != null && model.total_images !== model.train_images) {
    rows.push({ label: "Total images", value: fmtCount(model.total_images) });
  }
  if (model.epochs) rows.push({ label: "Epochs", value: model.epochs });
  if (model.run_name) rows.push({ label: "Run", value: model.run_name });
  if (model.filename) rows.push({ label: "Weights", value: model.filename });

  return (
    <div className="mt-2 rounded-lg border border-slate-800/80 bg-slate-950/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
      {model.summary && <p className="mb-1.5 text-slate-300">{model.summary}</p>}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(({ label, value }) => (
            <div key={label} className="contents">
              <dt className="text-slate-500">{label}</dt>
              <dd className="font-mono text-slate-300">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {model.notes && <p className="mt-1.5 text-slate-500">{model.notes}</p>}
    </div>
  );
}
