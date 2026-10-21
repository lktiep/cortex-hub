# Slash command và skill

Cortex Hub đi kèm ba lệnh cho Claude Code. `/cs` và `/ce` được [trình cài đặt](./installer) ghi vào
từng project; `/install` là một skill toàn cục. Mod cortex-bar thêm hai lệnh nữa, liệt kê trong
[Mod](./mods).

| Lệnh | Nằm ở đâu | Làm gì |
|---|---|---|
| `/cs` | `.claude/commands/cs.md` | Mở phiên và gợi lại ngữ cảnh |
| `/ce` | `.claude/commands/ce.md` | Chạy các gate, lưu những gì học được, đóng phiên |
| `/install` | `~/.claude/skills/install/SKILL.md` | Chạy trình cài đặt trong project hiện tại |
| `/cortex-bar`, `/cortex-calls` | mod cortex-bar | Thanh trạng thái và khung danh sách lời gọi; xem [Mod](./mods) |

## `/cs`: mở phiên

1. `cortex_session_start(repo, mode, agentId, ide, branch, clientSessionId)`. Giữ lại `session_id`,
   project id và `project.orgId`.
2. `cortex_knowledge_search` và `cortex_memory_search`, chạy song song.
3. `cortex_changes`: các commit và file của agent khác mà agent này chưa thấy.
4. `cortex_task_pickup`: task Conductor cho agent này, nếu có.
5. `git status`; nếu cây làm việc có thay đổi, chạy `cortex_detect_changes` với `git diff HEAD`.
6. Một bản tóm tắt tình hình.
7. Quy trình cho phần còn lại của phiên:
   - chấm điểm các kế hoạch không tầm thường bằng `cortex_plan_quality` (8.0 là đạt, tối đa ba lần);
   - tìm code theo [bảng tra](../guide/code-intelligence#pick-the-tool-by-what-you-already-know),
     tìm một lần và đọc cả mười kết quả;
   - gặp lỗi thì tìm trong kiến thức và bộ nhớ trước khi sửa;
   - `cortex_detect_changes` trước khi commit, `cortex_code_reindex` sau khi push;
   - với task Conductor: nhận task, đặt `in_progress`, rồi hoàn tất.

Trong Claude Code, hook chặn sửa file cho tới khi bước 1 và 2 đã chạy.

::: info
Bước 1 của `/cs` cảnh báo và chạy `git pull` khi phản hồi khởi động có `recentChanges`. Phiên bản
`cortex_session_start` hiện tại không trả về trường đó, nên nhánh này không bao giờ chạy;
`cortex_changes` ở bước 3 đã làm phần việc tương tự.
:::

## `/ce`: đóng phiên

1. `cortex_detect_changes` trên diff; cảnh báo khi rủi ro ở mức HIGH.
2. `pnpm build && pnpm typecheck && pnpm lint`.
3. `cortex_quality_report(gate_name: "Session Quality", ...)`.
4. Hoàn tất task Conductor nào còn đang làm dở.
5. `cortex_knowledge_store`, khi có điều gì cả team nên biết.
6. `cortex_memory_store` với những gì đã làm, các quyết định và bước tiếp theo.
7. `cortex_session_end(sessionId, summary)`. Hub lưu bản tóm tắt vào bộ nhớ.
8. Báo cáo cuối.

## `/install`

```
/install                       # thiết lập project này
/install --check               # báo những gì đã cài
/install --force               # tạo lại mọi thứ
/install --tools claude,gemini # chỉ các IDE này
```

Skill này tải `scripts/install.sh` qua GitHub API, nếu không được thì lấy từ
`raw.githubusercontent.com`, rồi chạy. Nó có `disable-model-invocation: true`, nên Claude chỉ chạy nó
khi chính bạn gõ lệnh. Mã nguồn nằm ở `templates/skills/install/SKILL.md`.

## Trong các IDE khác

Cursor, Windsurf, VS Code Copilot và Codex không có slash command nào từ Cortex. File rule của chúng
hướng dẫn agent chạy các bước tương tự qua MCP tool. Xem [Nhiều IDE](../guide/multi-ide).
