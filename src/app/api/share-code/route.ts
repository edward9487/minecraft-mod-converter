import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StoredPayload = {
  targetVersion: string;
  loader: string;
  items: unknown[];
  savedAt: string;
  contentHash: string;
};

type Store = Record<string, StoredPayload>;

const storeFilePath = path.join(os.tmpdir(), "modlist-share-codes.json");

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(storeFilePath, "utf8");
    return JSON.parse(raw) as Store;
  } catch (error) {
    return {};
  }
}

async function writeStore(store: Store) {
  const payload = JSON.stringify(store, null, 2);
  await fs.writeFile(storeFilePath, payload, "utf8");
}

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
      note: typeof item.note === "string" ? item.note : "",
      isCustom: Boolean(item.isCustom),
      customUrl: typeof item.customUrl === "string" ? item.customUrl : "",
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
  const store = await readStore();
  const payload = store[code];
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
    const store = await readStore();
    const requestedCode = body.code?.toUpperCase();

    // 檢查現有代碼的內容是否改變
    if (requestedCode && store[requestedCode]) {
      if (store[requestedCode].contentHash === contentHash) {
        // 內容未改變，保持原代碼
        return NextResponse.json({ code: requestedCode, updated: false });
      } else {
        // 內容已改變，覆蓋該代碼
        store[requestedCode] = {
          targetVersion: body.targetVersion,
          loader: body.loader,
          items: body.items,
          contentHash,
          savedAt: new Date().toISOString(),
        };
        await writeStore(store);
        return NextResponse.json({ code: requestedCode, updated: true });
      }
    }

    // 查詢已有相同內容的代碼
    for (const [code, payload] of Object.entries(store)) {
      if (payload.contentHash === contentHash) {
        return NextResponse.json({ code, updated: false });
      }
    }

    // 生成新代碼
    let code = generateCode();
    while (store[code]) {
      code = generateCode();
    }

    store[code] = {
      targetVersion: body.targetVersion,
      loader: body.loader,
      items: body.items,
      contentHash,
      savedAt: new Date().toISOString(),
    };

    await writeStore(store);
    return NextResponse.json({ code, updated: false });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to save" },
      { status: 500 }
    );
  }
}
