import { randomInt, randomUUID } from 'node:crypto';
import { loadChapter, loadIdentities, loadItems } from './content.js';
import { loadState, saveState } from './store.js';
import type {
  Cell,
  ChapterDefinition,
  GameState,
  Identity,
  IdentityMode,
  InventoryEntry,
  ItemDefinition,
  MechanicalEffect,
  PlayerId,
  PlayerState,
  ShopCell,
} from './types.js';

const GAME_VERSION = '0.1.0';

type Rng = (min: number, maxExclusive: number) => number;
const defaultRng: Rng = (min, maxExclusive) => randomInt(min, maxExclusive);

export interface NewGameInput {
  sessionId?: string;
  humanName?: string;
  aiName?: string;
  humanIdentityMode: IdentityMode;
  humanIdentityId?: string;
  aiIdentityMode: IdentityMode;
  aiIdentityId?: string;
}

export interface ActionInput {
  sessionId: string;
  action:
    | 'choose_disguise'
    | 'buy'
    | 'complete_scene'
    | 'use_item'
    | 'accept_roll'
    | 'reroll_roll';
  player?: PlayerId;
  optionId?: string;
  itemId?: string;
  targetItemId?: string;
  disguiseIdentityId?: string;
}

function appendLog(state: GameState, message: string): void {
  state.log.push({ at: new Date().toISOString(), message });
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

function findIdentity(identities: Identity[], id: string): Identity {
  const identity = identities.find((entry) => entry.id === id);
  if (!identity) throw new Error(`Unknown identity: ${id}`);
  return identity;
}

function chooseIdentity(
  identities: Identity[],
  mode: IdentityMode,
  selectedId: string | undefined,
  rng: Rng,
): Identity {
  if (mode === 'select') {
    if (!selectedId) throw new Error('Self-selected identity mode requires an identity id.');
    const chosen = findIdentity(identities, selectedId);
    if (chosen.special) throw new Error('Special identities can only be obtained in random mode.');
    return chosen;
  }
  return identities[rng(0, identities.length)]!;
}

function makePlayer(id: PlayerId, name: string, identity: Identity): PlayerState {
  return {
    id,
    name,
    identity,
    money: 30,
    position: 1,
    finished: false,
    inventory: [],
    effects: {
      nextMoveBonus: 0,
      nextRollDelta: 0,
      rerollReady: false,
      cancelNextAdverse: false,
      antidote: 0,
    },
  };
}

function addItem(player: PlayerState, itemId: string, count = 1): void {
  const existing = player.inventory.find((entry) => entry.itemId === itemId);
  if (existing) existing.count += count;
  else player.inventory.push({ itemId, count });
}

function removeItem(player: PlayerState, itemId: string, count = 1): void {
  const existing = player.inventory.find((entry) => entry.itemId === itemId);
  if (!existing || existing.count < count) throw new Error(`Item not available: ${itemId}`);
  existing.count -= count;
  if (existing.count === 0) player.inventory = player.inventory.filter((entry) => entry.itemId !== itemId);
}

function itemCount(player: PlayerState, itemId: string): number {
  return player.inventory.find((entry) => entry.itemId === itemId)?.count ?? 0;
}

function otherPlayer(id: PlayerId): PlayerId {
  return id === 'human' ? 'ai' : 'human';
}

function getCell(chapter: ChapterDefinition, position: number): Cell {
  const cell = chapter.cells.find((entry) => entry.position === position);
  if (!cell) throw new Error(`No cell at position ${position}.`);
  return cell;
}

function advanceTurn(state: GameState, from: PlayerId): void {
  const other = otherPlayer(from);
  if (!state.players[other].finished) state.currentPlayer = other;
  else if (!state.players[from].finished) state.currentPlayer = from;
}

function inventoryNames(player: PlayerState, items: ItemDefinition[]): string[] {
  return player.inventory.map((entry) => {
    const def = items.find((item) => item.id === entry.itemId);
    return `${def?.name ?? entry.itemId}×${entry.count}`;
  });
}

function applyEffect(
  player: PlayerState,
  effect: MechanicalEffect | undefined,
): { immediateMove: number; notes: string[] } {
  const notes: string[] = [];
  if (!effect) return { immediateMove: 0, notes };
  if (typeof effect.money_delta === 'number') {
    const before = player.money;
    player.money = Math.max(0, player.money + effect.money_delta);
    notes.push(`银两 ${before} → ${player.money}`);
  }
  if (typeof effect.next_roll_delta === 'number') {
    player.effects.nextRollDelta += effect.next_roll_delta;
    notes.push(`下一次掷骰修正 ${effect.next_roll_delta >= 0 ? '+' : ''}${effect.next_roll_delta}`);
  }
  if (effect.add_item) {
    addItem(player, effect.add_item);
    notes.push(`获得道具 ${effect.add_item}`);
  }
  if (effect.clear_next_roll_penalty) {
    player.effects.nextRollDelta = Math.max(0, player.effects.nextRollDelta);
    notes.push('已移除当前移动减益');
  }
  return { immediateMove: effect.move_immediate ?? 0, notes };
}

async function removeRandomOrdinaryItem(
  player: PlayerState,
  items: ItemDefinition[],
  rng: Rng,
): Promise<string | undefined> {
  const candidates: InventoryEntry[] = player.inventory.filter((entry) => {
    const def = items.find((item) => item.id === entry.itemId);
    return entry.count > 0 && !def?.collectible;
  });
  if (candidates.length === 0) return undefined;
  const picked = candidates[rng(0, candidates.length)]!;
  removeItem(player, picked.itemId);
  return items.find((item) => item.id === picked.itemId)?.name ?? picked.itemId;
}

async function resolveLanding(
  state: GameState,
  playerId: PlayerId,
  chapter: ChapterDefinition,
  items: ItemDefinition[],
  rng: Rng,
): Promise<string[]> {
  const player = state.players[playerId];
  const cell = getCell(chapter, player.position);
  const out: string[] = [`落在第${cell.position}格【${cell.title}】。`];

  if (cell.type === 'scene') {
    state.status = 'awaiting_scene';
    state.pendingScene = { cellPosition: cell.position, triggerPlayer: playerId };
    out.push(cell.intro, `【互动目标】${cell.goal}`);
    return out;
  }

  if (cell.type === 'shop') {
    state.status = 'awaiting_shop';
    state.pendingShop = { cellPosition: cell.position, player: playerId };
    out.push(cell.text);
    out.push(...cell.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option.label} [${option.id}]`));
    return out;
  }

  if (cell.type === 'light') {
    out.push(cell.text);
    if (cell.adverse && player.effects.cancelNextAdverse) {
      player.effects.cancelNextAdverse = false;
      out.push('烟丸生效：本次不利轻事件已取消。');
      advanceTurn(state, playerId);
      return out;
    }
    const { immediateMove, notes } = applyEffect(player, cell.effect);
    out.push(...notes);
    if (cell.effect.lose_random_item) {
      const lost = await removeRandomOrdinaryItem(player, items, rng);
      out.push(lost ? `失去道具：${lost}` : '没有可被吹走的普通道具。');
    }
    if (immediateMove > 0) {
      out.push(...(await movePlayer(state, playerId, immediateMove, chapter, items, rng, '事件移动')));
      return out;
    }
    advanceTurn(state, playerId);
    return out;
  }

  if (cell.type === 'rhythm' || cell.type === 'landmark') {
    out.push(cell.text);
    const effect = cell.type === 'rhythm' ? cell.effect : undefined;
    const { immediateMove, notes } = applyEffect(player, effect);
    out.push(...notes);
    if (immediateMove > 0) {
      out.push(...(await movePlayer(state, playerId, immediateMove, chapter, items, rng, '节奏格移动')));
      return out;
    }
    advanceTurn(state, playerId);
    return out;
  }

  if (cell.type === 'finale') {
    // Normally reached through the finish handler. Keep this as a safe fallback.
    if (state.players.human.finished && state.players.ai.finished) {
      state.status = 'awaiting_scene';
      state.pendingScene = { cellPosition: cell.position, triggerPlayer: playerId };
      out.push(cell.intro, `【互动目标】${cell.goal}`);
    }
    return out;
  }

  return out;
}

async function movePlayer(
  state: GameState,
  playerId: PlayerId,
  spaces: number,
  chapter: ChapterDefinition,
  items: ItemDefinition[],
  rng: Rng,
  reason = '移动',
): Promise<string[]> {
  const player = state.players[playerId];
  const from = player.position;
  const destination = Math.min(chapter.length, from + Math.max(0, spaces));
  player.position = destination;
  const out = [`${reason}：${from} → ${destination}。`];

  if (destination >= chapter.length) {
    player.finished = true;
    if (!state.firstFinisher) {
      state.firstFinisher = playerId;
      addItem(player, chapter.collectible.item_id);
      out.push(`${player.name}率先抵达终点，获得章节收藏品。`);
    }

    const other = otherPlayer(playerId);
    if (!state.players[other].finished) {
      state.status = 'active';
      state.currentPlayer = other;
      out.push(`${player.name}已抵达黄河渡口，暂时等待另一位玩家。现在只由${state.players[other].name}继续行动。`);
      return out;
    }

    const finale = getCell(chapter, chapter.length);
    if (finale.type !== 'finale') throw new Error('Chapter final cell is not a finale.');
    state.status = 'awaiting_scene';
    state.pendingScene = { cellPosition: chapter.length, triggerPlayer: playerId };
    out.push(finale.intro, `【互动目标】${finale.goal}`);
    return out;
  }

  out.push(...(await resolveLanding(state, playerId, chapter, items, rng)));
  return out;
}

export async function newGame(input: NewGameInput, rng: Rng = defaultRng): Promise<{ state: GameState; text: string }> {
  const identities = await loadIdentities();
  const chapter = await loadChapter('zhongyuan');
  const humanIdentity = chooseIdentity(identities, input.humanIdentityMode, input.humanIdentityId, rng);
  const aiIdentity = chooseIdentity(identities, input.aiIdentityMode, input.aiIdentityId, rng);
  const sessionId = input.sessionId ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const setupPendingDisguises: PlayerId[] = [];
  if (humanIdentity.requires_disguise) setupPendingDisguises.push('human');
  if (aiIdentity.requires_disguise) setupPendingDisguises.push('ai');

  const state: GameState = {
    sessionId,
    version: GAME_VERSION,
    chapterId: chapter.id,
    status: setupPendingDisguises.length > 0 ? 'setup' : 'active',
    currentPlayer: 'human',
    players: {
      human: makePlayer('human', input.humanName ?? '人类玩家', humanIdentity),
      ai: makePlayer('ai', input.aiName ?? 'AI玩家', aiIdentity),
    },
    setupPendingDisguises,
    log: [],
  };
  appendLog(state, `新游戏开始：${chapter.name}`);
  await saveState(state);

  const lines = [
    `游戏已创建。session_id=${sessionId}`,
    `【${chapter.opening.title}】${chapter.opening.text}`,
    `人类玩家身份：${humanIdentity.name}｜${humanIdentity.description}`,
    'AI玩家身份已经生成，由AI玩家自行决定是否、何时向人类公开。',
    '双方初始银两：30两。',
    '身份本身不直接提供数值、道具或自动成功效果。玩家可自由补充角色经历、性格、关系与秘密，但不得修改当前场景既定事实或凭空获得直接优势。',
  ];
  if (setupPendingDisguises.length > 0) {
    lines.push(`尚需设置伪装身份：${setupPendingDisguises.join('、')}。请使用 choose_disguise 完成后再掷骰。`);
  } else {
    lines.push('双方从第1格【洛阳城门】出发。默认由人类玩家先手。');
  }
  return { state, text: lines.join('\n\n') };
}

export async function getGameState(sessionId: string): Promise<GameState> {
  return loadState(sessionId);
}

export async function roll(sessionId: string, rng: Rng = defaultRng): Promise<{ state: GameState; text: string }> {
  const state = await loadState(sessionId);
  if (state.status !== 'active') throw new Error(`Cannot roll while game status is ${state.status}.`);
  const playerId = state.currentPlayer;
  const player = state.players[playerId];
  if (player.finished) throw new Error('Finished player cannot roll.');

  const raw = rng(1, 7);
  const rollDelta = player.effects.nextRollDelta;
  const die = Math.max(1, raw + rollDelta);

  if (player.effects.rerollReady) {
    player.effects.rerollReady = false;
    state.status = 'awaiting_roll_choice';
    state.pendingRoll = { player: playerId, die, rollDelta };
    appendLog(state, `${player.name}掷出${die}，等待决定是否重掷。`);
    await saveState(state);
    return {
      state,
      text: `${player.name}掷出了 ${die} 点。已启用重掷机会，请选择 accept_roll 接受，或 reroll_roll 重掷一次。`,
    };
  }

  player.effects.nextRollDelta = 0;
  const moveBonus = player.effects.nextMoveBonus;
  player.effects.nextMoveBonus = 0;
  const totalMove = die + moveBonus;
  const chapter = await loadChapter(state.chapterId);
  const items = await loadItems();
  const lines = [`${player.name}掷出了 ${die} 点${moveBonus ? `，额外移动加成 +${moveBonus}` : ''}。`];
  lines.push(...(await movePlayer(state, playerId, totalMove, chapter, items, rng)));
  appendLog(state, lines.join(' '));
  await saveState(state);
  return { state, text: lines.join('\n\n') };
}

async function resolvePendingRoll(state: GameState, reroll: boolean, rng: Rng): Promise<string> {
  const pending = state.pendingRoll;
  if (!pending || state.status !== 'awaiting_roll_choice') throw new Error('No pending roll decision.');
  const player = state.players[pending.player];
  let die = pending.die;
  const lines: string[] = [];
  if (reroll) {
    const raw = rng(1, 7);
    die = Math.max(1, raw + pending.rollDelta);
    lines.push(`${player.name}选择重掷，新结果为 ${die} 点。`);
  } else {
    lines.push(`${player.name}接受 ${die} 点。`);
  }
  player.effects.nextRollDelta = 0;
  const moveBonus = player.effects.nextMoveBonus;
  player.effects.nextMoveBonus = 0;
  state.pendingRoll = undefined;
  state.status = 'active';
  const chapter = await loadChapter(state.chapterId);
  const items = await loadItems();
  lines.push(...(await movePlayer(state, pending.player, die + moveBonus, chapter, items, rng)));
  return lines.join('\n\n');
}

export async function gameAction(input: ActionInput, rng: Rng = defaultRng): Promise<{ state: GameState; text: string }> {
  const state = await loadState(input.sessionId);
  const identities = await loadIdentities();
  const items = await loadItems();
  const chapter = await loadChapter(state.chapterId);
  let text = '';

  if (input.action === 'choose_disguise') {
    const playerId = input.player;
    if (!playerId || !input.disguiseIdentityId) throw new Error('choose_disguise requires player and disguiseIdentityId.');
    if (!state.setupPendingDisguises.includes(playerId)) throw new Error('That player does not need a disguise.');
    const disguise = findIdentity(identities, input.disguiseIdentityId);
    if (disguise.special) throw new Error('Immortal disguise must be one of the 12 ordinary identities.');
    state.players[playerId].disguiseIdentityId = disguise.id;
    state.setupPendingDisguises = state.setupPendingDisguises.filter((id) => id !== playerId);
    if (state.setupPendingDisguises.length === 0) state.status = 'active';
    text = `${state.players[playerId].name}选择以【${disguise.name}】作为千岁仙人的凡俗伪装。${state.status === 'active' ? '身份设置完成，可以开始掷骰。' : ''}`;
  } else if (input.action === 'accept_roll') {
    text = await resolvePendingRoll(state, false, rng);
  } else if (input.action === 'reroll_roll') {
    text = await resolvePendingRoll(state, true, rng);
  } else if (input.action === 'complete_scene') {
    if (state.status !== 'awaiting_scene' || !state.pendingScene) throw new Error('No roleplay scene is awaiting completion.');
    const pending = state.pendingScene;
    const cell = getCell(chapter, pending.cellPosition);
    if (cell.type !== 'scene' && cell.type !== 'finale') throw new Error('Pending cell is not a scene.');
    text = `【固定结算】${cell.resolution}`;
    state.pendingScene = undefined;
    if (cell.type === 'finale') {
      state.status = 'chapter_complete';
      text += '\n\n【第一章完成】下一章：塞北逐剑（尚未加入 v0.1 内容库）。';
    } else {
      state.status = 'active';
      advanceTurn(state, pending.triggerPlayer);
      text += `\n\n本格完成。下一回合：${state.players[state.currentPlayer].name}。`;
    }
  } else if (input.action === 'buy') {
    if (state.status !== 'awaiting_shop' || !state.pendingShop) throw new Error('No shop choice is awaiting resolution.');
    const pending = state.pendingShop;
    if (input.player && input.player !== pending.player) throw new Error('Only the player who landed on the shop may choose.');
    if (!input.optionId) throw new Error('buy requires optionId.');
    const cell = getCell(chapter, pending.cellPosition);
    if (cell.type !== 'shop') throw new Error('Pending cell is not a shop.');
    const option = cell.options.find((entry) => entry.id === input.optionId);
    if (!option) throw new Error(`Unknown shop option: ${input.optionId}`);
    const player = state.players[pending.player];
    if (player.money < option.cost) throw new Error(`Not enough money. Need ${option.cost}, have ${player.money}.`);
    player.money -= option.cost;
    const lines = [`${player.name}选择：${option.label}`, `银两剩余：${player.money}两。`];

    state.pendingShop = undefined;
    state.status = 'active';

    if (option.kind === 'item' && option.item_id) {
      addItem(player, option.item_id);
      const def = items.find((entry) => entry.id === option.item_id);
      lines.push(`获得道具【${def?.name ?? option.item_id}】。`);
    } else if (option.kind === 'effect') {
      const { immediateMove, notes } = applyEffect(player, option.effect);
      lines.push(...notes);
      if (immediateMove > 0) {
        lines.push(...(await movePlayer(state, pending.player, immediateMove, chapter, items, rng, '功能格移动')));
        text = lines.join('\n\n');
        appendLog(state, text);
        await saveState(state);
        return { state, text };
      }
    } else if (option.kind === 'inspect') {
      const distance = option.distance ?? 1;
      const previews = chapter.cells
        .filter((entry) => entry.position > player.position && entry.position <= player.position + distance)
        .map((entry) => `第${entry.position}格：${entry.type}【${entry.title}】`);
      lines.push(previews.length ? `前方情报：\n${previews.join('\n')}` : '前方已接近地图终点。');
    } else if (option.kind === 'identify') {
      if (!input.targetItemId) throw new Error('identify option requires targetItemId.');
      if (itemCount(player, input.targetItemId) < 1) throw new Error('You do not own that item.');
      const def = items.find((entry) => entry.id === input.targetItemId);
      if (!def) throw new Error('Unknown item.');
      const verdict = def.id === 'fake_rubbing' ? '赝品' : def.collectible ? '收藏品' : '普通物品';
      lines.push(`鉴定结果：【${def.name}】属于${verdict}。${def.description}`);
    }

    if (state.status === 'active') advanceTurn(state, pending.player);
    text = lines.join('\n\n');
  } else if (input.action === 'use_item') {
    const playerId = input.player ?? state.currentPlayer;
    if (state.status !== 'active') throw new Error('Mechanical items can only be used between scenes, before rolling.');
    if (playerId !== state.currentPlayer) throw new Error('Only the current player may use a mechanical item.');
    if (!input.itemId) throw new Error('use_item requires itemId.');
    if (itemCount(state.players[playerId], input.itemId) < 1) throw new Error('Item not in inventory.');
    const def = items.find((entry) => entry.id === input.itemId);
    if (!def) throw new Error('Unknown item.');
    const player = state.players[playerId];
    const notes: string[] = [];
    if (def.effect.next_move_bonus) {
      player.effects.nextMoveBonus += def.effect.next_move_bonus;
      notes.push(`下一次移动 +${def.effect.next_move_bonus}`);
    }
    if (def.effect.next_roll_bonus) {
      player.effects.nextRollDelta += def.effect.next_roll_bonus;
      notes.push(`下一次掷骰 +${def.effect.next_roll_bonus}`);
    }
    if (def.effect.enable_reroll) {
      player.effects.rerollReady = true;
      notes.push('下一次掷骰可重掷一次');
    }
    if (def.effect.cancel_next_adverse) {
      player.effects.cancelNextAdverse = true;
      notes.push('下一次不利轻事件将自动取消');
    }
    if (def.effect.antidote) {
      player.effects.antidote += def.effect.antidote;
      notes.push('获得一次解毒储备');
    }
    if (def.consumable) removeItem(player, input.itemId);
    text = `使用道具【${def.name}】。${notes.length ? notes.join('；') : '该道具没有固定机械效果，可在角色扮演中自由使用。'}`;
  } else {
    throw new Error(`Unsupported action: ${String(input.action)}`);
  }

  appendLog(state, text);
  await saveState(state);
  return { state, text };
}

export async function summarizeGame(sessionId: string): Promise<string> {
  const state = await loadState(sessionId);
  const items = await loadItems();
  const chapter = await loadChapter(state.chapterId);
  const lines = [
    `session_id: ${state.sessionId}`,
    `章节：${chapter.name}`,
    `状态：${state.status}`,
    `当前回合：${state.players[state.currentPlayer].name} (${state.currentPlayer})`,
  ];
  for (const id of ['human', 'ai'] as PlayerId[]) {
    const p = state.players[id];
    const disguise = p.disguiseIdentityId ? `，伪装：${p.disguiseIdentityId}` : '';
    lines.push(`${p.name}：第${p.position}格｜${p.money}两｜身份：${p.identity.name}${disguise}｜道具：${inventoryNames(p, items).join('、') || '无'}${p.finished ? '｜已到达终点' : ''}`);
  }
  if (state.pendingScene) lines.push(`待完成场景：第${state.pendingScene.cellPosition}格`);
  if (state.pendingShop) lines.push(`待处理功能格：第${state.pendingShop.cellPosition}格`);
  if (state.pendingRoll) lines.push(`待决定骰子：${state.pendingRoll.die}点`);
  return lines.join('\n');
}

export async function chapterOverview(): Promise<string> {
  const chapter = await loadChapter('zhongyuan');
  const counts = chapter.cells.reduce<Record<string, number>>((acc, cell) => {
    const key = cell.type === 'finale' ? 'scene' : cell.type;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  return `${chapter.name}｜${chapter.length}格｜江湖场景${counts.scene ?? 0}｜轻事件${counts.light ?? 0}｜功能格${counts.shop ?? 0}｜特殊地标${counts.landmark ?? 0}｜节奏格${counts.rhythm ?? 0}`;
}
