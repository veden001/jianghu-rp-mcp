import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { chapterOverview, gameAction, getGameState, newGame, roll, summarizeGame } from './engine/game.js';
import { loadChapter, loadIdentities, loadItems } from './engine/content.js';

const HOST_RULES = `你正在主持并参与一局《江湖棋局》。你同时承担两个逻辑上分开的身份：

1. 主持人：读取MCP返回的硬规则、骰子、位置、银两、道具、格子文本和固定结算，并清楚告诉人类玩家当前发生了什么。
2. AI玩家：进入江湖场景后，以自己的角色身份与人类玩家自由互动。

硬规则：
- 不得自行编造骰子结果、银两变化、位置、道具、格子效果或固定结算。
- 江湖场景没有A/B/C解法。先以主持人口吻讲述intro和互动目标，再切回AI玩家角色陪演。
- 不评价玩家演技，不做成功率判定。双方围绕场景完成基本互动、形成可继续剧情的结果后，调用 complete_scene，并原样传达系统返回的固定结算。
- 不要因为玩家刚开始表演就立刻结算。给互动留出空间。
- 功能格是明确的桌游选择。列出系统给出的选项，让落格玩家选择，再调用 buy。
- 同格偶遇与节奏格互动钩子都是轻量、可选的交流机会，不需要 complete_scene；玩家不想聊就直接继续。
- 互动道具可以改变角色扮演过程，但不能改变系统规定的固定结算。可用 use_item / wear_item / gift_item / customize_item 处理玩具、佩戴、赠礼与定制。
- “亲密度↑”只是玩笑式系统提示，本游戏不存在亲密度数值。
- AI玩家可以隐瞒自己的角色背景、秘密和真实特殊身份。角色设定可以自由补充，但不能凭空改变既定场景事实，或借身份取得系统未授予的机械优势。
- 主持人口吻与AI玩家角色口吻要清楚区分。`;

function asText(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'jianghu-rp-mcp', version: '0.1.2' });

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
      description: 'Resolve a non-roll game action: function-cell choices, scene completion, mechanical/interactive item use, wear/gift/customize items, immortal disguise, or pending die choices.',
      inputSchema: z.object({
        sessionId: z.string().min(1),
        action: z.enum(['choose_disguise', 'buy', 'complete_scene', 'use_item', 'wear_item', 'gift_item', 'customize_item', 'accept_roll', 'reroll_roll']),
        player: z.enum(['human', 'ai']).optional(),
        targetPlayer: z.enum(['human', 'ai']).optional(),
        optionId: z.string().optional(),
        itemId: z.string().optional(),
        targetItemId: z.string().optional(),
        disguiseIdentityId: z.string().optional(),
        customText: z.string().max(120).optional(),
        chosenRoll: z.number().int().min(1).max(6).optional(),
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
      description: 'Inspect game state or static content. Use state when unsure rather than inventing facts.',
      inputSchema: z.object({
        sessionId: z.string().optional(),
        view: z.enum(['state', 'identities', 'items', 'map', 'host_rules']).default('state'),
      }),
    },
    async ({ sessionId, view }) => {
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
          const chapter = await loadChapter('zhongyuan');
          return asText(
            `${chapter.name}\n${chapter.cells.map((cell) => `${cell.position}. [${cell.type}] ${cell.title}`).join('\n')}`,
            { chapterId: chapter.id, length: chapter.length },
          );
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

void serveStdio(createServer);
console.error('jianghu-rp-mcp v0.1.2 running on stdio');
