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

const GAME_VERSION = '0.2.2';
const NEXT_CHAPTER: Record<string, string | undefined> = { zhongyuan: 'saibei', saibei: undefined };
const UPCOMING_CHAPTER_NAME: Record<string, string | undefined> = { saibei: '第三章：江南终局' };

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
    | 'wear_item'
    | 'gift_item'
    | 'customize_item'
    | 'accept_roll'
    | 'reroll_roll'
    | 'stop_at_shop'
    | 'continue_move'
    | 'start_next_chapter';
  player?: PlayerId;
  targetPlayer?: PlayerId;
  optionId?: string;
  itemId?: string;
  targetItemId?: string;
  disguiseIdentityId?: string;
  customText?: string;
  chosenRoll?: number;
  shopPosition?: number;
}

function appendLog(state: GameState, message: string): void {
  state.log.push({ at: new Date().toISOString(), message });
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

function normalizeLoadedState(state: GameState): GameState {
  // Backward compatibility for v0.1.x saves.
  if (!Array.isArray(state.resolvedScenes)) state.resolvedScenes = [];
  for (const id of ['human', 'ai'] as PlayerId[]) {
    const player = state.players[id];
    if (!Array.isArray(player.wornItems)) player.wornItems = [];
    if (typeof player.effects.forcedNextRoll !== 'number') player.effects.forcedNextRoll = undefined;
  }
  return state;
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
    wornItems: [],
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
  let remaining = count;
  for (const entry of player.inventory.filter((candidate) => candidate.itemId === itemId)) {
    const take = Math.min(entry.count, remaining);
    entry.count -= take;
    remaining -= take;
    if (remaining === 0) break;
  }
  if (remaining > 0) throw new Error(`Item not available: ${itemId}`);
  player.inventory = player.inventory.filter((entry) => entry.count > 0);
  if (itemCount(player, itemId) === 0) player.wornItems = player.wornItems.filter((id) => id !== itemId);
}

function itemCount(player: PlayerState, itemId: string): number {
  return player.inventory
    .filter((entry) => entry.itemId === itemId)
    .reduce((sum, entry) => sum + entry.count, 0);
}

function singleItemEntry(player: PlayerState, itemId: string): InventoryEntry {
  const entry = player.inventory.find((candidate) => candidate.itemId === itemId);
  if (!entry) throw new Error(`Item not available: ${itemId}`);
  if (entry.count === 1) return entry;
  entry.count -= 1;
  const split: InventoryEntry = { itemId, count: 1 };
  player.inventory.push(split);
  return split;
}

function giftOneItem(from: PlayerState, to: PlayerState, itemId: string): InventoryEntry {
  const entry = singleItemEntry(from, itemId);
  from.inventory = from.inventory.filter((candidate) => candidate !== entry);
  to.inventory.push(entry);
  if (itemCount(from, itemId) === 0) from.wornItems = from.wornItems.filter((id) => id !== itemId);
  return entry;
}

function otherPlayer(id: PlayerId): PlayerId {
  return id === 'human' ? 'ai' : 'human';
}

function getCell(chapter: ChapterDefinition, position: number): Cell {
  const cell = chapter.cells.find((entry) => entry.position === position);
  if (!cell) throw new Error(`No cell at position ${position}.`);
  return cell;
}

function firstUnresolvedCoreSceneBetween(
  state: GameState,
  chapter: ChapterDefinition,
  from: number,
  destination: number,
): number | undefined {
  return chapter.cells
    .filter(
      (cell) =>
        cell.type === 'scene' &&
        cell.scene_mode === 'core' &&
        cell.position > from &&
        cell.position <= destination &&
        !state.resolvedScenes.includes(cell.position),
    )
    .map((cell) => cell.position)
    .sort((a, b) => a - b)[0];
}

function shopPositionsBetween(
  chapter: ChapterDefinition,
  from: number,
  destination: number,
): number[] {
  return chapter.cells
    .filter((cell) => cell.type === 'shop' && cell.position > from && cell.position < destination)
    .map((cell) => cell.position)
    .sort((a, b) => a - b);
}

function advanceTurn(state: GameState, from: PlayerId): void {
  const other = otherPlayer(from);
  if (!state.players[other].finished) state.currentPlayer = other;
  else if (!state.players[from].finished) state.currentPlayer = from;
}

function inventoryNames(player: PlayerState, items: ItemDefinition[]): string[] {
  return player.inventory.map((entry) => {
    const def = items.find((item) => item.id === entry.itemId);
    const annotations: string[] = [];
    if (entry.variant) annotations.push(`定制：变${entry.variant}`);
    if (entry.engraving) annotations.push(`刻字：${entry.engraving}`);
    if (player.wornItems.includes(entry.itemId)) annotations.push('佩戴中');
    const suffix = annotations.length ? `（${annotations.join('；')}）` : '';
    return `${def?.name ?? entry.itemId}${suffix}×${entry.count}`;
  });
}

function sameSpaceHook(
  state: GameState,
  playerId: PlayerId,
  chapter: ChapterDefinition,
  rng: Rng,
): string | undefined {
  const other = state.players[otherPlayer(playerId)];
  const player = state.players[playerId];
  if (player.finished || other.finished || player.position !== other.position) return undefined;
  const hooks = chapter.same_space_hooks ?? [];
  if (hooks.length === 0) return undefined;
  return `【同格偶遇｜可选】${hooks[rng(0, hooks.length)]}`;
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
    if (state.resolvedScenes.includes(cell.position)) {
      out.push('这个江湖场景已经在本章发生过，本次不重复触发。');
      const hook = sameSpaceHook(state, playerId, chapter, rng);
      if (hook) out.push(hook);
      advanceTurn(state, playerId);
      return out;
    }
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
      const hook = sameSpaceHook(state, playerId, chapter, rng);
      if (hook) out.push(hook);
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
    const hook = sameSpaceHook(state, playerId, chapter, rng);
    if (hook) out.push(hook);
    advanceTurn(state, playerId);
    return out;
  }

  if (cell.type === 'rhythm' || cell.type === 'landmark') {
    out.push(cell.text);
    if (cell.type === 'rhythm' && cell.interaction_hook) {
      out.push(`【互动钩子｜可选】${cell.interaction_hook}`);
    }
    const effect = cell.type === 'rhythm' ? cell.effect : undefined;
    const { immediateMove, notes } = applyEffect(player, effect);
    out.push(...notes);
    if (immediateMove > 0) {
      out.push(...(await movePlayer(state, playerId, immediateMove, chapter, items, rng, '节奏格移动')));
      return out;
    }
    const hook = sameSpaceHook(state, playerId, chapter, rng);
    if (hook) out.push(hook);
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

async function resolveMoveDestination(
  state: GameState,
  playerId: PlayerId,
  from: number,
  destination: number,
  chapter: ChapterDefinition,
  items: ItemDefinition[],
  rng: Rng,
  reason: string,
  note = '',
): Promise<string[]> {
  const player = state.players[playerId];
  player.position = destination;
  const out = [`${reason}：${from} → ${destination}。${note}`.trim()];

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
      out.push(`${player.name}已抵达本章终点，暂时等待另一位玩家。现在只由${state.players[other].name}继续行动。`);
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
  const rolledDestination = Math.min(chapter.length, from + Math.max(0, spaces));
  const coreStop = firstUnresolvedCoreSceneBetween(state, chapter, from, rolledDestination);

  // 核心场景优先级最高。只要路径上存在尚未触发的核心场景，直接停下，
  // 不再询问途经商店。
  if (coreStop !== undefined) {
    return resolveMoveDestination(
      state,
      playerId,
      from,
      coreStop,
      chapter,
      items,
      rng,
      reason,
      '途经尚未触发的核心场景，强制停留。',
    );
  }

  // 若只是路过功能格，玩家可以从本次路径经过的商店中任选一家停留，
  // 也可以全部跳过并继续前往原落点。真正落在商店格时仍按普通落格处理。
  const passShops = shopPositionsBetween(chapter, from, rolledDestination);
  if (passShops.length > 0) {
    state.status = 'awaiting_pass_shop';
    state.pendingPassShop = {
      player: playerId,
      from,
      destination: rolledDestination,
      shopPositions: passShops,
      reason,
    };
    const shopLines = passShops.map((position) => {
      const cell = getCell(chapter, position);
      return `第${position}格【${cell.title}】`;
    });
    return [
      `${reason}计划：${from} → ${rolledDestination}。`,
      `【途经功能格】本次途中经过：${shopLines.join('、')}。`,
      '你可以从这些功能格中任选一家停留，或全部跳过继续前往原落点。途经多个功能格时，本次移动最多只能选择一家。',
    ];
  }

  return resolveMoveDestination(
    state,
    playerId,
    from,
    rolledDestination,
    chapter,
    items,
    rng,
    reason,
  );
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
    resolvedScenes: [],
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
  return normalizeLoadedState(await loadState(sessionId));
}

export async function roll(sessionId: string, rng: Rng = defaultRng): Promise<{ state: GameState; text: string }> {
  const state = normalizeLoadedState(await loadState(sessionId));
  if (state.status !== 'active') throw new Error(`Cannot roll while game status is ${state.status}.`);
  const playerId = state.currentPlayer;
  const player = state.players[playerId];
  if (player.finished) throw new Error('Finished player cannot roll.');

  state.lastInteractiveUse = undefined;
  const forcedRoll = player.effects.forcedNextRoll;
  const raw = forcedRoll ?? rng(1, 7);
  player.effects.forcedNextRoll = undefined;
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
  const lines = [
    `${player.name}${forcedRoll ? `按《上官昭容诗集》指定基础点数 ${forcedRoll}，最终` : ''}掷出了 ${die} 点${moveBonus ? `，额外移动加成 +${moveBonus}` : ''}。`,
  ];
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
  const state = normalizeLoadedState(await loadState(input.sessionId));
  const identities = await loadIdentities();
  const items = await loadItems();
  const chapter = await loadChapter(state.chapterId);
  let text = '';

  if (input.action !== 'use_item') state.lastInteractiveUse = undefined;

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
    if (!state.resolvedScenes.includes(cell.position)) state.resolvedScenes.push(cell.position);
    state.pendingScene = undefined;
    if (cell.type === 'finale') {
      state.status = 'chapter_complete';
      const nextId = NEXT_CHAPTER[state.chapterId];
      if (nextId) {
        const nextChapter = await loadChapter(nextId);
        text += `

【${chapter.name}完成】下一章：${nextChapter.name}。准备继续时，调用 start_next_chapter。`;
      } else {
        const upcoming = UPCOMING_CHAPTER_NAME[state.chapterId];
        text += `

【${chapter.name}完成】${upcoming ? `下一章：${upcoming}（尚未加入当前版本）。` : '当前可玩章节已全部完成。'}`;
      }
    } else {
      state.status = 'active';
      advanceTurn(state, pending.triggerPlayer);
      text += `\n\n本格完成。下一回合：${state.players[state.currentPlayer].name}。`;
    }
  } else if (input.action === 'stop_at_shop') {
    if (state.status !== 'awaiting_pass_shop' || !state.pendingPassShop) {
      throw new Error('No passed-shop choice is awaiting resolution.');
    }
    const pending = state.pendingPassShop;
    if (input.player && input.player !== pending.player) throw new Error('Only the moving player may choose a passed shop.');
    if (!Number.isInteger(input.shopPosition)) throw new Error('stop_at_shop requires shopPosition.');
    if (!pending.shopPositions.includes(input.shopPosition!)) throw new Error('That shop was not passed during this move.');
    const cell = getCell(chapter, input.shopPosition!);
    if (cell.type !== 'shop') throw new Error('Selected passed cell is not a shop.');
    const player = state.players[pending.player];
    player.position = cell.position;
    state.pendingPassShop = undefined;
    state.status = 'awaiting_shop';
    state.pendingShop = { cellPosition: cell.position, player: pending.player };
    const lines = [
      `${player.name}选择在途经的第${cell.position}格【${cell.title}】停留。`,
      cell.text,
      ...cell.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option.label} [${option.id}]`),
    ];
    text = lines.join('\n\n');
  } else if (input.action === 'continue_move') {
    if (state.status !== 'awaiting_pass_shop' || !state.pendingPassShop) {
      throw new Error('No passed-shop choice is awaiting resolution.');
    }
    const pending = state.pendingPassShop;
    if (input.player && input.player !== pending.player) throw new Error('Only the moving player may continue this move.');
    state.pendingPassShop = undefined;
    state.status = 'active';
    const lines = [`${state.players[pending.player].name}选择不在途经商店停留，继续赶路。`];
    lines.push(...(await resolveMoveDestination(
      state,
      pending.player,
      pending.from,
      pending.destination,
      chapter,
      items,
      rng,
      pending.reason,
    )));
    text = lines.join('\n\n');
  } else if (input.action === 'start_next_chapter') {
    if (state.status !== 'chapter_complete') throw new Error('The current chapter is not complete yet.');
    const nextId = NEXT_CHAPTER[state.chapterId];
    if (!nextId) throw new Error('No playable next chapter is available in this version.');
    const nextChapter = await loadChapter(nextId);
    state.chapterId = nextId;
    state.version = GAME_VERSION;
    state.status = 'active';
    state.currentPlayer = 'human';
    state.pendingScene = undefined;
    state.pendingShop = undefined;
    state.pendingRoll = undefined;
    state.pendingPassShop = undefined;
    state.firstFinisher = undefined;
    state.resolvedScenes = [];
    state.lastInteractiveUse = undefined;
    for (const id of ['human', 'ai'] as PlayerId[]) {
      const player = state.players[id];
      player.position = 1;
      player.finished = false;
      player.effects.nextMoveBonus = 0;
      player.effects.nextRollDelta = 0;
      player.effects.rerollReady = false;
      player.effects.cancelNextAdverse = false;
      player.effects.antidote = 0;
      player.effects.forcedNextRoll = undefined;
    }
    text = `【进入${nextChapter.name}】${nextChapter.opening.text}

双方从第1格【${getCell(nextChapter, 1).title}】重新出发。银两、身份、收藏品与未使用道具继续保留；跨章时清除上一章尚未结算的临时移动/骰点效果。默认仍由人类玩家先手。`;
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

    if (option.kind === 'engrave') {
      if (!input.targetItemId || !input.customText?.trim()) throw new Error('Engraving requires targetItemId and customText.');
      const target = singleItemEntry(player, input.targetItemId);
      if (target.engraving) throw new Error('That item has already been engraved. Engraving cannot be undone.');
      target.engraving = input.customText.trim();
    }

    player.money -= option.cost;
    const lines = [`${player.name}选择：${option.label}`, `银两剩余：${player.money}两。`];
    state.pendingShop = undefined;
    state.status = 'active';

    if (option.kind === 'item' && option.item_id) {
      addItem(player, option.item_id);
      const def = items.find((entry) => entry.id === option.item_id);
      if (def?.interaction?.auto_wear_on_purchase && !player.wornItems.includes(def.id)) {
        player.wornItems.push(def.id);
      }
      lines.push(`获得道具【${def?.name ?? option.item_id}】。`);
      if (def?.purchase_text) lines.push(def.purchase_text);
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
    } else if (option.kind === 'engrave') {
      const def = items.find((entry) => entry.id === input.targetItemId);
      lines.push('铁匠抬头问你刻什么，你说了，铁匠面无表情地刻完了。她上班这么多年什么都见过。');
      lines.push(`【${def?.name ?? input.targetItemId}】永久刻字：「${input.customText!.trim()}」`);
    }

    if (state.status === 'active') advanceTurn(state, pending.player);
    text = lines.join('\n\n');
  } else if (input.action === 'use_item') {
    const playerId = input.player ?? state.currentPlayer;
    const player = state.players[playerId];
    if (!input.itemId) throw new Error('use_item requires itemId.');
    if (itemCount(player, input.itemId) < 1) throw new Error('Item not in inventory.');
    const def = items.find((entry) => entry.id === input.itemId);
    if (!def) throw new Error('Unknown item.');
    const hasMechanicalEffect = Object.keys(def.effect).length > 0;

    if (hasMechanicalEffect) {
      if (state.status !== 'active') throw new Error('Mechanical items can only be used between scenes, before rolling.');
      if (playerId !== state.currentPlayer) throw new Error('Only the current player may use a mechanical item.');
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
      if (def.effect.choose_next_roll) {
        if (!Number.isInteger(input.chosenRoll) || input.chosenRoll! < 1 || input.chosenRoll! > 6) {
          throw new Error('上官昭容诗集需要 chosenRoll，且必须是1至6之间的整数。');
        }
        player.effects.forcedNextRoll = input.chosenRoll;
        notes.push(`下一次d6基础点数指定为 ${input.chosenRoll}`);
      }
      if (def.consumable) removeItem(player, input.itemId);
      state.lastInteractiveUse = undefined;
      text = `使用道具【${def.name}】。${notes.join('；')}`;
    } else {
      if (state.status !== 'active' && state.status !== 'awaiting_scene') {
        throw new Error('Interactive items can be used during normal play or a roleplay scene.');
      }
      const interaction = def.interaction;
      const requestedTarget = input.targetPlayer;
      let targetPlayer: PlayerId = playerId;
      if (interaction?.use_target === 'partner') targetPlayer = requestedTarget ?? otherPlayer(playerId);
      else if (interaction?.use_target === 'either') targetPlayer = requestedTarget ?? playerId;
      else if (requestedTarget) targetPlayer = requestedTarget;
      if (interaction?.use_target === 'self' && targetPlayer !== playerId) throw new Error('This item is self-use only.');
      if (interaction?.use_target === 'partner' && targetPlayer === playerId) throw new Error('This item must target the other player.');

      if (def.id === 'pig_spray') {
        const entry = player.inventory.find((candidate) => candidate.itemId === def.id)!;
        const form = entry.variant?.trim() || '猪';
        const target = state.players[targetPlayer];
        const formText = form === '猪' ? '超级可爱的粉色迷你猪' : `超级可爱的迷你${form}`;
        text = `${player.name}对${target.name}使用了【${entry.variant ? `变${form}喷雾` : '变猪喷雾'}】。${target.name}暂时变成了${formText}，时效半个时辰。这个变化只影响角色扮演，不改变位置、骰点或固定剧情结算。`;
        const previous = state.lastInteractiveUse;
        if (previous?.itemId === 'pig_spray' && previous.player === targetPlayer && previous.targetPlayer === playerId) {
          text += '\n\n【系统提示】亲密度↑\n（本游戏并不存在亲密度数值，请自行体会。）';
          state.lastInteractiveUse = undefined;
        } else {
          state.lastInteractiveUse = { player: playerId, itemId: def.id, targetPlayer };
        }
      } else {
        const targetPrefix = targetPlayer !== playerId ? `${player.name}对${state.players[targetPlayer].name}使用【${def.name}】。` : `${player.name}使用【${def.name}】。`;
        text = `${targetPrefix}${interaction?.use_text ?? '该道具没有固定机械效果，可自由纳入当前角色扮演。'}`;
        state.lastInteractiveUse = { player: playerId, itemId: def.id, targetPlayer };
      }
      if (def.consumable) removeItem(player, input.itemId);
    }
  } else if (input.action === 'wear_item') {
    if (state.status !== 'active' && state.status !== 'awaiting_scene') throw new Error('Items can only be worn during normal play or a roleplay scene.');
    const playerId = input.player ?? state.currentPlayer;
    const player = state.players[playerId];
    if (!input.itemId || itemCount(player, input.itemId) < 1) throw new Error('wear_item requires an owned itemId.');
    const def = items.find((entry) => entry.id === input.itemId);
    if (!def?.interaction?.wearable) throw new Error('That item is not wearable.');
    if (player.wornItems.includes(def.id)) {
      player.wornItems = player.wornItems.filter((id) => id !== def.id);
      text = `${player.name}摘下了【${def.name}】。`;
    } else {
      player.wornItems.push(def.id);
      text = `${player.name}戴上了【${def.name}】。${def.interaction.wear_text ?? ''}`.trim();
    }
  } else if (input.action === 'gift_item') {
    if (state.status !== 'active' && state.status !== 'awaiting_scene') throw new Error('Items can only be gifted during normal play or a roleplay scene.');
    const playerId = input.player ?? state.currentPlayer;
    const targetPlayer = input.targetPlayer ?? otherPlayer(playerId);
    if (targetPlayer === playerId) throw new Error('gift_item target must be the other player.');
    if (!input.itemId) throw new Error('gift_item requires itemId.');
    const from = state.players[playerId];
    const to = state.players[targetPlayer];
    if (itemCount(from, input.itemId) < 1) throw new Error('Item not in inventory.');
    const def = items.find((entry) => entry.id === input.itemId);
    if (!def) throw new Error('Unknown item.');
    if (def.interaction?.giftable === false) throw new Error('That item cannot be gifted.');
    const moved = giftOneItem(from, to, input.itemId);
    const details = [moved.variant ? `定制：变${moved.variant}` : '', moved.engraving ? `刻字：${moved.engraving}` : ''].filter(Boolean);
    text = `${from.name}把【${def.name}】送给了${to.name}${details.length ? `（${details.join('；')}）` : ''}。`;
  } else if (input.action === 'customize_item') {
    if (state.status !== 'active' && state.status !== 'awaiting_scene') throw new Error('Items can only be customized during normal play or a roleplay scene.');
    const playerId = input.player ?? state.currentPlayer;
    const player = state.players[playerId];
    if (!input.itemId || itemCount(player, input.itemId) < 1) throw new Error('customize_item requires an owned itemId.');
    const def = items.find((entry) => entry.id === input.itemId);
    if (!def?.interaction?.customizable) throw new Error('That item does not support customization.');
    let custom = input.customText?.trim() ?? '';
    if (!custom) throw new Error('customize_item requires customText.');
    custom = custom.replace(/^变/, '').replace(/喷雾$/, '').trim();
    if (!custom) throw new Error('Please provide an animal or transformation name.');
    const cost = def.interaction.customize_cost ?? 0;
    if (player.money < cost) throw new Error(`Not enough money. Need ${cost}, have ${player.money}.`);
    player.money -= cost;
    const entry = singleItemEntry(player, input.itemId);
    entry.variant = custom;
    text = `你额外支付${cost}两，传信至天庭。养猪仙女在百忙之中回信：特别款【变${custom}喷雾】定制完成。\n\n银两剩余：${player.money}两。`;
  } else {
    throw new Error(`Unsupported action: ${String(input.action)}`);
  }

  appendLog(state, text);
  await saveState(state);
  return { state, text };
}

export async function summarizeGame(sessionId: string): Promise<string> {
  const state = normalizeLoadedState(await loadState(sessionId));
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
  if (state.pendingPassShop) {
    const labels = state.pendingPassShop.shopPositions.map((position) => {
      const cell = getCell(chapter, position);
      return `第${position}格【${cell.title}】`;
    });
    lines.push(`待决定是否途经停店：${labels.join('、')}；也可全部跳过继续到第${state.pendingPassShop.destination}格`);
  }
  return lines.join('\n');
}

export async function chapterOverview(): Promise<string> {
  const chapters = await Promise.all(['zhongyuan', 'saibei'].map((id) => loadChapter(id)));
  return chapters
    .map((chapter) => {
      const counts = chapter.cells.reduce<Record<string, number>>((acc, cell) => {
        const key = cell.type === 'finale' ? 'scene' : cell.type;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      return `${chapter.name}｜${chapter.length}格｜江湖场景${counts.scene ?? 0}｜轻事件${counts.light ?? 0}｜功能格${counts.shop ?? 0}｜特殊地标${counts.landmark ?? 0}｜节奏格${counts.rhythm ?? 0}`;
    })
    .join('\n');
}
