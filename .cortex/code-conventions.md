# Code Conventions — Cortex Hub

## Naming

- **Variables & functions**: `camelCase`
- **Types & interfaces**: `PascalCase`
- **Files**: `kebab-case.ts` (packages), `camelCase.ts` (routes/services)
- **Constants**: `UPPER_SNAKE_CASE`

## TypeScript

- **Strict mode**: Always (`strict: true`, `noUncheckedIndexedAccess: true`)
- **No `any`**: Use `unknown` + type guards. If `any` is unavoidable, add a `// eslint-disable-next-line` comment explaining why
- **Type imports**: Use `import type { ... }` for type-only imports
- **Path aliases**: `@cortex/*` for shared packages

## Imports

```typescript
// 1. External packages
import { Hono } from 'hono'
import { z } from 'zod'

// 2. Shared packages
import { createLogger } from '@cortex/shared-utils'
import type { KnowledgeItem } from '@cortex/shared-types'

// 3. Local imports
import { db } from '../db/client.js'
```

## Error Handling

- All API routes: wrap in `try/catch`, return JSON error with status code
- MCP tools: return `{ isError: true, content: [{ type: 'text', text: '...' }] }`
- Never swallow errors silently — at minimum log them

## API Routes (Hono)

- One router per feature: `export const featureRouter = new Hono()`
- Register in `index.ts`: `app.route('/api/feature', featureRouter)`
- Validate required params early, return 400

## Database

- SQLite with WAL mode
- Use parameterized queries (no string interpolation in SQL)
- Schema in `src/db/schema.sql`, migrations in `src/db/client.ts`

## Frontend (Next.js)

- `'use client'` for interactive pages
- `useSWR` for data fetching (with `refreshInterval` for live data)
- CSS Modules (`.module.css`) — no CSS-in-JS
- Design tokens from `globals.css` (`var(--primary)`, `var(--bg-elevated)`, etc.)

## Quality Gates

Every commit must pass:
```bash
pnpm build && pnpm typecheck && pnpm lint
```

Every push must also pass:
```bash
pnpm test
```
