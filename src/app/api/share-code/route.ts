import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { getDb, getShareCode, saveShareCode, findShareCodeByHash } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function generateCode(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) {
    code += alphabet[byte % alphabet.length];
  }
  return code;
}

function computeHash(payload: { targetVersion: string; loader: string; items: unknown[] }): string {
  const normalized = JSON.stringify({
    targetVersion: payload.targetVersion,
    loader: payload.loader,
    items: payload.items.map((item: any) => ({
      id: item.id,
      title: item.title,
      isDependency: item.isDependency,
      isSelected: item.isSelected,
      note: item.note ?? "",
      isCustom: Boolean(item.isCustom),
      customUrl: item.customUrl ?? "",
    })),
  });
  return createHash("sha256").update(normalized).digest("hex");
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code")?.toUpperCase();
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }
  
  const payload = getShareCode(code);
  if (!payload) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  
  return NextResponse.json(payload);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      code?: string;
      targetVersion: string;
      loader: string;
      items: unknown[];
    };
    if (!body || !body.items || !body.targetVersion || !body.loader) {
      return NextResponse.json(
        { error: "Missing payload" },
        { status: 400 }
      );
    }

    const contentHash = computeHash(body);
    const requestedCode = body.code?.toUpperCase();

    // 如果有現有代碼且內容完全相同，返回原代碼
    if (requestedCode) {
      const existing = getShareCode(requestedCode);
      if (existing && existing.contentHash === contentHash) {
        return NextResponse.json({ code: requestedCode, updated: false });
      }
    }

    // 查詢是否已有相同內容的代碼
    const existingCodeByHash = findShareCodeByHash(contentHash);
    if (existingCodeByHash) {
      return NextResponse.json({ code: existingCodeByHash, updated: false });
    }

    // 生成新代碼（內容改變或首次生成）
    let code = generateCode();
    let attempts = 0;
    while (getShareCode(code) && attempts < 100) {
      code = generateCode();
      attempts++;
    }

    if (attempts >= 100) {
      return NextResponse.json(
        { error: "Failed to generate unique code" },
        { status: 500 }
      );
    }

    saveShareCode(code, {
      targetVersion: body.targetVersion,
      loader: body.loader,
      items: body.items,
      contentHash,
      savedAt: new Date().toISOString(),
    });

    return NextResponse.json({ 
      code, 
      updated: requestedCode ? true : false 
    });
  } catch (error) {
    console.error("Share code POST error:", error);
    return NextResponse.json(
      { error: "Failed to save" },
      { status: 500 }
    );
  }
}
