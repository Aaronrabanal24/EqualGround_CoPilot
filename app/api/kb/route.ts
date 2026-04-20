import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

export async function GET() {
  const kb: Record<string, unknown> = {};
  const files = ["battlecards", "call_stages", "objections", "personas", "product"];

  for (const f of files) {
    const filePath = path.join(process.cwd(), "knowledge", `${f}.json`);
    kb[f] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  return NextResponse.json(kb);
}
