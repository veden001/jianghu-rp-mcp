export type PlayerId = 'human' | 'ai';
export type IdentityMode = 'select' | 'random';
export type GameStatus = 'setup' | 'active' | 'awaiting_scene' | 'awaiting_shop' | 'awaiting_roll_choice' | 'chapter_complete';

export interface Identity {
  id: string;
  name: string;
  special: boolean;
  description: string;
  requires_disguise?: boolean;
}

export interface ItemEffect {
  next_move_bonus?: number;
  next_roll_bonus?: number;
  enable_reroll?: boolean;
  cancel_next_adverse?: boolean;
  antidote?: number;
}

export interface ItemDefinition {
  id: string;
  name: string;
  description: string;
  consumable: boolean;
  collectible?: boolean;
  effect: ItemEffect;
}

export interface MechanicalEffect {
  money_delta?: number;
  next_roll_delta?: number;
  move_immediate?: number;
  add_item?: string;
  lose_random_item?: boolean;
  clear_next_roll_penalty?: boolean;
}

export interface ShopOption {
  id: string;
  label: string;
  cost: number;
  kind: 'item' | 'effect' | 'inspect' | 'identify' | 'leave';
  item_id?: string;
  effect?: MechanicalEffect;
  distance?: number;
}

export interface BaseCell {
  position: number;
  type: 'landmark' | 'light' | 'scene' | 'shop' | 'rhythm' | 'finale';
  title: string;
}

export interface NarrativeCell extends BaseCell {
  type: 'landmark' | 'rhythm';
  text: string;
  effect?: MechanicalEffect;
}

export interface LightCell extends BaseCell {
  type: 'light';
  text: string;
  effect: MechanicalEffect;
  adverse?: boolean;
}

export interface SceneCell extends BaseCell {
  type: 'scene' | 'finale';
  intro: string;
  goal: string;
  resolution: string;
}

export interface ShopCell extends BaseCell {
  type: 'shop';
  text: string;
  options: ShopOption[];
}

export type Cell = NarrativeCell | LightCell | SceneCell | ShopCell;

export interface ChapterDefinition {
  id: string;
  name: string;
  theme: string;
  length: number;
  opening: { title: string; text: string };
  collectible: { item_id: string; award: 'first_finisher' };
  cells: Cell[];
}

export interface InventoryEntry {
  itemId: string;
  count: number;
}

export interface PlayerEffects {
  nextMoveBonus: number;
  nextRollDelta: number;
  rerollReady: boolean;
  cancelNextAdverse: boolean;
  antidote: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  identity: Identity;
  disguiseIdentityId?: string;
  money: number;
  position: number;
  finished: boolean;
  inventory: InventoryEntry[];
  effects: PlayerEffects;
}

export interface PendingScene {
  cellPosition: number;
  triggerPlayer: PlayerId;
}

export interface PendingShop {
  cellPosition: number;
  player: PlayerId;
}

export interface PendingRoll {
  player: PlayerId;
  die: number;
  rollDelta: number;
}

export interface GameLogEntry {
  at: string;
  message: string;
}

export interface GameState {
  sessionId: string;
  version: string;
  chapterId: string;
  status: GameStatus;
  currentPlayer: PlayerId;
  players: Record<PlayerId, PlayerState>;
  pendingScene?: PendingScene;
  pendingShop?: PendingShop;
  pendingRoll?: PendingRoll;
  firstFinisher?: PlayerId;
  setupPendingDisguises: PlayerId[];
  log: GameLogEntry[];
}
