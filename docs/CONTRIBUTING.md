# Contributing to Cortex Hub

> Guidelines for contributing code, knowledge, and documentation to the Cortex Hub project.

---

## Development Setup

```bash
# Clone the repository
git clone https://github.com/<org>/cortex-hub.git
cd cortex-hub

# Install dependencies
corepack enable
pnpm install

# Start development servers
pnpm dev
```

---

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Production-ready code |
| `develop` | Integration branch |
| `feat/<name>` | New features |
| `fix/<name>` | Bug fixes |
| `docs/<name>` | Documentation updates |

```bash
# Create a feature branch
git checkout -b feat/add-knowledge-search develop

# After work is complete
git push origin feat/add-knowledge-search
# Open PR → develop
```

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
```

| Type | Use Case |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `refactor` | Code restructuring |
| `test` | Adding or updating tests |
| `ci` | CI/CD changes |
| `chore` | Maintenance tasks |

**Examples:**
```
feat(hub-mcp): add code.impact tool with blast radius analysis
fix(dashboard-api): correct SQLite WAL mode initialization
docs(api): add rate limiting documentation
```

---

## Code Standards

- **TypeScript strict mode** — no `any` types without explicit justification
- **ESLint** — zero warnings policy
- **Prettier** — auto-format on save / pre-commit
- **Import from shared packages** — never duplicate shared logic

```typescript
// ✅ Good
import type { KnowledgeItem } from '@cortex/shared-types'
import { formatDate } from '@cortex/shared-utils'

// ❌ Bad — duplicating shared logic
function formatDate(d: Date) { /* ... */ }
```

---

## Pull Request Checklist

- [ ] Branch is up-to-date with `develop`
- [ ] All tests pass: `pnpm -r test`
- [ ] Types check: `pnpm -r typecheck`
- [ ] Lint clean: `pnpm -r lint`
- [ ] Conventional commit message
- [ ] Documentation updated (if applicable)
- [ ] No `TODO` or `FIXME` left in code

---

## Knowledge Contributions

Agents can contribute knowledge items automatically. Human reviewers approve contributions weekly:

1. Agent discovers a pattern → calls `knowledge.contribute()`
2. Item is stored with `approved: false`
3. Human reviews in Dashboard → Knowledge screen
4. Approved items become searchable by all agents

### Writing Knowledge Items

Good knowledge items are:
- **Specific** — "Cloudflare Pages requires `NODE_VERSION` env var" not just "deployment issues"
- **Actionable** — include the solution, not just the problem
- **Scoped** — tagged with project and domain
- **Confident** — set confidence ≥ 0.7 only if you're sure
