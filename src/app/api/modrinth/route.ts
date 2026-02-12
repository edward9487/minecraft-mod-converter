import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_URL = "https://api.modrinth.com/v2";

// 缓存存储
const apiCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟
const LONG_TTL = 60 * 60 * 1000; // 1小时（给版本标签用）

// 生成缓存key
function generateCacheKey(
  type: string,
  query?: string,
  projectId?: string,
  gameVersion?: string,
  loader?: string
): string {
  switch (type) {
    case "game_versions":
    case "loaders":
      return `${type}`;
    case "search":
      return `search:${query}`;
    case "project":
      return `project:${projectId}`;
    case "versions":
      return `versions:${projectId}:${gameVersion || "all"}:${loader || "all"}`;
    default:
      return "";
  }
}

// 获取缓存数据
function getCachedData(cacheKey: string): unknown | null {
  const cached = apiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  // 清除过期缓存
  if (cached) {
    apiCache.delete(cacheKey);
  }
  return null;
}

// 获取长期缓存数据（给版本标签用）
function getCachedDataLong(cacheKey: string): unknown | null {
  const cached = apiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < LONG_TTL) {
    return cached.data;
  }
  if (cached) {
    apiCache.delete(cacheKey);
  }
  return null;
}

// 设置缓存数据
function setCachedData(cacheKey: string, data: unknown): void {
  apiCache.set(cacheKey, {
    data,
    timestamp: Date.now(),
  });
}

function buildVersionsUrl(
  projectId: string,
  gameVersion: string | null,
  loader: string | null
) {
  const params = new URLSearchParams();

  if (gameVersion) {
    params.set("game_versions", JSON.stringify([gameVersion]));
  }

  if (loader) {
    params.set("loaders", JSON.stringify([loader]));
  }

  const query = params.toString();
  return `${BASE_URL}/project/${projectId}/version${
    query ? `?${query}` : ""
  }`;
}

function buildSearchUrl(query: string, limit: number = 20) {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("limit", limit.toString());
  params.set("index", "relevance");
  return `${BASE_URL}/search?${params.toString()}`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const projectId = searchParams.get("projectId");
  const gameVersion = searchParams.get("gameVersion");
  const loader = searchParams.get("loader");
  const q = searchParams.get("q");

  // 生成缓存key
  const cacheKey = generateCacheKey(type || "", q || "", projectId || "", gameVersion || "", loader || "");

  // 对于版本标签，使用长期缓存
  const isLongCacheable = type === "game_versions" || type === "loaders";
  const cachedData = isLongCacheable ? getCachedDataLong(cacheKey) : getCachedData(cacheKey);
  
  if (cachedData) {
    return NextResponse.json(cachedData, {
      headers: {
        "X-Cache": "HIT",
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  }

  let url: string | null = null;

  if (type === "game_versions") {
    url = `${BASE_URL}/tag/game_version`;
  }

  if (type === "loaders") {
    url = `${BASE_URL}/tag/loader`;
  }

  if (type === "search") {
    if (q) url = buildSearchUrl(q);
  }

  if (type === "project") {
    if (!projectId) {
      return NextResponse.json(
        { error: "Missing projectId" },
        { status: 400 }
      );
    }
    url = `${BASE_URL}/project/${projectId}`;
  }

  if (type === "versions") {
    if (!projectId) {
      return NextResponse.json(
        { error: "Missing projectId" },
        { status: 400 }
      );
    }
    url = buildVersionsUrl(projectId, gameVersion, loader);
  }

  if (!url) {
    return NextResponse.json(
      { error: "Invalid type." },
      { status: 400 }
    );
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "modlist-converter/1.0",
      },
      next: { revalidate: 3600 },
    });

    const data = await upstream.json();

    // 缓存成功的数据
    if (upstream.ok) {
      setCachedData(cacheKey, data);
    }

    return NextResponse.json(data, {
      status: upstream.status,
      headers: {
        "X-Cache": "MISS",
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Upstream request failed." },
      { status: 502 }
    );
  }
}
