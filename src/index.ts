import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createJianghuServer } from './server.js';

void serveStdio(createJianghuServer);
console.error('jianghu-rp-mcp v0.3.0-dev running on stdio');
