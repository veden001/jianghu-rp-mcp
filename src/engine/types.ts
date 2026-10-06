export type PlayerId = 'human' | 'ai';
export type IdentityMode = 'select' | 'random';
export type GameStatus = 'setup' | 'active' | 'awaiting_scene' | 'awaiting_shop' | 'awaiting_pass_shop' | 'awaiting_roll_choice' | 'chapter_complete';

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
  choose_next_roll?: boolean;
}

export interface ItemInteraction {
  usable?: boolean;
  wearable?: boolean;
  giftable?: boolean;
  use_target?: 'self' | 'partner' | 'either';
  use_text?: string;
  wear_text?: string;
  customizable?: boolean;
  customize_cost?: number;
  auto_wear_on_purchase?: boolean;
}

export interface ItemDefinition {
  id: string;
  name: string;
  description: string;
  consumable: boolean;
  collectible?: boolean;
  purchase_text?: string;
  interaction?: ItemInteraction;
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
  kind: 'item' | 'effect' | 'inspect' | 'identify' | 'engrave' | 'leave';
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
  interaction_hook?: string;
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
  scene_mode?: 'core' | 'optional';
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
  same_space_hooks?: string[];
  cells: Cell[];
}

export interface InventoryEntry {
  itemId: string;
  count: number;
  engraving?: string;
  variant?: string;
}

export interface PlayerEffects {
  nextMoveBonus: number;
  nextRollDelta: number;
  rerollReady: boolean;
  cancelNextAdverse: boolean;
  antidote: number;
  forcedNextRoll?: number;
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
  wornItems: string[];
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

export interface PendingPassShop {
  player: PlayerId;
  from: number;
  destination: number;
  shopPositions: number[];
  reason: string;
}

export interface GameLogEntry {
  at: string;
  message: string;
}

export interface InteractiveUseRecord {
  player: PlayerId;
  itemId: string;
  targetPlayer?: PlayerId;
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
  pendingPassShop?: PendingPassShop;
  firstFinisher?: PlayerId;
  setupPendingDisguises: PlayerId[];
  resolvedScenes: number[];
  lastInteractiveUse?: InteractiveUseRecord;
  log: GameLogEntry[];
}
