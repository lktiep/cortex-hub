# Cortex Hub là gì

Cortex Hub là một backend bạn tự host. Các AI coding agent của bạn kết nối tới nó qua một
[MCP](https://modelcontextprotocol.io/) endpoint duy nhất, và qua đó dùng chung bộ nhớ, kiến thức
của team, đồ thị code của mọi repo đã index, quality gate và một hàng đợi task.

```
   Claude Code   Cursor   Windsurf   VS Code   Antigravity   Codex
        │           │         │          │           │          │
        └───────────┴─────────┴────┬─────┴───────────┴──────────┘
                                   │  MCP qua HTTP, API key
                         ┌─────────▼──────────┐
                         │   cortex-mcp       │  32 tool
                         ├────────────────────┤
                         │   cortex-api       │  REST, dashboard, Conductor
                         │   Qdrant           │  vector
                         │   GitNexus         │  đồ thị code AST
                         │   SQLite (WAL)     │  phiên, task, kiến thức
                         │   Ollama           │  embedding chạy local
                         │   llm-proxy        │  cổng LLM
                         └────────────────────┘
```

## Agent nhận được gì

| Mảng | Tool | Đọc thêm |
|---|---|---|
| Phiên làm việc | `cortex_session_start`, `cortex_session_end`, `cortex_changes` | [Phiên làm việc và nhớ lại](./sessions) |
| Code | `cortex_code_search`, `cortex_code_context`, `cortex_code_impact`, `cortex_detect_changes`, `cortex_cypher`, `cortex_list_repos`, `cortex_code_reindex` | [Hiểu code](./code-intelligence) |
| Kiến thức và bộ nhớ | `cortex_knowledge_*`, `cortex_memory_*`, `cortex_file_notes` | [Kiến thức và bộ nhớ](./knowledge-memory) |
| Chất lượng | `cortex_quality_report`, `cortex_plan_quality`, `cortex_tool_stats` | [Quality gate](./quality-gates) |
| Điều phối | `cortex_task_*`, `cortex_agents` | [Conductor](../conductor/overview) |

Cả 32 tool cùng tham số đều có trong [tra cứu MCP tool](../reference/mcp-tools).

## Những gì chạy trên máy bạn

Tự bản thân hub thì thụ động: agent phải gọi nó. Thứ khiến agent gọi hub đều đặn là phần được
[`scripts/install.sh`](../reference/installer) cài vào từng dự án:

- **MCP config** cho mỗi IDE nó tìm thấy, trỏ về hub của bạn.
- **`/cs` và `/ce`**, hai slash command mở và đóng phiên.
  Xem [Slash command](../reference/slash-commands).
- **Tám hook cho Claude Code**, chặn sửa file cho tới khi phiên đã nhớ lại những gì team biết, và
  chặn commit cho tới khi build, typecheck và lint đều qua. Xem [Hook](../reference/hooks).
- **File rule** cho Cursor, Windsurf, VS Code Copilot và Codex, hướng dẫn các agent đó theo cùng
  quy trình.

Với việc nhiều agent, một máy còn có thể chạy [worker](../conductor/workers) (`cw`): nó nhận task từ
hub và chạy bằng một engine có sẵn trên máy (`agy`, `claude`, `codex` hoặc `gemini`).

## Đi tiếp đâu

- Đã có URL hub và key? Xem [Cài nhanh](./quick-start).
- Cần một hub? [Tự dựng](./self-host) bằng Docker Compose.
- Muốn xem phần điều phối? Mở [trang giới thiệu Conductor](/cortex-hub/conductor/index.html){target="_self"}.

## Yêu cầu và chi phí

Theo README của dự án:

| Tài nguyên | Tối thiểu | Khuyến nghị |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Ổ đĩa | 20 GB | 50 GB |
| Hệ điều hành | Ubuntu 22.04+ | Ubuntu 24.04 LTS (Linux nào có Docker 24+ cũng được) |

Mọi dịch vụ chạy trong Docker trên server của bạn. README ước tính khoảng 5 USD mỗi tháng cho một
VPS nhỏ, cộng với chi phí LLM bạn định tuyến qua cổng LLM. Cortex Hub dùng giấy phép MIT.
