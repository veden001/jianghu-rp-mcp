import { readFile } from 'node:fs/promises';
import type { ChapterDefinition, Identity, ItemDefinition } from './types.js';

interface ChapterContentLocation {
  map: string;
  items?: string;
}

const CHAPTER_CONTENT: Record<string, ChapterContentLocation> = {
  zhongyuan: {
    map: '../../chapters/chapter-1-zhongyuan/map.json',
    items: '../../chapters/chapter-1-zhongyuan/items.json',
  },
  saibei: {
    map: '../../chapters/chapter-2-saibei/map.json',
    items: '../../chapters/chapter-2-saibei/items.json',
  },
  jiangnan: {
    map: '../../chapters/chapter-3-jiangnan/map.json',
    items: '../../chapters/chapter-3-jiangnan/items.json',
  },
};

async function readJson<T>(url: URL): Promise<T> {
  const raw = await readFile(url, 'utf8');
  return JSON.parse(raw) as T;
}

export async function loadIdentities(): Promise<Identity[]> {
  return readJson<Identity[]>(new URL('../../content/identities.json', import.meta.url));
}

export async function loadItems(): Promise<ItemDefinition[]> {
  const commonItems = await readJson<ItemDefinition[]>(
    new URL('../../content/common-items.json', import.meta.url),
  );

  const chapterItemFiles = Object.values(CHAPTER_CONTENT)
    .map((entry) => entry.items)
    .filter((entry): entry is string => Boolean(entry));

  const chapterItems = await Promise.all(
    chapterItemFiles.map((path) => readJson<ItemDefinition[]>(new URL(path, import.meta.url))),
  );

  const allItems = [...commonItems, ...chapterItems.flat()];
  const seen = new Set<string>();
  for (const item of allItems) {
    if (seen.has(item.id)) throw new Error(`Duplicate item id across content files: ${item.id}`);
    seen.add(item.id);
  }

  return allItems;
}

export async function loadChapter(id: string): Promise<ChapterDefinition> {
  const location = CHAPTER_CONTENT[id];
  if (!location) throw new Error(`Unknown chapter: ${id}`);
  return readJson<ChapterDefinition>(new URL(location.map, import.meta.url));
}
