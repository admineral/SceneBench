import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Only available during local development." }, { status: 404 });
  }

  const body = (await req.json()) as unknown;
  const history = isRecord(body) ? body.history : null;

  if (!Array.isArray(history)) {
    return NextResponse.json({ error: "Expected { history: [...] }." }, { status: 400 });
  }

  const filePath = join(process.cwd(), "public", "demo-runs", "history.json");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(history, null, 2)}\n`, "utf8");

  return NextResponse.json({ ok: true, count: history.length, path: "public/demo-runs/history.json" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
