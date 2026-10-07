import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createJianghuServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST?.trim() || '0.0.0.0';
const MCP_TOKEN = process.env.MCP_TOKEN?.trim();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const mcpHandler = createMcpHandler(createJianghuServer);
const nodeHandler = toNodeHandler(mcpHandler);

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token || undefined;
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!MCP_TOKEN) return true;
  const supplied = bearerToken(req);
  return supplied !== undefined && tokenMatches(supplied, MCP_TOKEN);
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    json(res, 200, {
      ok: true,
      service: 'jianghu-rp-mcp',
      version: '0.3.0-dev',
      transport: 'streamable-http',
    });
    return;
  }

  if (url.pathname !== '/mcp') {
    json(res, 404, { error: 'Not found' });
    return;
  }

  if (!isAuthorized(req)) {
    res.setHeader('www-authenticate', 'Bearer');
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  void nodeHandler(req, res).catch((error: unknown) => {
    console.error('[remote-mcp] request failed:', error instanceof Error ? error.message : error);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
    else if (!res.writableEnded) res.end();
  });
});

httpServer.listen(PORT, HOST, () => {
  console.error(
    `jianghu-rp-mcp v0.3.0-dev remote MCP listening on http://${HOST}:${PORT}/mcp` +
      (MCP_TOKEN ? ' (Bearer token enabled)' : ' (WARNING: no MCP_TOKEN set)'),
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[remote-mcp] ${signal}: shutting down`);
  httpServer.close();
  await mcpHandler.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
