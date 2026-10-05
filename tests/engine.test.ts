import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rm } from 'node:fs/promises';
import { gameAction, getGameState, newGame, roll } from '../src/engine/game.js';
import { saveState } from '../src/engine/store.js';

const sessions = ['test_scene', 'test_shop', 'test_special', 'test_finale'];

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
  const optionalSkipped = await roll('test_scene', () => 6); // human 3 -> 9; optional scene 8 does not intercept
  assert.equal(optionalSkipped.state.players.human.position, 9);
  assert.equal(optionalSkipped.state.status, 'awaiting_shop');
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
