import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState } from './types.js';

function safeSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error('Invalid session id.');
  }
  return sessionId;
}

function stateUrl(sessionId: string): URL {
  return new URL(`../../.data/${safeSessionId(sessionId)}.json`, import.meta.url);
}

export async function saveState(state: GameState): Promise<void> {
  const url = stateUrl(state.sessionId);
  await mkdir(dirname(fileURLToPath(url)), { recursive: true });
  await writeFile(url, JSON.stringify(state, null, 2), 'utf8');
}

export async function loadState(sessionId: string): Promise<GameState> {
  const url = stateUrl(sessionId);
  try {
    const raw = await readFile(url, 'utf8');
    return JSON.parse(raw) as GameState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Game session not found: ${sessionId}`);
    }
    throw error;
  }
}
