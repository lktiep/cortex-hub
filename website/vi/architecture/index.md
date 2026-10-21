# Kiến trúc

Cortex Hub chạy như một stack Docker Compose duy nhất (`infra/docker-compose.yml`). Agent nói chuyện
với một endpoint duy nhất là MCP gateway; mọi thứ khác nằm trong mạng nội bộ của compose.

```
  Agent: Claude Code · Cursor · Windsurf · Antigravity · VS Code · Codex       Worker Conductor (cw)
              │  MCP qua HTTP, Bearer API key                                      │  WebSocket
              ▼                                                                    ▼
  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │ cortex-mcp  :8318 → 8317   MCP gateway (apps/hub-mcp): 32 tool, kiểm tra key, /ws/conductor   │
  └───────────────┬────────────────────────────────────────────────────────────────────────────┘
                  │ HTTP + INTERNAL_API_SECRET            WebSocket chuyển tiếp nguyên vẹn
                  ▼
  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │ cortex-api  :4000   API (apps/dashboard-api) + dashboard (apps/dashboard-web)                 │
  │   SQLite: project, key, phiên, kiến thức, task, chất lượng, mức dùng                         │
  │   Conductor: bộ phân phối, bộ lập lịch, WebSocket server                                      │
  │   Cổng LLM: /api/llm/v1/chat/completions, /api/llm/v1/embeddings                              │
  └──────┬──────────────────────┬──────────────────────┬──────────────────────┬───────────────┘
         ▼                      ▼                      ▼                      ▼
   qdrant :6333           gitnexus :4848          ollama                 llm-proxy
   vector: code,          đồ thị code, AST,       model embedding        truy cập model
   kiến thức, bộ nhớ      index                   và chat chạy local     qua OAuth

   watchtower: kéo image Cortex mới và khởi động lại các container đó
```

Cổng `6333`, `6334` và `4848` chỉ mở trên `127.0.0.1`; Ollama và LLM proxy hoàn toàn không mở ra ngoài.

## Các thành phần

| Container | Mã nguồn | Vai trò |
|---|---|---|
| `cortex-mcp` | `apps/hub-mcp` | MCP server mà agent kết nối tới (Hono, MCP SDK). Kiểm tra API key, rồi gọi API. Cũng chuyển tiếp `/ws/conductor` tới API với cùng bước kiểm tra key |
| `cortex-api` | `apps/dashboard-api`, `apps/dashboard-web` | API (Hono, `better-sqlite3`) và dashboard (Next.js). Giữ toàn bộ trạng thái, chạy Conductor và định tuyến các lời gọi LLM |
| `cortex-gitnexus` | `infra/Dockerfile.gitnexus` | Clone và index repo thành đồ thị code: symbol, lời gọi, import, luồng thực thi |
| `cortex-qdrant` | `qdrant/qdrant` | Kho vector cho các đoạn code, kiến thức và bộ nhớ |
| `cortex-ollama` | `ollama/ollama` | Model chạy local. Embedder mặc định là `all-minilm` (384 chiều); `bge-m3` cũng được kéo về |
| `cortex-llm-proxy` | CLIProxyAPI | Truy cập model qua các gói đăng ký của nhà cung cấp (OAuth) |
| `cortex-watchtower` | Watchtower | Cập nhật các container Cortex khi có image mới |

Bên ngoài stack:

| Thành phần | Mã nguồn | Vai trò |
|---|---|---|
| Hook và lệnh | `.claude/hooks`, `templates/`, do trình cài đặt ghi | Giữ mỗi agent đi đúng quy trình. Xem [Hook](../reference/hooks) |
| Worker Conductor | `apps/conductor-worker` | Chạy task trên một máy có CLI engine. Xem [Chạy một worker](../conductor/workers) |
| Extension VS Code | `apps/cortex-extension` | Biến mỗi cửa sổ Antigravity, VS Code, Cursor hay Windsurf thành một agent trên WebSocket conductor |
| cortex-bar | `mods/cortex-bar` | Hiển thị các lời gọi cortex của phiên trong Claude Code. Xem [Mod](../reference/mods) |

## Một lời gọi đi qua những đâu

1. Agent gọi `cortex_code_search` kèm API key.
2. `cortex-mcp` kiểm tra key và phạm vi của nó, rồi gọi `cortex-api` với secret nội bộ.
3. `cortex-api` embed câu truy vấn qua cổng LLM, tìm trong Qdrant (vector và BM25, được gộp lại), và
   trả về các kết quả đã xếp hạng.
4. `cortex-mcp` nối thêm những gì agent nên thấy cùng câu trả lời: ghi chú gắn với các file trong đó
   (`📌 Known notes on these files`), gợi ý (`💡 Cortex hints`) và thông báo Conductor cho key này
   (`📋 Conductor`). Nó ghi lại lời gọi cho `cortex_tool_stats`.

## Model

Cổng LLM trong `cortex-api` xử lý mỗi request theo định tuyến model đặt trong **LLM Providers**: một
chuỗi tài khoản nhà cung cấp, thử lần lượt, có ghi nhận mức dùng và kiểm tra ngân sách. Embedding
không bao giờ cần chat model. Trích xuất sự kiện cho bộ nhớ, ghi lại recipe và tự sửa kiến thức thì
cần, và sẽ tắt nếu không có. Xem [Biến môi trường và cấu hình](../reference/configuration).

## Đọc thêm

- [Công nghệ](./tech-stack)
- [Quyết định thiết kế](./decisions)
- [Benchmark](./benchmarks)
- Các ghi chú thiết kế trong [`docs/architecture`](https://github.com/lktiep/cortex-hub/tree/master/docs/architecture)
  trên GitHub. Một số trong đó mô tả các phiên bản cũ hơn.
