"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";

type StatusTone = "success" | "accent" | "warning" | "danger";

type DependencyItem = {
  id: string;
  title: string;
  iconUrl?: string;
};

type CartItem = {
  id: string;
  title: string;
  source: string;
  currentVersion: string;
  targetVersion: string;
  status: string;
  statusTone: StatusTone;
  paused: boolean;
  lastSupportedVersion?: string;
  downloaded?: boolean;
  filename?: string;
  iconUrl?: string;
  dependencies?: DependencyItem[];
  isDependency?: boolean;
  isSelected?: boolean;
  note?: string;
  isCustom?: boolean;
  customUrl?: string;
};

type GameVersionTag = {
  version: string;
  date: string;
};

type LoaderTag = {
  loader: string;
};

type ProjectInfo = {
  title?: string;
  game_versions?: string[];
  icon_url?: string;
};

type VersionInfo = {
  id: string;
  game_versions?: string[];
  date_published?: string;
  files?: { url: string; primary?: boolean; filename?: string }[];
  dependencies?: { project_id?: string; dependency_type?: string }[];
};

type SearchResult = {
  hits: Array<{
    project_id: string;
    title: string;
    slug: string;
    icon_url?: string;
  }>;
};

const initialItems: CartItem[] = [];

const fallbackVersions = [
  "26.1",
  "1.21.1",
  "1.21",
  "1.20.6",
  "1.20.4",
  "1.20.2",
  "1.20.1",
  "1.19.4",
  "1.19.2",
  "1.18.2",
  "1.17.1",
  "1.16.5",
  "1.12.2",
];

const fallbackLoaders = ["Fabric", "NeoForge", "Forge", "Quilt"];

const latestOverrideVersion = "26.1";

const loaderLabelMap: Record<string, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  quilt: "Quilt",
  rift: "Rift",
  asm: "Asm",
};

function parseModrinthSlug(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/modrinth\.com\/mod\/([\w-]+)/i);
  return match ? match[1] : trimmed;
}

function toLoaderId(label: string) {
  const lower = label.toLowerCase();
  return lower === "neoforge" ? "neoforge" : lower;
}

function dedupe(list: string[]) {
  return Array.from(new Set(list));
}

function normalizeDependencies(value: unknown): DependencyItem[] {
  if (!Array.isArray(value)) return [];
  if (value.length === 0) return [];
  if (typeof value[0] === "string") {
    return (value as string[]).map((item) => ({ id: item, title: item }));
  }
  return (value as DependencyItem[]).filter(
    (item) => item && typeof item.id === "string"
  );
}

function generateLocalId() {
  return `custom-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function computeContentHash(
  targetVersion: string,
  loader: string,
  items: CartItem[],
  selectedMods: Set<string>
): Promise<string> {
  const normalized = JSON.stringify({
    targetVersion,
    loader,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      isDependency: item.isDependency,
      isSelected: selectedMods.has(item.id),
      note: typeof item.note === "string" ? item.note : "",
      isCustom: Boolean(item.isCustom),
      customUrl: typeof item.customUrl === "string" ? item.customUrl : "",
    })),
  });
  
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function compareVersions(a: string, b: string) {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isVersionAtLeast(version: string, minimum: string) {
  return compareVersions(version, minimum) >= 0;
}

function filterVersions(versions: string[]): string[] {
  // 只保留正式版本（主版本号.子版本号或主版本号.子版本號.修復版本號）
  return versions.filter((v) => {
    const lower = v.toLowerCase();
    // 排除特殊版本
    if (
      lower.includes("-snapshot") ||
      lower.includes("-w") ||
      lower.match(/^\d+w\d+[a-z]?$/) ||     // 週測版本 (23w13a 等)
      lower.includes("-pre") ||
      lower.includes("-rc") ||
      lower.includes("-alpha") ||
      lower.includes("-beta") ||
      lower.includes("-release") ||
      lower.match(/\//) ||                    // 包含斜杠
      v.trim() === ""
    ) {
      return false;
    }
    // 只保留標準版本號格式 (1.x, 1.x.x 等)
    const trimmed = v.trim();
    if (!/^\d+\.\d+(\.\d+)?$/.test(trimmed)) return false;
    return isVersionAtLeast(trimmed, "1.2.5");
  }).sort((a, b) => {
    // 按版本號從大到小排序
    return compareVersions(b, a);
  });
}

function getLatestSupportedVersion(versions: VersionInfo[]) {
  if (!versions.length) return undefined;
  const sorted = [...versions].sort((a, b) =>
    (b.date_published ?? "").localeCompare(a.date_published ?? "")
  );
  const latest = sorted[0] ?? versions[0];
  return latest.game_versions?.[0];
}

function isModrinthUrl(input: string): boolean {
  return /modrinth\.com\/mod/i.test(input);
}

function isShareCode(input: string): boolean {
  return /^[A-Z0-9]{6,10}$/.test(input.trim().toUpperCase());
}

function extractShareCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("s") ?? url.searchParams.get("code");
    return code ? code.trim().toUpperCase() : null;
  } catch (error) {
    return null;
  }
}

async function fetchProjectInfoById(id: string) {
  try {
    const response = await fetch(
      `/api/modrinth?type=project&projectId=${encodeURIComponent(id)}`
    );
    if (!response.ok) return {};
    const data = (await response.json()) as ProjectInfo;
    return {
      title: data.title,
      iconUrl: data.icon_url,
      currentVersion: data.game_versions?.[0],
    };
  } catch (error) {
    return {};
  }
}

async function resolveDependencyTitles(
  deps: { project_id?: string; dependency_type?: string }[] | undefined
) {
  if (!deps || deps.length === 0) return [];
  const requiredIds = dedupe(
    deps
      .filter((dep) => dep.dependency_type === "required" && dep.project_id)
      .map((dep) => dep.project_id as string)
  );
  if (!requiredIds.length) return [];
  const items = await Promise.all(
    requiredIds.map(async (id) => {
      try {
        const response = await fetch(
          `/api/modrinth?type=project&projectId=${encodeURIComponent(id)}`
        );
        if (!response.ok) return { id, title: id, iconUrl: undefined };
        const data = (await response.json()) as ProjectInfo;
        return {
          id,
          title: data.title ?? id,
          iconUrl: data.icon_url,
        };
      } catch (error) {
        return { id, title: id, iconUrl: undefined };
      }
    })
  );
  return items;
}

export default function Home() {
  const [cartItems, setCartItems] = useState<CartItem[]>(initialItems);
  const [targetVersion, setTargetVersion] = useState("1.21.1");
  const [loader, setLoader] = useState("Fabric");
  const [inputUrl, setInputUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [availableVersions, setAvailableVersions] = useState(fallbackVersions);
  const [availableLoaders, setAvailableLoaders] = useState(fallbackLoaders);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult["hits"]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [versionCache, setVersionCache] = useState<Record<string, string>>({});
  const isTargetLockedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set());
  const [unifiedInput, setUnifiedInput] = useState("");
  const [modalType, setModalType] = useState<"confirm" | "success" | null>(null);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalData, setModalData] = useState<{ code?: string; count?: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<string>("");
  const [currentShareCode, setCurrentShareCode] = useState<string | null>(null);
  const [currentShareCodeHash, setCurrentShareCodeHash] = useState<string | null>(null);

  const statusStyles: Record<StatusTone, string> = {
    success: "bg-emerald-100 text-emerald-800 border-emerald-200",
    accent: "bg-orange-100 text-orange-800 border-orange-200",
    warning: "bg-amber-100 text-amber-800 border-amber-200",
    danger: "bg-rose-100 text-rose-800 border-rose-200",
  };

  const stats = useMemo(() => {
    const result = { success: 0, warning: 0, danger: 0 };
    cartItems.forEach((item) => {
      if (item.paused) return;
      if (item.statusTone === "success") result.success += 1;
      if (item.statusTone === "warning") result.warning += 1;
      if (item.statusTone === "danger") result.danger += 1;
    });
    return result;
  }, [cartItems]);

  const resolvedCount = useMemo(() => {
    return cartItems.filter(
      (item) =>
        !item.paused && item.status !== "待解析" && item.status !== "暫停"
    ).length;
  }, [cartItems]);

  const visibleItems = useMemo(() => {
    return showActiveOnly
      ? cartItems.filter((item) => !item.paused)
      : cartItems;
  }, [cartItems, showActiveOnly]);

  const activeCount = useMemo(() => {
    return cartItems.filter((item) => !item.paused).length;
  }, [cartItems]);

  useEffect(() => {
    const loadMetadata = async () => {
      try {
        setIsLoadingVersions(true);
        const [versionsResponse, loadersResponse] = await Promise.all([
          fetch("/api/modrinth?type=game_versions"),
          fetch("/api/modrinth?type=loaders"),
        ]);

        if (versionsResponse.ok) {
          const data = (await versionsResponse.json()) as GameVersionTag[];
          const sorted = [...data].sort((a, b) =>
            b.date.localeCompare(a.date)
          );
          const versions = filterVersions(dedupe(sorted.map((item) => item.version)));
          if (!versions.includes(latestOverrideVersion)) {
            versions.push(latestOverrideVersion);
            versions.sort((a, b) => compareVersions(b, a));
          }
          if (versions.length) {
            setAvailableVersions(versions);
            if (!isTargetLockedRef.current) {
              setTargetVersion((current) => versions[0] ?? current);
            }
          }
        }

        if (loadersResponse.ok) {
          const data = (await loadersResponse.json()) as LoaderTag[];
          const mapped = data
            .map((item) => loaderLabelMap[item.loader])
            .filter(Boolean);
          const labels = mapped.length ? dedupe(mapped) : fallbackLoaders;
          setAvailableLoaders(labels);
          setLoader((current) => (labels.includes(current) ? current : labels[0]));
        }
      } catch (error) {
        setNotice("無法載入版本清單，已改用內建版本列表。");
        setAvailableVersions(fallbackVersions);
      } finally {
        setIsLoadingVersions(false);
      }
    };

    loadMetadata();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const shareParam = params.get("s") ?? params.get("code");
    const modsParam = params.get("mods");
    const targetParam = params.get("target");
    const loaderParam = params.get("loader");
    const inferredTarget = targetParam ?? targetVersion;

    if (shareParam) {
      handleLoadByCode(shareParam.toUpperCase());
      return;
    }

    if (targetParam) {
      setTargetVersion(targetParam);
      isTargetLockedRef.current = true;
    }
    if (loaderParam) {
      const label = loaderLabelMap[loaderParam] ?? loaderParam;
      setLoader(label);
    }

    if (modsParam) {
      const mods = modsParam.split(",").map((item) => item.trim());
      const newItems = mods
        .filter(Boolean)
        .map((id) => ({
          id,
          title: id,
          source: "Modrinth",
          currentVersion: "未知",
          targetVersion: inferredTarget,
          status: "待解析",
          statusTone: "accent" as StatusTone,
          paused: false,
          downloaded: false,
          isDependency: false,
          note: "",
          isCustom: false,
          customUrl: "",
        }));
      if (newItems.length) {
        setCartItems(newItems);
        setNotice("已從分享連結載入清單。");
      }
    }
  }, []);

  const handleAddItem = async () => {
    let urlInput = inputUrl;
    if (!urlInput) urlInput = unifiedInput;
    const slug = parseModrinthSlug(urlInput);
    if (!slug) {
      setNotice("請先輸入 Modrinth 專案網址或 ID。");
      return;
    }

    const exists = cartItems.some((item) => item.id === slug);
    if (exists) {
      setNotice("此模組已在清單中。");
      return;
    }

    setIsAdding(true);
    try {
      let title = slug.charAt(0).toUpperCase() + slug.slice(1);
      let currentVersion = "未知";
      let iconUrl: string | undefined = undefined;
      const projectInfo = await fetchProjectInfoById(slug);
      if (projectInfo.title) title = projectInfo.title;
      if (projectInfo.currentVersion) currentVersion = projectInfo.currentVersion;
      iconUrl = projectInfo.iconUrl;

      setCartItems((items) => [
        {
          id: slug,
          title,
          source: "Modrinth",
          currentVersion,
          targetVersion,
          status: "待解析",
          statusTone: "accent" as StatusTone,
          paused: false,
          downloaded: false,
          filename: undefined,
          iconUrl,
          dependencies: [],
          isDependency: false,
          note: "",
          isCustom: false,
          customUrl: "",
        },
        ...items,
      ]);
      setInputUrl("");
      setNotice(`已加入 ${title}，等待解析。`);
    } catch (error) {
      setNotice("加入失敗，請稍後再試。");
    } finally {
      setIsAdding(false);
    }
  };

  const handleAddCustomItem = () => {
    const id = generateLocalId();
    setCartItems((items) => [
      {
        id,
        title: "自訂模組",
        source: "自訂",
        currentVersion: "-",
        targetVersion,
        status: "自訂",
        statusTone: "accent" as StatusTone,
        paused: false,
        downloaded: false,
        filename: undefined,
        iconUrl: undefined,
        dependencies: [],
        isDependency: false,
        note: "",
        isCustom: true,
        customUrl: "",
      },
      ...items,
    ]);
    setNotice("已新增自訂模組，可編輯名稱與連結。");
  };

  const resolveItem = async (item: CartItem): Promise<CartItem> => {
    if (item.paused) return item;
    if (item.isCustom || item.source === "自訂") {
      return {
        ...item,
        status: "自訂",
        statusTone: "accent" as StatusTone,
        targetVersion: "-",
        currentVersion: "-",
        filename: undefined,
      };
    }

    const projectInfo = await fetchProjectInfoById(item.id);
    const baseItem = {
      ...item,
      title: projectInfo.title ?? item.title,
      iconUrl: projectInfo.iconUrl ?? item.iconUrl,
      currentVersion:
        item.currentVersion === "未知"
          ? projectInfo.currentVersion ?? item.currentVersion
          : item.currentVersion,
    };

    const loaderId = toLoaderId(loader);
    const response = await fetch(
      `/api/modrinth?type=versions&projectId=${encodeURIComponent(
        item.id
      )}&gameVersion=${encodeURIComponent(
        targetVersion
      )}&loader=${encodeURIComponent(loaderId)}`
    );

    if (response.ok) {
      const versions = (await response.json()) as VersionInfo[];
      if (versions.length) {
        const filename = versions[0].files?.[0]?.filename;
        const dependencies = await resolveDependencyTitles(
          versions[0].dependencies
        );
        return {
          ...baseItem,
          targetVersion,
          status: "可更新",
          statusTone: "success" as StatusTone,
          lastSupportedVersion: undefined,
          filename,
          dependencies,
        };
      }
    }

    const fallbackResponse = await fetch(
      `/api/modrinth?type=versions&projectId=${encodeURIComponent(item.id)}`
    );
    if (fallbackResponse.ok) {
      const versions = (await fallbackResponse.json()) as VersionInfo[];
      const lastSupported = getLatestSupportedVersion(versions);
      return {
        ...baseItem,
        targetVersion: "-",
        status: "缺失",
        statusTone: "warning" as StatusTone,
        lastSupportedVersion: lastSupported,
        filename: undefined,
      };
    }

    return {
      ...baseItem,
      targetVersion: "-",
      status: "缺失",
      statusTone: "warning" as StatusTone,
      filename: undefined,
    };
  };

  const runPool = async <T,>(
    list: T[],
    limit: number,
    worker: (value: T) => Promise<T>
  ) => {
    const results: T[] = new Array(list.length);
    const queue = list.map((value, index) => ({ value, index }));
    const runners = Array.from({ length: limit }, async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) return;
        const resolved = await worker(next.value);
        results[next.index] = resolved;
      }
    });
    await Promise.all(runners);
    return results;
  };

  const handleResolve = async () => {
    if (!cartItems.length) {
      setNotice("目前沒有要解析的清單項目。");
      return;
    }
    setIsResolving(true);
    setNotice("解析中，請稍候...");

    try {
      const resolved = await runPool(cartItems, 10, resolveItem);
      const existingIds = new Set(cartItems.map((item) => item.id));
      const dependencyItems: CartItem[] = [];
      const dependencyIds = new Set<string>();
      const dependencySelectionMap = new Map<string, boolean>();

      resolved.forEach((item) => {
        item.dependencies?.forEach((dep) => {
          if (existingIds.has(dep.id) || dependencyIds.has(dep.id)) return;
          
          const isCurrentSelected = selectedMods.has(item.id);
          if (dependencySelectionMap.has(dep.id)) {
            dependencySelectionMap.set(dep.id, dependencySelectionMap.get(dep.id) || isCurrentSelected);
          } else {
            dependencySelectionMap.set(dep.id, isCurrentSelected);
          }
          
          dependencyIds.add(dep.id);
          dependencyItems.push({
            id: dep.id,
            title: dep.title,
            source: "Modrinth",
            currentVersion: "未知",
            targetVersion,
            status: "待解析",
            statusTone: "accent" as StatusTone,
            paused: false,
            downloaded: false,
            filename: undefined,
            iconUrl: dep.iconUrl,
            dependencies: [],
            isDependency: true,
            note: "",
            isCustom: false,
            customUrl: "",
          });
        });
      });

      if (dependencyItems.length) {
        const resolvedDeps = await runPool(dependencyItems, 10, resolveItem);
        const resetItems = [...resolved, ...resolvedDeps].map(item => ({
          ...item,
          downloaded: false,
        }));
        setCartItems(resetItems);
        
        const updatedSelectedMods = new Set(selectedMods);
        dependencySelectionMap.forEach((shouldSelect, depId) => {
          if (shouldSelect) {
            updatedSelectedMods.add(depId);
          }
        });
        setSelectedMods(updatedSelectedMods);
        
        setNotice(
          `完成解析，${targetVersion}（${loader}），已加入 ${dependencyItems.length} 個前置模組。`
        );
      } else {
        const resetItems = resolved.map(item => ({
          ...item,
          downloaded: false,
        }));
        setCartItems(resetItems);
        setNotice(`完成解析，${targetVersion}（${loader}）。`);
      }
    } catch (error) {
      setNotice("解析失敗，請稍後再試。");
    } finally {
      setIsResolving(false);
    }
  };

  const handleGenerateCode = async () => {
    if (!cartItems.length) {
      setNotice("目前沒有可生成代碼的清單。");
      return;
    }
    const selectedCount = selectedMods.size;
    const message = currentShareCode
      ? `確認要覆蓋目前的分享連結嗎？清單包含 ${cartItems.length} 筆模組，其中 ${selectedCount} 筆已勾選。`
      : `確認要建立分享連結嗎？清單包含 ${cartItems.length} 筆模組，其中 ${selectedCount} 筆已勾選。`;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(message);
      if (!confirmed) return;
    }
    executeGenerateCode();
  };

  const executeGenerateCode = async () => {
    setIsGeneratingCode(true);
    try {
      const loaderId = toLoaderId(loader);
    const currentHash = await computeContentHash(targetVersion, loaderId, cartItems, selectedMods);
      
    if (currentShareCode && currentShareCodeHash === currentHash) {
      const shareLink = `${window.location.origin}/?s=${encodeURIComponent(currentShareCode)}`;
      setNotice(`無異動，保持現有分享連結：${shareLink}`);
      setIsGeneratingCode(false);
      return;
    }
      
      const payload = {
        code: currentShareCode ?? undefined,
        targetVersion,
        loader: toLoaderId(loader),
        items: cartItems.map((item) => ({
          id: item.id,
          title: item.title,
          source: item.source,
          currentVersion: item.currentVersion,
          targetVersion: item.targetVersion,
          status: item.status,
          statusTone: item.statusTone,
          paused: item.paused,
          lastSupportedVersion: item.lastSupportedVersion,
          filename: item.filename,
          iconUrl: item.iconUrl,
          dependencies: item.dependencies,
          isDependency: item.isDependency,
          isSelected: selectedMods.has(item.id),
          note: item.note ?? "",
          isCustom: item.isCustom ?? false,
          customUrl: item.customUrl ?? "",
        })),
      };

      const response = await fetch("/api/share-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let detail = "";
        try {
          const errorData = (await response.json()) as { error?: string };
          detail = errorData.error ?? "";
        } catch (error) {
          try {
            detail = (await response.text()).trim();
          } catch (innerError) {
            detail = "";
          }
        }
        setNotice(
          detail
            ? `代碼生成失敗：${detail}`
            : "代碼生成失敗，請稍後再試。"
        );
        return;
      }

      const data = (await response.json()) as { code?: string; updated?: boolean };
      if (data.code) {
        const wasUpdated = Boolean(data.updated);
        setCurrentShareCode(data.code);
        setCurrentShareCodeHash(currentHash);
        const shareLink = typeof window !== "undefined"
          ? `${window.location.origin}/?s=${encodeURIComponent(data.code)}`
          : data.code;
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `/?s=${encodeURIComponent(data.code)}`);
        }
        try {
          await navigator.clipboard.writeText(shareLink);
          if (typeof window !== "undefined") {
            window.alert(`已經複製${shareLink}到剪貼簿`);
          }
          setNotice(
            wasUpdated
              ? `已更新分享連結並複製：${shareLink}`
              : `已建立分享連結並複製：${shareLink}`
          );
        } catch (error) {
          if (typeof window !== "undefined") {
            window.alert("複製失敗，請手動複製提示訊息中的連結。");
          }
          setNotice(
            wasUpdated
              ? `已更新分享連結：${shareLink}`
              : `已建立分享連結：${shareLink}`
          );
        }
      } else {
        setNotice("代碼生成失敗：未回傳分享代碼。");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知錯誤";
      console.error("share-code failed", error);
      setNotice(`代碼生成失敗：${message}`);
    } finally {
      setIsGeneratingCode(false);
    }
  };

  const handleLoadByCode = async (code: string) => {
    try {
      const response = await fetch(
        `/api/share-code?code=${encodeURIComponent(code)}`
      );
      if (!response.ok) {
        setNotice("找不到對應的清單代碼。");
        return;
      }
      const data = (await response.json()) as {
        targetVersion?: string;
        loader?: string;
        platform?: string;
        items?: CartItem[];
      };
      if (!data.items || !data.items.length) {
        setNotice("此代碼沒有可用的清單。");
        return;
      }
      const normalized = data.items.map((item) => ({
        ...item,
        dependencies: normalizeDependencies(item.dependencies),
        isDependency: item.isDependency ?? false,
        isSelected: item.isSelected ?? false,
        note: typeof item.note === "string" ? item.note : "",
        isCustom: Boolean(item.isCustom),
        customUrl: typeof item.customUrl === "string" ? item.customUrl : "",
      }));
      if (data.targetVersion) setTargetVersion(data.targetVersion);
      if (data.loader) {
        const label = loaderLabelMap[data.loader] ?? data.loader;
        setLoader(label);
      }
      setCartItems(normalized);
      const selectedIds = normalized
        .filter((item) => item.isSelected)
        .map((item) => item.id);
      setSelectedMods(new Set(selectedIds));
      setCurrentShareCode(code.toUpperCase());
      
      const loaderId = data.loader || toLoaderId(loader);
      const codeHash = await computeContentHash(
        data.targetVersion || targetVersion,
        loaderId,
        normalized,
        new Set(selectedIds)
      );
      setCurrentShareCodeHash(codeHash);
      
      setShowSearch(false);
      setNotice(`已載入代碼清單，共 ${normalized.length} 筆。`);
    } catch (error) {
      setNotice("代碼載入失敗，請稍後再試。");
    }
  };

  const handleOpenProject = (item: CartItem) => {
    const url = item.isCustom
      ? item.customUrl?.trim()
      : `https://modrinth.com/mod/${encodeURIComponent(item.id)}`;
    if (!url) {
      setNotice("此自訂模組尚未填寫連結。");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleDownload = async (item: CartItem) => {
    if (item.status !== "可更新" && !item.downloaded) {
      if (item.paused) {
        setNotice(`❌ 無法下載 ${item.title}：此模組已暫停，請先恢復。`);
      } else if (item.status === "缺失") {
        setNotice(`❌ 無法下載 ${item.title}：此版本沒有可用版本，請檢查目標版本或 Loader。`);
      } else {
        setNotice(`❌ 無法下載 ${item.title}：${item.status}狀態的模組無法下載。`);
      }
      return;
    }
    if (item.paused) {
      setNotice(`❌ 無法下載 ${item.title}：此模組目前已暫停，請先恢復再下載。`);
      return;
    }
    const confirmed = typeof window !== "undefined" && window.confirm(`確認要下載 ${item.title} 嗎？`);
    if (!confirmed) return;
    setDownloadingId(item.id);
    try {
      const loaderId = toLoaderId(loader);
      const response = await fetch(
        `/api/modrinth?type=versions&projectId=${encodeURIComponent(
          item.id
        )}&gameVersion=${encodeURIComponent(
          targetVersion
        )}&loader=${encodeURIComponent(loaderId)}`
      );

      if (!response.ok) {
        setNotice(`❌ 下載 ${item.title} 失敗：無法連接 API，請檢查網路連線。`);
        setDownloadingId(null);
        return;
      }

      const versions = (await response.json()) as VersionInfo[];
      if (!versions.length) {
        setNotice(`❌ 下載 ${item.title} 失敗：此版本沒有可用的檔案。`);
        setDownloadingId(null);
        return;
      }

      const file =
        versions[0].files?.find((entry) => entry.primary) ??
        versions[0].files?.[0];

      if (!file?.url) {
        setNotice(`❌ 下載 ${item.title} 失敗：找不到檔案連結，請稍後再試。`);
        setDownloadingId(null);
        return;
      }

      const link = document.createElement("a");
      link.href = file.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (file.filename) {
        link.download = file.filename;
      }
      document.body.appendChild(link);
      link.click();
      link.remove();

      setCartItems((items) =>
        items.map((entry) =>
          entry.id === item.id ? { ...entry, downloaded: true } : entry
        )
      );
      setNotice(`✓ 已開始下載 ${item.title}（${file.filename ?? "檔案"}）。`);
    } catch (error) {
      setNotice(`❌ 下載 ${item.title} 失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleUnifiedInput = async (value: string) => {
    setUnifiedInput(value);
    clearTimeout(searchTimeoutRef.current);

    if (!value.trim()) {
      setSearchResults([]);
      setSearchQuery("");
      return;
    }

    // 如果是連結，直接新增
    if (isModrinthUrl(value)) {
      setSearchResults([]);
      setSearchQuery("");
      setShowSearch(false);
      return;
    }

    // 否則作為搜尋
    setShowSearch(true);
    setSearchQuery(value);
    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await fetch(
          `/api/modrinth?type=search&q=${encodeURIComponent(value)}`
        );
        if (response.ok) {
          const data = (await response.json()) as SearchResult;
          setSearchResults(data.hits || []);
        }
      } catch (error) {
        setNotice("搜尋失敗，請稍後再試。");
      } finally {
        setIsSearching(false);
      }
    }, 300);
  };

  const handleUnifiedInputSubmit = () => {
    const trimmed = unifiedInput.trim();
    if (!trimmed) return;

    const shareCodeFromLink = extractShareCode(trimmed);
    if (shareCodeFromLink && isShareCode(shareCodeFromLink)) {
      handleLoadByCode(shareCodeFromLink);
      setUnifiedInput("");
      return;
    }

    if (isModrinthUrl(trimmed)) {
      setInputUrl(trimmed);
      handleAddItem();
      setUnifiedInput("");
      return;
    }

    if (isShareCode(trimmed)) {
      handleLoadByCode(trimmed.toUpperCase());
      setUnifiedInput("");
      return;
    }

    setNotice("請從搜尋結果點選模組，或輸入分享代碼/連結再按新增。");
  };

  const handleSelectSearchResult = async (result: SearchResult["hits"][0]) => {
    const exists = cartItems.some((item) => item.id === result.slug);
    if (exists) {
      setNotice("此模組已在清單中。");
      return;
    }

    setCartItems((items) => [
      {
        id: result.slug,
        title: result.title,
        source: "Modrinth",
        currentVersion: "未知",
        targetVersion,
        status: "待解析",
        statusTone: "accent" as StatusTone,
        paused: false,
        downloaded: false,
        filename: undefined,
        iconUrl: result.icon_url,
        dependencies: [],
        isDependency: false,
        note: "",
        isCustom: false,
        customUrl: "",
      },
      ...items,
    ]);
    setSearchQuery("");
    setSearchResults([]);
    setShowSearch(false);
    setNotice(`已加入 ${result.title}，等待解析。`);
  };

  const handleToggleSelection = (id: string) => {
    setSelectedMods((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDownloadSelected = () => {
    const selected = cartItems.filter(
      (item) => selectedMods.has(item.id)
    );
    if (!selected.length) {
      setNotice("目前沒有已勾選的模組可下載。");
      return;
    }

    const confirmed = typeof window !== "undefined" && window.confirm(`確認要下載 ${selected.length} 筆模組清單嗎？`);
    if (!confirmed) return;

    const filenames = selected.map((item) => 
      item.filename ?? `${item.title}(該版本缺失)`
    );
    const blob = new Blob([JSON.stringify(filenames, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `modlist-${targetVersion}-${toLoaderId(loader)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNotice("已下載選中模組清單。");
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      const parsed = JSON.parse(content) as { items?: CartItem[] } | CartItem[];
      const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
      const normalized = items.map((item) => ({
        id: item.id,
        title: item.title ?? item.id,
        source: item.source ?? "Modrinth",
        currentVersion: item.currentVersion ?? "未知",
        targetVersion: item.targetVersion ?? targetVersion,
        status: item.status ?? "待解析",
        statusTone: (item.statusTone ?? "accent") as StatusTone,
        paused: item.paused ?? false,
        lastSupportedVersion: item.lastSupportedVersion,
        downloaded: item.downloaded ?? false,
        filename: item.filename,
        iconUrl: item.iconUrl,
        dependencies: normalizeDependencies(item.dependencies),
        isDependency: item.isDependency ?? false,
        note: typeof item.note === "string" ? item.note : "",
        isCustom: Boolean(item.isCustom),
        customUrl: typeof item.customUrl === "string" ? item.customUrl : "",
      }));
      setCartItems(normalized);
      setNotice(`已匯入 ${normalized.length} 筆清單。`);
    } catch (error) {
      setNotice("匯入失敗，請確認檔案格式。");
    } finally {
      event.target.value = "";
    }
  };

  const handleRemove = (id: string) => {
    setCartItems((items) => items.filter((item) => item.id !== id));
    setNotice("已移除清單項目。");
  };

  const handleTogglePause = (id: string) => {
    setCartItems((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              paused: !item.paused,
              status: item.paused ? "待解析" : "暫停",
              statusTone: "accent",
            }
          : item
      )
    );
  };

  const handleNoteChange = (id: string, value: string) => {
    setCartItems((items) =>
      items.map((item) =>
        item.id === id ? { ...item, note: value } : item
      )
    );
  };

  const handleCustomTitleChange = (id: string, value: string) => {
    setCartItems((items) =>
      items.map((item) =>
        item.id === id ? { ...item, title: value } : item
      )
    );
  };

  const handleCustomUrlChange = (id: string, value: string) => {
    setCartItems((items) =>
      items.map((item) =>
        item.id === id ? { ...item, customUrl: value } : item
      )
    );
  };

  return (
    <div className="min-h-screen pb-24 text-[15px] text-[color:var(--ink)]">
      <header className="mx-auto max-w-6xl px-6 pt-16">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-4">
            <span className="inline-flex items-center gap-2 rounded-full border border-[color:var(--line)] bg-white/80 px-4 py-1 text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
              高效清單工具
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--accent)] animate-glow" />
            </span>
            <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--ink)] md:text-5xl">
              Minecraft 模組跨版本清單轉換器
            </h1>
            <p className="max-w-2xl text-base leading-7 text-[color:var(--muted)] md:text-lg">
              以購物車方式整理模組專案，快速解析目標版本與 Loader，完成依賴補完與
              清單下載。
            </p>
          </div>
          <div className="grid w-full gap-4 rounded-3xl border border-[color:var(--line)] bg-white/80 p-5 shadow-ember lg:max-w-sm">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[color:var(--muted)]">
                目標環境
              </span>
              <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-800">
                Beta
              </span>
            </div>
            <div className="grid gap-3">
              <label className="text-xs text-[color:var(--muted)]">
                遊戲版本
              </label>
              <select
                className="h-11 rounded-xl border border-[color:var(--line)] bg-white px-4 text-sm"
                value={targetVersion}
                onChange={(event) => setTargetVersion(event.target.value)}
                disabled={isLoadingVersions}
              >
                {isLoadingVersions ? (
                  <option>載入版本中...</option>
                ) : (
                  availableVersions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="grid gap-3">
              <label className="text-xs text-[color:var(--muted)]">
                Loader
              </label>
              <div className="grid grid-cols-3 gap-2 text-sm">
                {availableLoaders.map((item) => (
                  <button
                    key={item}
                    className={`h-10 rounded-xl border px-2 font-medium transition ${
                      loader === item
                        ? "border-orange-200 bg-orange-50 text-orange-800"
                        : "border-[color:var(--line)] text-[color:var(--muted)] hover:border-orange-200 hover:text-orange-700"
                    }`}
                    type="button"
                    onClick={() => setLoader(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        {notice ? (
          <div className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
            {notice}
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-14 grid max-w-6xl gap-6 px-6 lg:grid-cols-[1.35fr_0.65fr]">
        <section className="space-y-6">
          <div className="relative z-30 grid gap-6 rounded-3xl border border-[color:var(--line)] bg-white/90 p-6 shadow-ember animate-fade-up">
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-semibold">模組清單輸入</h2>
              <p className="text-sm text-[color:var(--muted)]">
                搜尋 Modrinth 模組或上傳清單匯入，僅收集 Project ID。
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.6fr_0.4fr] overflow-visible">
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-3">
                  <label className="text-xs text-[color:var(--muted)]">
                    搜尋或貼上連結
                  </label>
                  <div className="relative z-20">
                    <div className="flex gap-2">
                      <input
                        className="flex-1 h-12 rounded-2xl border border-[color:var(--line)] bg-white px-4 text-sm focus:border-[color:var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]/20"
                        placeholder="搜尋模組、貼上 modrinth 連結或輸入清單代碼"
                        value={unifiedInput}
                        onChange={(event) => handleUnifiedInput(event.target.value)}
                        onFocus={() =>
                          !isModrinthUrl(unifiedInput) && setShowSearch(true)
                        }
                        onPaste={() =>
                          setTimeout(() => {
                            if (!isModrinthUrl(unifiedInput)) {
                              setShowSearch(true);
                            }
                          }, 0)
                        }
                        onKeyDown={(e) => e.key === "Enter" && handleUnifiedInputSubmit()}
                      />
                      <button
                        onClick={handleUnifiedInputSubmit}
                        disabled={isAdding || !unifiedInput.trim()}
                        className="h-12 px-6 rounded-2xl bg-[color:var(--accent)] text-white font-semibold hover:brightness-110 disabled:opacity-50 transition"
                        type="button"
                      >
                        新增
                      </button>
                    </div>
                    {showSearch && unifiedInput.trim() && !isModrinthUrl(unifiedInput) && (
                      <div className="absolute top-full left-0 right-0 mt-2 max-h-96 overflow-y-auto rounded-2xl border border-[color:var(--line)] bg-white shadow-2xl z-50">
                        {isSearching && (
                          <div className="px-4 py-6 text-center text-sm text-[color:var(--muted)]">
                            搜尋中...
                          </div>
                        )}
                        {!isSearching && searchResults.length === 0 && (
                          <div className="px-4 py-6 text-center text-sm text-[color:var(--muted)]">
                            找不到相符的模組
                          </div>
                        )}
                        {searchResults.map((result) => (
                          <button
                            key={result.project_id}
                            type="button"
                            onClick={() => {
                              handleSelectSearchResult(result);
                              setUnifiedInput("");
                              setShowSearch(false);
                            }}
                            className="w-full px-4 py-3 text-left hover:bg-orange-50 border-b border-[color:var(--line)] last:border-b-0 transition"
                          >
                            <div className="flex items-center gap-3">
                              {result.icon_url && (
                                <img
                                  src={result.icon_url}
                                  alt={result.title}
                                  className="w-8 h-8 rounded-lg"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{result.title}</p>
                                <p className="text-xs text-[color:var(--muted)] truncate">
                                  {result.slug}
                                </p>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-[color:var(--line)] bg-[color:var(--bg)] px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">自訂模組</p>
                    <p className="text-xs text-[color:var(--muted)]">
                      可填用途說明與外部連結，當作記事本使用。
                    </p>
                  </div>
                  <button
                    className="h-10 rounded-full border border-[color:var(--line)] px-4 text-xs font-semibold text-[color:var(--muted)] hover:border-orange-200 hover:text-orange-700"
                    type="button"
                    onClick={handleAddCustomItem}
                  >
                    新增自訂模組
                  </button>
                </div>
              </div>
              <div className="rounded-2xl border border-dashed border-[color:var(--line)] bg-[color:var(--bg)] px-4 py-5 text-center">
                <p className="text-xs text-[color:var(--muted)]">或下載</p>
                <button
                  className="mt-3 inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--line)] px-4 text-xs font-semibold text-[color:var(--muted)] disabled:opacity-50"
                  type="button"
                  onClick={handleDownloadSelected}
                  disabled={selectedMods.size === 0}
                >
                  下載清單
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-[color:var(--line)] bg-white/90 p-6 shadow-ember animate-fade-up">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">
                  模組清單（{activeCount} / {cartItems.length}）
                </h2>
                <p className="text-sm text-[color:var(--muted)]">
                  依狀態分類，缺失項目需手動處理才能匯出。
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-4">
              {visibleItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex flex-col gap-4 rounded-2xl border px-4 py-4 sm:flex-row sm:items-center sm:justify-between transition ${
                    item.isDependency
                      ? selectedMods.has(item.id)
                        ? "border-slate-400 bg-slate-300"
                        : "border-slate-300 bg-slate-100"
                      : selectedMods.has(item.id)
                      ? "border-orange-300 bg-orange-50"
                      : "border-[color:var(--line)] bg-white"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedMods.has(item.id)}
                      onChange={() => handleToggleSelection(item.id)}
                      className="mt-1 w-5 h-5 rounded border-[color:var(--line)] cursor-pointer"
                    />
                    <div className="flex items-start gap-3 flex-1">
                      {item.iconUrl ? (
                        <img
                          src={item.iconUrl}
                          alt={item.title}
                          className="h-11 w-11 rounded-lg flex-shrink-0 object-cover"
                        />
                      ) : (
                        <div
                          className={`flex h-11 w-11 items-center justify-center rounded-2xl text-sm font-semibold flex-shrink-0 ${
                            item.isDependency
                              ? "bg-slate-200 text-slate-700"
                              : "bg-orange-50 text-orange-700"
                          }`}
                        >
                          {item.title.slice(0, 2)}
                        </div>
                      )}
                      <div className="flex-1">
                        {item.isCustom ? (
                          <div className="grid gap-2">
                            <input
                              className="h-9 rounded-xl border border-[color:var(--line)] bg-white/90 px-3 text-xs text-[color:var(--ink)] focus:border-[color:var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]/20"
                              placeholder="自訂模組名稱"
                              value={item.title}
                              onChange={(event) => handleCustomTitleChange(item.id, event.target.value)}
                            />
                            <input
                              className="h-9 rounded-xl border border-[color:var(--line)] bg-white/90 px-3 text-xs text-[color:var(--ink)] focus:border-[color:var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]/20"
                              placeholder="相關連結（選填）"
                              value={item.customUrl ?? ""}
                              onChange={(event) => handleCustomUrlChange(item.id, event.target.value)}
                            />
                          </div>
                        ) : (
                          <p className="text-sm font-semibold">{item.title}</p>
                        )}
                        {item.filename && item.status === "可更新" && (
                          <p className="text-xs text-emerald-700 mt-1">
                            📦 {item.filename}
                          </p>
                        )}
                        {item.isCustom && item.customUrl ? (
                          <p className="text-xs text-blue-600 mt-1 break-all">
                            連結：{item.customUrl}
                          </p>
                        ) : null}
                        {item.dependencies && item.dependencies.length > 0 && (
                          <p className="text-xs text-blue-600 mt-1">
                            前置：{item.dependencies.map((dep) => dep.title).join(", ")}
                          </p>
                        )}
                        <div className="mt-2">
                          <label className="text-[11px] text-[color:var(--muted)]">
                            模組用途說明
                          </label>
                          <textarea
                            className="mt-1 w-full rounded-xl border border-[color:var(--line)] bg-white/90 px-3 py-2 text-xs text-[color:var(--ink)] focus:border-[color:var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]/20"
                            rows={2}
                            placeholder="例如：效能優化、必備前置、材質依賴..."
                            value={item.note ?? ""}
                            onChange={(event) => handleNoteChange(item.id, event.target.value)}
                          />
                        </div>
                        <p className="text-xs text-[color:var(--muted)]">
                          {item.source}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                        statusStyles[item.statusTone]
                      }`}
                    >
                      {item.status}
                    </span>
                    <span className="text-xs text-[color:var(--muted)]">
                      目標：{item.targetVersion}
                    </span>
                    {item.lastSupportedVersion ? (
                      <span className="text-xs text-amber-700">
                        最後支援：{item.lastSupportedVersion}
                      </span>
                    ) : null}
                    <button
                      className="rounded-full border border-[color:var(--line)] px-3 py-1 text-xs font-semibold text-[color:var(--muted)] hover:border-orange-200 hover:text-orange-700"
                      type="button"
                      onClick={() => handleOpenProject(item)}
                    >
                      {item.isCustom ? "連結" : "Modrinth"}
                    </button>
                    <button
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                        item.downloaded
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          : item.status === "可更新" && !item.isCustom
                          ? "border-orange-200 text-orange-700 hover:bg-orange-50"
                          : "border-[color:var(--line)] text-[color:var(--muted)] cursor-not-allowed opacity-50"
                      }`}
                      type="button"
                      onClick={() => handleDownload(item)}
                      disabled={(item.status !== "可更新" && !item.downloaded) || downloadingId === item.id || item.isCustom}
                    >
                      {downloadingId === item.id ? "下載中..." : item.downloaded ? "已下載" : "下載"}
                    </button>
                    <button
                      className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                      type="button"
                      onClick={() => handleRemove(item.id)}
                    >
                      刪除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 rounded-3xl border border-[color:var(--line)] bg-white/90 p-6 shadow-ember animate-fade-up">
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-semibold">解析進度</h2>
              <p className="text-sm text-[color:var(--muted)]">
                解析同時控制 10 筆並發，200 筆仍可順暢操作。
              </p>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm font-semibold">
                <span>解析進度 {resolvedCount} / {activeCount}</span>
                <span className="text-xs text-[color:var(--muted)]">
                  {isResolving ? "解析中..." : "已完成"}
                </span>
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-700">
                  ✓ 可更新 {stats.success}
                </div>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-700">
                  ⚠ 缺失 {stats.warning}
                </div>
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-3 text-rose-700">
                  ✕ 衝突 {stats.danger}
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="space-y-6">
          <div className="rounded-3xl border border-[color:var(--line)] bg-white/90 p-6 shadow-ember animate-fade-in">
            <h3 className="text-lg font-semibold">快速流程</h3>
            <ol className="mt-4 space-y-3 text-sm text-[color:var(--muted)]">
              <li>1. 搜尋或匯入模組清單</li>
              <li>2. 選擇目標版本與 Loader</li>
              <li>3. 執行解析並查看缺失</li>
              <li>4. 補齊依賴或手動處理</li>
              <li>5. 下載清單 JSON</li>
            </ol>
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-xs text-amber-800">
              版本缺失時不自動降版，需手動確認後才能匯出。
            </div>
          </div>

          <div className="rounded-3xl border border-[color:var(--line)] bg-white/90 p-6 shadow-ember">
            <h3 className="text-lg font-semibold">代碼清單</h3>
            <p className="mt-2 text-sm text-[color:var(--muted)]">
              生成分享連結後，可在輸入框貼上連結或代碼並按新增載入清單。
            </p>
            <div className="mt-5 grid gap-3">
              <button
                className="h-12 rounded-2xl bg-[color:var(--accent)] text-sm font-semibold text-white hover:bg-[color:var(--accent-deep)] disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onClick={handleResolve}
                disabled={isResolving}
              >
                {isResolving ? "解析中..." : "一鍵解析"}
              </button>
              <button
                className="h-12 rounded-2xl border border-[color:var(--line)] text-sm font-semibold text-[color:var(--muted)] disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onClick={handleGenerateCode}
                disabled={!cartItems.length || isGeneratingCode}
              >
                {isGeneratingCode ? "存檔中..." : "分享連結(存檔)"}
              </button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
