import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from 'agents/mcp';
import { Hono } from 'hono';
import { registerHealthTools } from './tools/health.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerCodeTools } from './tools/code.js';
import { registerQualityTools } from './tools/quality.js';
import { registerSessionTools } from './tools/session.js';
import { validateApiKey } from './middleware/auth.js';
const app = new Hono();
// Health endpoint (no auth required)
app.get('/health', (c) => {
    return c.json({
        status: 'healthy',
        service: 'hub-mcp',
        version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
        timestamp: new Date().toISOString(),
    });
});
// Session Start endpoint (REST)
app.post('/session/start', async (c) => {
    const auth = await validateApiKey(c.req.raw, c.env);
    if (!auth.valid)
        return c.json({ error: auth.error }, 401);
    const sessionData = await c.req.json();
    return c.json({
        session_id: `sess_${Math.random().toString(36).substr(2, 9)}`,
        status: 'active',
        repo: sessionData.repo,
        mission_brief: 'Refined Phase 6 objectives loaded. SOLID and Clean Architecture enforced.',
    });
});
// Root endpoint — server info
app.get('/', (c) => {
    return c.json({
        name: 'Cortex Hub MCP Server',
        version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
        mcp: '/mcp',
        health: '/health',
        tools: [
            'cortex.health',
            'cortex.memory.store',
            'cortex.memory.search',
            'cortex.knowledge.search',
            'cortex.code.search',
            'cortex.code.impact',
            'cortex.quality.report',
            'cortex.session.start'
        ],
    });
});
// MCP endpoint — requires auth
app.all('/mcp', (c) => {
    const url = new URL(c.req.url);
    if (!url.pathname.endsWith('/')) {
        return c.redirect(url.pathname + '/');
    }
    return c.notFound();
});
app.all('/mcp/*', async (c) => {
    // Validate API key
    const auth = await validateApiKey(c.req.raw, c.env);
    if (!auth.valid) {
        return c.json({ error: auth.error }, 401);
    }
    // Create stateless MCP Server & Handler for this request
    const server = new McpServer({
        name: c.env.MCP_SERVER_NAME ?? 'cortex-hub',
        version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
    });
    // Register tools
    registerHealthTools(server, c.env);
    registerMemoryTools(server, c.env);
    registerKnowledgeTools(server, c.env);
    registerCodeTools(server, c.env);
    registerQualityTools(server, c.env);
    registerSessionTools(server, c.env);
    const mcpHandler = createMcpHandler(server);
    return mcpHandler(c.req.raw, c.env, c.executionCtx);
});
export default app;
//# sourceMappingURL=index.js.map