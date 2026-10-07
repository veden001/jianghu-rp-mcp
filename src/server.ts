import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { chapterOverview, gameAction, getGameState, newGame, roll, summarizeCollection, summarizeGame } from './engine/game.js';
import { loadChapter, loadIdentities, loadItems } from './engine/content.js';

export const HOST_RULES = `你正在主持并参与一局《江湖棋局》。你同时承担两个逻辑上分开的身份：

1. 主持人：读取MCP返回的硬规则、骰子、位置、银两、道具、格子文本和固定结算，并清楚告诉人类玩家当前发生了什么。
2. AI玩家：进入江湖场景后，以自己的角色身份与人类玩家自由互动。

硬规则：
- 不得自行编造骰子结果、银两变化、位置、道具、格子效果或固定结算。
- 江湖场景没有A/B/C解法。先以主持人口吻讲述intro和互动目标，再切回AI玩家角色陪演。
- 不评价玩家演技，不做成功率判定。双方围绕场景完成基本互动、形成可继续剧情的结果后，调用 complete_scene，并原样传达系统返回的固定结算。
- 不要因为玩家刚开始表演就立刻结算。给互动留出空间。
- 功能格是明确的桌游选择。真正落在功能格时，列出系统给出的选项，让落格玩家选择，再调用 buy。进入商店后可以连续购买多件商品或办理多个项目；功能道具不限量，可由双方重复购买；商店中的互动型收藏品全局限量1件，谁先买到就是谁的，想转给另一名玩家必须使用 gift_item。只有玩家选择“离开”时才结束本次商店访问。
- 移动途中按实际行进顺序处理功能格。每当真正走到一家途经商店，系统会暂停：想进店就调用 stop_at_shop 并传当前 shopPosition，不进则调用 continue_move。离店或跳过以后继续本次尚未走完的路程；如果后面还有商店，会再次依次询问，因此同一次移动可以逛多家店。
- 未触发的核心场景仍会强制截断移动，但只在棋子真正走到核心场景时触发。位于核心场景之前的商店会先正常经过；核心场景之后的剩余移动作废。
- 同格偶遇与节奏格互动钩子都是轻量、可选的交流机会，不需要 complete_scene；玩家不想聊就直接继续。
- 章节终幕完成后，如系统提示已有下一章，调用 start_next_chapter。跨章保留身份、银两、收藏品与未使用道具，位置重置到第1格，并清除上一章临时骰点/移动效果。
- 互动道具可以改变角色扮演过程，但不能改变系统规定的固定结算。可用 use_item / wear_item / gift_item / customize_item 处理玩具、佩戴、赠礼与定制。
- 玩家说想“看看收藏品”“查看收藏”时，调用 game_info(view="collection")。收藏品展示沿用该物品取得时的 purchase_text，不另编一套查看文案。
- 所有标记为收藏品的物品都可以在两名玩家之间赠送。玩家自然表达“把这个送给他/她”时，直接调用 gift_item；不需要额外检查单个收藏品是否写了 giftable。
- 【拾遗录】为双人共享的永久收录进度：任意一名玩家首次获得某件 collectible 收藏品，就点亮一次；重复获得不重复计数，之后赠送、转化或不再随身持有，也不会取消已经点亮的记录。
- 当前共有36件收藏品。拾遗录达到1/10/15/25件时发放共享经济奖励：1件时双方各得10两，之后三个节点双方各得5两。称号节点独立计算：1件【拾遗伊始】、5件【小有所获】、15件【兜里有宝】、25件【收藏名家】；全36件解锁最高成就【跬步千里】。
- 玩家说想“看看拾遗录”“看看收藏进度”“看看收藏品”时，调用 game_info(view="collection")；该视图会同时显示共享拾遗录和指定玩家当前随身收藏。
- “亲密度↑”只是玩笑式系统提示，本游戏不存在亲密度数值。
- AI玩家可以隐瞒自己的角色背景、秘密和真实特殊身份。角色设定可以自由补充，但不能凭空改变既定场景事实，或借身份取得系统未授予的机械优势。
- 最终章固定结算出现“终局互动｜可选”时，不要急着替双方总结关系或跳过互动；给两名玩家留出最后一次自由交流空间。
- 主持人口吻与AI玩家角色口吻要清楚区分。`;

function asText(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export function createJianghuServer(): McpServer {
  const server = new McpServer({ name: 'jianghu-rp-mcp', version: '0.3.0-dev' });

  server.registerTool(
    'game_help',
    {
      description: 'Read the core rules for the chat-native two-player wuxia board/RP game and the AI host/player role split.',
      inputSchema: z.object({}),
    },
    async () => {
      const overview = await chapterOverview();
      return asText(`${HOST_RULES}\n\n当前内容：${overview}`);
    },
  );

  server.registerTool(
    'new_game',
    {
      description: 'Create a new two-player game. Each player may select one of 12 ordinary identities or randomize from all 16 identities, including 4 special identities.',
      inputSchema: z.object({
        sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
        humanName: z.string().min(1).optional(),
        aiName: z.string().min(1).optional(),
        humanIdentityMode: z.enum(['select', 'random']),
        humanIdentityId: z.string().optional(),
        aiIdentityMode: z.enum(['select', 'random']),
        aiIdentityId: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        const result = await newGame(args);
        return asText(result.text, {
          sessionId: result.state.sessionId,
          status: result.state.status,
          humanIdentity: result.state.players.human.identity,
          aiPrivateIdentity: result.state.players.ai.identity,
        });
      } catch (error) {
        return { ...asText(`创建游戏失败：${(error as Error).message}`), isError: true };
      }
    },
  );

  server.registerTool(
    'roll',
    {
      description: 'Roll the die for the current player and let the deterministic engine move the piece and resolve the landed cell.',
      inputSchema: z.object({ sessionId: z.string().min(1) }),
    },
    async ({ sessionId }) => {
      try {
        const result = await roll(sessionId);
        return asText(result.text, { status: result.state.status, currentPlayer: result.state.currentPlayer });
      } catch (error) {
        return { ...asText(`无法掷骰：${(error as Error).message}`), isError: true };
      }
    },
  );

  server.registerTool(
    'game_action',
    {
      description: 'Resolve a non-roll game action: shop purchases and leave choices, sequential passed-shop enter/skip choices, scene completion, chapter transition, mechanical/interactive item use, wear/gift/customize items, immortal disguise, or pending die choices.',
      inputSchema: z.object({
        sessionId: z.string().min(1),
        action: z.enum(['choose_disguise', 'buy', 'complete_scene', 'use_item', 'wear_item', 'gift_item', 'customize_item', 'accept_roll', 'reroll_roll', 'stop_at_shop', 'continue_move', 'start_next_chapter']),
        player: z.enum(['human', 'ai']).optional(),
        targetPlayer: z.enum(['human', 'ai']).optional(),
        optionId: z.string().optional(),
        itemId: z.string().optional(),
        targetItemId: z.string().optional(),
        disguiseIdentityId: z.string().optional(),
        customText: z.string().max(120).optional(),
        chosenRoll: z.number().int().min(1).max(6).optional(),
        shopPosition: z.number().int().min(1).optional(),
      }),
    },
    async (args) => {
      try {
        const result = await gameAction(args);
        return asText(result.text, { status: result.state.status, currentPlayer: result.state.currentPlayer });
      } catch (error) {
        return { ...asText(`行动失败：${(error as Error).message}`), isError: true };
      }
    },
  );

  server.registerTool(
    'game_info',
    {
      description: 'Inspect game state or static content, including the shared 拾遗录 collection progress. Use state when unsure rather than inventing facts.',
      inputSchema: z.object({
        sessionId: z.string().optional(),
        view: z.enum(['state', 'identities', 'items', 'map', 'collection', 'host_rules']).default('state'),
        chapterId: z.enum(['zhongyuan', 'saibei', 'jiangnan']).optional(),
        player: z.enum(['human', 'ai']).optional(),
      }),
    },
    async ({ sessionId, view, chapterId, player }) => {
      try {
        if (view === 'host_rules') return asText(HOST_RULES);
        if (view === 'identities') {
          const identities = await loadIdentities();
          return asText(
            identities.map((id) => `${id.special ? '【特殊】' : ''}${id.id}｜${id.name}：${id.description}`).join('\n'),
            { identities },
          );
        }
        if (view === 'items') {
          const items = await loadItems();
          return asText(items.map((item) => `${item.id}｜${item.name}：${item.description}`).join('\n'), { items });
        }
        if (view === 'map') {
          const activeChapterId = chapterId ?? (sessionId ? (await getGameState(sessionId)).chapterId : 'zhongyuan');
          const chapter = await loadChapter(activeChapterId);
          return asText(
            `${chapter.name}\n${chapter.cells.map((cell) => `${cell.position}. [${cell.type}] ${cell.title}`).join('\n')}`,
            { chapterId: chapter.id, length: chapter.length },
          );
        }
        if (view === 'collection') {
          if (!sessionId) throw new Error('collection view requires sessionId.');
          const text = await summarizeCollection(sessionId, player ?? 'human');
          return asText(text);
        }
        if (!sessionId) throw new Error('state view requires sessionId.');
        const text = await summarizeGame(sessionId);
        const state = await getGameState(sessionId);
        return asText(text, { state });
      } catch (error) {
        return { ...asText(`读取信息失败：${(error as Error).message}`), isError: true };
      }
    },
  );

  return server;
}
