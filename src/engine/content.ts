import { readFile } from 'node:fs/promises';
import type { ChapterDefinition, Identity, ItemDefinition } from './types.js';

async function readJson<T>(url: URL): Promise<T> {
  const raw = await readFile(url, 'utf8');
  return JSON.parse(raw) as T;
}

export async function loadIdentities(): Promise<Identity[]> {
  return readJson<Identity[]>(new URL('../../content/identities.json', import.meta.url));
}

export async function loadItems(): Promise<ItemDefinition[]> {
  return readJson<ItemDefinition[]>(new URL('../../content/items.json', import.meta.url));
}

export async function loadChapter(id: string): Promise<ChapterDefinition> {
  if (id !== 'zhongyuan') {
    throw new Error(`Unknown chapter: ${id}`);
  }
  return readJson<ChapterDefinition>(new URL('../../content/maps/zhongyuan.json', import.meta.url));
}
