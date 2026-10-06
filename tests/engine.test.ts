import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rm } from 'node:fs/promises';
import { gameAction, getGameState, newGame, roll } from '../src/engine/game.js';
import { saveState } from '../src/engine/store.js';
import { loadChapter } from '../src/engine/content.js';

const sessions = [
  'test_scene',
  'test_shop',
  'test_special',
  'test_finale',
  'test_same_space',
  'test_poetry',
  'test_toys',
  'test_engrave',
  'test_chapter_transition',
  'test_saibei_scene',
  'test_saibei_finale',
  'test_pass_shop_multiple',
  'test_saibei_shop_items',
  'test_jiangnan_transition',
  'test_jiangnan_finale',
];

after(async () => {
  await Promise.all(
    sessions.map((id) => rm(new URL(`../.data/${id}.json`, import.meta.url), { force: true })),
  );
});

test('roleplay scene pauses the board until fixed resolution is completed', async () => {
  await newGame({
    sessionId: 'test_scene',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'assassin',
  });

  const landed = await roll('test_scene', () => 6); // would be 1 -> 7, but core scene at 3 intercepts
  assert.equal(landed.state.status, 'awaiting_scene');
  assert.equal(landed.state.players.human.position, 3);
  assert.match(landed.text, /核心场景/);

  const resolved = await gameAction({ sessionId: 'test_scene', action: 'complete_scene' });
  assert.equal(resolved.state.status, 'active');
  assert.equal(resolved.state.currentPlayer, 'ai');
  assert.deepEqual(resolved.state.resolvedScenes, [3]);
  assert.match(resolved.text, /固定结算/);

  const next = await roll('test_scene', () => 6); // AI skips resolved scene 3, then stops at core scene 6
  assert.equal(next.state.status, 'awaiting_scene');
  assert.equal(next.state.players.ai.position, 6);

  await gameAction({ sessionId: 'test_scene', action: 'complete_scene' });
  const optionalSkipped = await roll('test_scene', () => 6); // human 3 -> 9; optional scene 8 does not intercept, but shop 4 is passed
  assert.equal(optionalSkipped.state.players.human.position, 3);
  assert.equal(optionalSkipped.state.status, 'awaiting_pass_shop');
  assert.deepEqual(optionalSkipped.state.pendingPassShop?.shopPositions, [4]);

  const continued = await gameAction({ sessionId: 'test_scene', action: 'continue_move' });
  assert.equal(continued.state.players.human.position, 9);
  assert.equal(continued.state.status, 'awaiting_shop');
});

test('function cell deducts money and adds the selected item', async () => {
  await newGame({
    sessionId: 'test_shop',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });

  const prepared = await getGameState('test_shop');
  prepared.players.human.position = 3;
  prepared.resolvedScenes = [3];
  await saveState(prepared);

  const landed = await roll('test_shop', () => 1); // 3 -> 4
  assert.equal(landed.state.status, 'awaiting_shop');

  const bought = await gameAction({
    sessionId: 'test_shop',
    action: 'buy',
    optionId: 'buy_fast_boots',
  });
  assert.equal(bought.state.players.human.money, 18);
  assert.equal(bought.state.players.human.inventory.find((x) => x.itemId === 'fast_boots')?.count, 1);
});

test('special immortal identity is random-only and requires an ordinary disguise', async () => {
  const created = await newGame(
    {
      sessionId: 'test_special',
      humanIdentityMode: 'random',
      aiIdentityMode: 'random',
    },
    () => 15,
  );
  assert.equal(created.state.players.human.identity.id, 'immortal');
  assert.equal(created.state.status, 'setup');

  await gameAction({
    sessionId: 'test_special',
    action: 'choose_disguise',
    player: 'human',
    disguiseIdentityId: 'commoner',
  });
  const ready = await gameAction({
    sessionId: 'test_special',
    action: 'choose_disguise',
    player: 'ai',
    disguiseIdentityId: 'fortune_teller',
  });
  assert.equal(ready.state.status, 'active');
});

test('first finisher gets the collectible and finale waits for both players', async () => {
  await newGame({
    sessionId: 'test_finale',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_finale');
  state.players.human.position = 35;
  state.players.ai.position = 35;
  state.currentPlayer = 'human';
  await saveState(state);

  const first = await roll('test_finale', () => 1);
  assert.equal(first.state.players.human.finished, true);
  assert.equal(first.state.currentPlayer, 'ai');
  assert.equal(first.state.players.human.inventory.some((x) => x.itemId === 'peony_token'), true);

  const second = await roll('test_finale', () => 1);
  assert.equal(second.state.status, 'awaiting_scene');
  assert.equal(second.state.pendingScene?.cellPosition, 36);

  const completed = await gameAction({ sessionId: 'test_finale', action: 'complete_scene' });
  assert.equal(completed.state.status, 'chapter_complete');
});

test('landing on the other player can produce a lightweight same-space interaction hook', async () => {
  await newGame({
    sessionId: 'test_same_space',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_same_space');
  state.players.human.position = 6;
  state.players.ai.position = 7;
  state.resolvedScenes = [3, 6];
  state.currentPlayer = 'human';
  await saveState(state);

  const landed = await roll('test_same_space', () => 1);
  assert.equal(landed.state.players.human.position, 7);
  assert.match(landed.text, /同格偶遇/);
});

test('Shangguan poetry collection can set the next d6 base result', async () => {
  await newGame({
    sessionId: 'test_poetry',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_poetry');
  state.players.human.position = 4;
  state.players.human.inventory.push({ itemId: 'shangguan_poems', count: 1 });
  state.resolvedScenes = [3, 6];
  state.currentPlayer = 'human';
  await saveState(state);

  const used = await gameAction({
    sessionId: 'test_poetry',
    action: 'use_item',
    player: 'human',
    itemId: 'shangguan_poems',
    chosenRoll: 5,
  });
  assert.equal(used.state.players.human.effects.forcedNextRoll, 5);
  assert.equal(used.state.players.human.inventory.some((x) => x.itemId === 'shangguan_poems'), false);

  const rolled = await roll('test_poetry', () => 1);
  assert.match(rolled.text, /指定基础点数 5/);
  assert.equal(rolled.state.players.human.position, 9);
});

test('interactive toys can be customized, used reciprocally, worn and gifted without changing hard outcomes', async () => {
  await newGame({
    sessionId: 'test_toys',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_toys');
  state.players.human.inventory.push({ itemId: 'pig_spray', count: 1 }, { itemId: 'nuo_mask', count: 1 });
  state.players.ai.inventory.push({ itemId: 'pig_spray', count: 1 });
  await saveState(state);

  const customized = await gameAction({
    sessionId: 'test_toys',
    action: 'customize_item',
    player: 'human',
    itemId: 'pig_spray',
    customText: '猫',
  });
  assert.equal(customized.state.players.human.money, 27);
  assert.equal(customized.state.players.human.inventory.find((x) => x.itemId === 'pig_spray')?.variant, '猫');

  const firstSpray = await gameAction({
    sessionId: 'test_toys',
    action: 'use_item',
    player: 'human',
    targetPlayer: 'ai',
    itemId: 'pig_spray',
  });
  assert.match(firstSpray.text, /迷你猫/);

  const reciprocal = await gameAction({
    sessionId: 'test_toys',
    action: 'use_item',
    player: 'ai',
    targetPlayer: 'human',
    itemId: 'pig_spray',
  });
  assert.match(reciprocal.text, /亲密度↑/);
  assert.match(reciprocal.text, /不存在亲密度数值/);

  const worn = await gameAction({ sessionId: 'test_toys', action: 'wear_item', player: 'human', itemId: 'nuo_mask' });
  assert.equal(worn.state.players.human.wornItems.includes('nuo_mask'), true);

  const gifted = await gameAction({ sessionId: 'test_toys', action: 'gift_item', player: 'human', targetPlayer: 'ai', itemId: 'nuo_mask' });
  assert.equal(gifted.state.players.human.wornItems.includes('nuo_mask'), false);
  assert.equal(gifted.state.players.ai.inventory.some((x) => x.itemId === 'nuo_mask'), true);
});

test('blacksmith engraving permanently annotates an owned item', async () => {
  await newGame({
    sessionId: 'test_engrave',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_engrave');
  state.players.human.position = 24;
  state.players.human.inventory.push({ itemId: 'gold_buyao', count: 1 });
  state.status = 'awaiting_shop';
  state.pendingShop = { cellPosition: 24, player: 'human' };
  state.currentPlayer = 'human';
  await saveState(state);

  const engraved = await gameAction({
    sessionId: 'test_engrave',
    action: 'buy',
    optionId: 'engrave_item',
    targetItemId: 'gold_buyao',
    customText: '同行千里',
  });
  assert.equal(engraved.state.players.human.money, 27);
  assert.equal(engraved.state.players.human.inventory.find((x) => x.itemId === 'gold_buyao')?.engraving, '同行千里');
  assert.match(engraved.text, /不可撤销|永久刻字/);
});


test('chapter transition carries persistent character state into Saibei and resets board state', async () => {
  await newGame({
    sessionId: 'test_chapter_transition',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_chapter_transition');
  state.status = 'chapter_complete';
  state.chapterId = 'zhongyuan';
  state.players.human.money = 17;
  state.players.human.inventory.push({ itemId: 'gold_buyao', count: 1 });
  state.players.human.position = 36;
  state.players.ai.position = 36;
  state.players.human.finished = true;
  state.players.ai.finished = true;
  state.firstFinisher = 'human';
  state.resolvedScenes = [3, 6, 16, 22, 27, 33, 36];
  state.players.human.effects.nextRollDelta = 2;
  await saveState(state);

  const next = await gameAction({ sessionId: 'test_chapter_transition', action: 'start_next_chapter' });
  assert.equal(next.state.chapterId, 'saibei');
  assert.equal(next.state.status, 'active');
  assert.equal(next.state.players.human.position, 1);
  assert.equal(next.state.players.ai.position, 1);
  assert.equal(next.state.players.human.finished, false);
  assert.equal(next.state.players.human.money, 17);
  assert.equal(next.state.players.human.inventory.some((x) => x.itemId === 'gold_buyao'), true);
  assert.equal(next.state.players.human.effects.nextRollDelta, 0);
  assert.deepEqual(next.state.resolvedScenes, []);
  assert.match(next.text, /第二章：塞北逐剑/);
  assert.match(next.text, /消息比剑更快|照骨剑一夜过黄河/);
});

test('Saibei uses the same core/optional scene interception rules', async () => {
  await newGame({
    sessionId: 'test_saibei_scene',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_saibei_scene');
  state.chapterId = 'saibei';
  state.players.human.position = 1;
  state.players.ai.position = 1;
  state.currentPlayer = 'human';
  state.resolvedScenes = [];
  await saveState(state);

  const core = await roll('test_saibei_scene', () => 6);
  assert.equal(core.state.players.human.position, 3);
  assert.equal(core.state.status, 'awaiting_scene');
  assert.match(core.text, /风里的一根绳/);

  await gameAction({ sessionId: 'test_saibei_scene', action: 'complete_scene' });
  const after = await getGameState('test_saibei_scene');
  after.players.human.position = 3;
  after.players.ai.position = 3;
  after.currentPlayer = 'human';
  after.resolvedScenes = [3];
  await saveState(after);
  const optionalSkipped = await roll('test_saibei_scene', () => 6); // 3 -> 9; optional 6/8 do not intercept, shop 4 is passed
  assert.equal(optionalSkipped.state.players.human.position, 3);
  assert.equal(optionalSkipped.state.status, 'awaiting_pass_shop');
  assert.deepEqual(optionalSkipped.state.pendingPassShop?.shopPositions, [4]);

  const stopped = await gameAction({
    sessionId: 'test_saibei_scene',
    action: 'stop_at_shop',
    shopPosition: 4,
  });
  assert.equal(stopped.state.players.human.position, 4);
  assert.equal(stopped.state.status, 'awaiting_shop');
  assert.match(stopped.text, /北岸马市/);
});

test('Saibei finale awards its collectible and points toward Jiangnan', async () => {
  await newGame({
    sessionId: 'test_saibei_finale',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_saibei_finale');
  state.chapterId = 'saibei';
  state.players.human.position = 35;
  state.players.ai.position = 35;
  state.currentPlayer = 'human';
  state.resolvedScenes = [3, 11, 16, 22, 27, 33];
  await saveState(state);

  const first = await roll('test_saibei_finale', () => 1);
  assert.equal(first.state.players.human.inventory.some((x) => x.itemId === 'saibei_horse_bell'), true);
  const second = await roll('test_saibei_finale', () => 1);
  assert.equal(second.state.status, 'awaiting_scene');
  const completed = await gameAction({ sessionId: 'test_saibei_finale', action: 'complete_scene' });
  assert.equal(completed.state.status, 'chapter_complete');
  assert.match(completed.text, /一枝梅花/);
  assert.match(completed.text, /可待/);
  assert.match(completed.text, /江南终局/);
});


test('passing multiple function cells lets the player choose exactly one shop or skip them all', async () => {
  await newGame({
    sessionId: 'test_pass_shop_multiple',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_pass_shop_multiple');
  state.players.human.position = 19;
  state.players.ai.position = 10;
  state.currentPlayer = 'human';
  state.resolvedScenes = [3, 6, 16, 22];
  await saveState(state);

  const passed = await roll('test_pass_shop_multiple', () => 6); // 19 -> 25, passing shops 20 and 24
  assert.equal(passed.state.status, 'awaiting_pass_shop');
  assert.equal(passed.state.players.human.position, 19);
  assert.deepEqual(passed.state.pendingPassShop?.shopPositions, [20, 24]);
  assert.match(passed.text, /第20格【山间酒肆】/);
  assert.match(passed.text, /第24格【老铁匠铺】/);

  const stopped = await gameAction({
    sessionId: 'test_pass_shop_multiple',
    action: 'stop_at_shop',
    player: 'human',
    shopPosition: 24,
  });
  assert.equal(stopped.state.status, 'awaiting_shop');
  assert.equal(stopped.state.players.human.position, 24);
  assert.equal(stopped.state.pendingPassShop, undefined);

  const left = await gameAction({
    sessionId: 'test_pass_shop_multiple',
    action: 'buy',
    optionId: 'leave',
  });
  assert.equal(left.state.status, 'active');
  assert.equal(left.state.currentPlayer, 'ai');
  assert.equal(left.state.players.human.position, 24);
});

test('Saibei interactive shop items are purchasable and purchase text/state are preserved', async () => {
  await newGame({
    sessionId: 'test_saibei_shop_items',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });
  const state = await getGameState('test_saibei_shop_items');
  state.chapterId = 'saibei';
  state.players.human.position = 20;
  state.players.human.money = 30;
  state.currentPlayer = 'human';
  state.status = 'awaiting_shop';
  state.pendingShop = { cellPosition: 20, player: 'human' };
  await saveState(state);

  const gloves = await gameAction({
    sessionId: 'test_saibei_shop_items',
    action: 'buy',
    optionId: 'buy_ugly_fur_gloves',
  });
  assert.equal(gloves.state.players.human.money, 28);
  assert.equal(gloves.state.players.human.inventory.some((x) => x.itemId === 'ugly_fur_gloves'), true);
  assert.equal(gloves.state.players.human.wornItems.includes('ugly_fur_gloves'), true);
  assert.match(gloves.text, /丑。但是暖和/);
});


test('Jiangnan map keeps the 36-cell chapter structure and six core scenes', async () => {
  const chapter = await loadChapter('jiangnan');
  assert.equal(chapter.length, 36);
  assert.equal(chapter.cells.length, 36);
  assert.deepEqual(chapter.cells.map((cell) => cell.position), Array.from({ length: 36 }, (_, index) => index + 1));

  const counts = chapter.cells.reduce<Record<string, number>>((acc, cell) => {
    const key = cell.type === 'finale' ? 'scene' : cell.type;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  assert.equal(counts.scene, 14);
  assert.equal(counts.light, 8);
  assert.equal(counts.shop, 6);
  assert.equal(counts.landmark, 4);
  assert.equal(counts.rhythm, 4);

  const core = chapter.cells
    .filter((cell) => cell.type === 'scene' && cell.scene_mode === 'core')
    .map((cell) => cell.position);
  assert.deepEqual(core, [14, 25, 29, 33, 34, 35]);
});

test('Saibei can transition into Jiangnan and preserve persistent player state', async () => {
  await newGame({
    sessionId: 'test_jiangnan_transition',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });

  const state = await getGameState('test_jiangnan_transition');
  state.chapterId = 'saibei';
  state.status = 'chapter_complete';
  state.players.human.money = 19;
  state.players.human.inventory.push({ itemId: 'saibei_horse_bell', count: 1 });
  state.players.human.position = 36;
  state.players.ai.position = 36;
  state.players.human.finished = true;
  state.players.ai.finished = true;
  state.resolvedScenes = [3, 11, 16, 22, 27, 33, 36];
  await saveState(state);

  const next = await gameAction({ sessionId: 'test_jiangnan_transition', action: 'start_next_chapter' });
  assert.equal(next.state.chapterId, 'jiangnan');
  assert.equal(next.state.status, 'active');
  assert.equal(next.state.players.human.position, 1);
  assert.equal(next.state.players.ai.position, 1);
  assert.equal(next.state.players.human.money, 19);
  assert.equal(next.state.players.human.inventory.some((x) => x.itemId === 'saibei_horse_bell'), true);
  assert.match(next.text, /第三章：江南终局/);
  assert.match(next.text, /苏州城里|姑苏/);
});

test('Jiangnan finale awards its collectible and ends the full game', async () => {
  await newGame({
    sessionId: 'test_jiangnan_finale',
    humanIdentityMode: 'select',
    humanIdentityId: 'commoner',
    aiIdentityMode: 'select',
    aiIdentityId: 'escort',
  });

  const state = await getGameState('test_jiangnan_finale');
  state.chapterId = 'jiangnan';
  state.players.human.position = 35;
  state.players.ai.position = 35;
  state.currentPlayer = 'human';
  state.resolvedScenes = [14, 25, 29, 33, 34, 35];
  await saveState(state);

  const first = await roll('test_jiangnan_finale', () => 1);
  assert.equal(first.state.players.human.inventory.some((x) => x.itemId === 'jiangnan_plum_note'), true);

  const second = await roll('test_jiangnan_finale', () => 1);
  assert.equal(second.state.status, 'awaiting_scene');
  assert.equal(second.state.pendingScene?.cellPosition, 36);

  const completed = await gameAction({ sessionId: 'test_jiangnan_finale', action: 'complete_scene' });
  assert.equal(completed.state.status, 'chapter_complete');
  assert.match(completed.text, /慕容镜/);
  assert.match(completed.text, /再也没有出过鞘/);
  assert.match(completed.text, /江湖棋局/);
  assert.match(completed.text, /当前可玩章节已全部完成/);
});
