import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState } from './types.js';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../.data/', import.meta.url));

function safeSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error('Invalid session id.');
  }
  return sessionId;
}

function dataDir(): string {
  const configured = process.env.JIANGHU_DATA_DIR?.trim();
  return configured ? resolve(configured) : DEFAULT_DATA_DIR;
}

function statePath(sessionId: string): string {
  return join(dataDir(), `${safeSessionId(sessionId)}.json`);
}

export async function saveState(state: GameState): Promise<void> {
  const path = statePath(state.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
}

export async function loadState(sessionId: string): Promise<GameState> {
  const path = statePath(sessionId);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as GameState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Game session not found: ${sessionId}`);
    }
    throw error;
  }
}
