# Công nghệ

Lấy từ các file `package.json` và thư mục `infra/` trên `master`.

## Monorepo

| | |
|---|---|
| Trình quản lý gói | pnpm 10 (`packageManager: pnpm@10.32.1`) |
| Build | Turborepo 2 |
| Ngôn ngữ | TypeScript 5.7, strict |
| Runtime | Node.js 22 trở lên cho hub; worker chạy trên Node 20 trở lên |
| Test | Vitest |
| Path alias | `@cortex/*` |

```
apps/
  hub-mcp/            MCP gateway
  dashboard-api/      API, Conductor, cổng LLM
  dashboard-web/      dashboard
  conductor-worker/   worker và CLI cw
  cortex-extension/   extension VS Code (cortex-agent)
packages/
  shared-types/  shared-utils/  shared-mem9/
mods/cortex-bar/      mod cho Claude Code
benchmarks/           benchmark truy hồi (@cortex/benchmarks)
infra/                Docker Compose, Dockerfile
scripts/              trình cài đặt, khởi tạo worker, phát hành
website/              trang này (VitePress)
```

## Ứng dụng

| Ứng dụng | Phụ thuộc chính |
|---|---|
| `hub-mcp` | Hono 4, `@hono/node-server`, `@modelcontextprotocol/sdk` 1.x, Zod 4, `ws` |
| `dashboard-api` | Hono 4, `better-sqlite3` 11, `ws`, `@cortex/shared-mem9` |
| `dashboard-web` | Next.js 15, React 19, SWR, `react-markdown`, `lucide-react` |
| `conductor-worker` | Không có phụ thuộc lúc chạy; được esbuild đóng gói thành một file, `cortex-worker.mjs`. Dùng `ws` và `smol-toml` |
| `cortex-extension` | `antigravity-sdk`, `ws`; VS Code 1.85 trở lên |

## Dữ liệu và dịch vụ

| | |
|---|---|
| Kho quan hệ | SQLite (`better-sqlite3`) trong volume `api-data` |
| Vector | Qdrant 1.13 |
| Đồ thị code | GitNexus, trong image `cortex-gitnexus` |
| Embedding | Ollama 0.34 với `all-minilm` (384 chiều) mặc định, qua cổng LLM của hub |
| Chat model | Bất kỳ thứ gì được định tuyến trong LLM Providers: nhà cung cấp dùng API key, hoặc gói đăng ký qua CLIProxyAPI |
| Image | Build từ `node:22-slim`, phát hành lên `ghcr.io/lktiep` |
| Triển khai | Docker Compose; Watchtower để cập nhật |

## Trang tài liệu

VitePress 1.6, trong `website/`, nằm ngoài pnpm workspace. GitHub Pages build nó mỗi lần push lên
`master` có thay đổi trong `website/`.

```bash
cd website
pnpm install --ignore-workspace
pnpm dev
```
