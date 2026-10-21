# `cw`: CLI của worker

`cw` là giao diện dòng lệnh của worker Conductor (`apps/conductor-worker`, phát hành dưới dạng một
file duy nhất `cortex-worker.mjs`). Script khởi tạo worker sẽ cài nó; xem
[Chạy một worker](../conductor/workers#install-and-start). Cần Node 20 trở lên.

```
cw <command> [agent] [options]
```

`[agent]` là tên agent hoặc số thứ tự của nó trong `cw ls`. Nếu `cw` không có trong PATH, hãy chạy
`node ~/.cortex/worker/cortex-worker.mjs <command>`.

## Các lệnh

| Lệnh | Làm gì |
|---|---|
| `cw ls` | Liệt kê các agent trên máy này, có đánh số, kèm trạng thái chạy |
| `cw start [agent]` | Chạy worker ở foreground; `-d` để chạy nền. Nhận tên, không nhận số |
| `cw stop [agent]` | Dừng một worker chạy nền, chờ tối đa 90 giây để task đang chạy push xong. `--all` dừng mọi agent |
| `cw restart [agent]` | Dừng rồi chạy nền lại với các thiết lập của lần khởi động trước. `--all` cho mọi agent |
| `cw status [agent]` | Trạng thái chạy, task hiện tại, lần đăng ký gần nhất với hub. Không chỉ định agent thì liệt kê các agent |
| `cw logs [agent]` | 200 dòng cuối trong log của worker; `-f` để theo dõi tiếp |
| `cw tail [agent]` | Phần cuối những gì engine in ra cho task gần nhất; `-f` để theo dõi tiếp |
| `cw update` | Thay `cortex-worker.mjs` bằng phiên bản hub của bạn đang phục vụ |
| `cw hub-url` | In URL hub mà worker sẽ dùng |
| `cw doctor` | Kiểm tra thiết lập từng bước; `--probe` chạy thêm mỗi engine một lần |
| `cw check` | Liệt kê những gì máy còn thiếu cho repo, đề nghị cài, rồi chạy thử lệnh setup và lệnh test |
| `cw version` | In phiên bản |
| `cw help` | In phần trợ giúp |

Nếu bỏ trống, `[agent]` là agent của repo này, hoặc agent duy nhất trên máy; khi có nhiều agent, `cw`
sẽ hỏi chọn cái nào.

## Tùy chọn

| Tùy chọn | Ý nghĩa |
|---|---|
| `-d`, `--daemon` | `start` chạy nền; output ghi vào log |
| `-f`, `--follow` | `logs`, `tail`: tiếp tục in các dòng mới |
| `--all` | `stop`, `restart`: mọi agent trên máy |
| `--agent-id <id>` | Định danh worker. Mặc định: `CORTEX_AGENT_ID`, nếu không thì `<host>-<thư mục repo>`, viết thường và cắt còn 64 ký tự |
| `--repo <path>` | Repo để làm việc. Mặc định: thư mục hiện tại |
| `--engines <list>` | Các engine cần tìm, theo thứ tự. Mặc định `agy,claude,codex,gemini` |
| `--capabilities <list>` | Các tag capability mà hub dùng để khớp task |
| `--hub <url>` | URL hub. Mặc định: `CORTEX_HUB_URL`, nếu không thì lấy từ MCP config `cortex-hub` |
| `--api-key <key>` | API key. Mặc định: `CORTEX_API_KEY`, nếu không thì lấy từ MCP config `cortex-hub` |
| `--engine-timeout <min>` | Số phút tối đa một engine được chạy cho mỗi task. Mặc định 90 |
| `--probe` | `doctor`: chạy thêm một prompt rất nhỏ qua từng engine |
| `-y`, `--yes` | `check`: cài những gì còn thiếu mà không hỏi |
| `--if-changed` | `check`: bỏ qua lần chạy thử nếu lần trước đã qua và những gì nó dựa vào chưa đổi |

`--all` chỉ dùng với `stop` và `restart`; `--yes` và `--if-changed` chỉ dùng với `check`. `cw` từ chối
các tổ hợp khác.

### Các tag capability

`plan`, `orchestrate`, `backend`, `frontend`, `design`, `review`, `godot`, `resources`,
`game-logic`, `server`, `build-game`, `database`, `devops`, `security`, `testing`, `docker`,
`deploy`. Worker phải có tất cả các tag trong `requiredCapabilities` của một task.

## URL hub và key lấy từ đâu

1. `--hub` / `--api-key`
2. `CORTEX_HUB_URL` / `CORTEX_API_KEY`
3. Mục MCP `cortex-hub` đầu tiên tìm thấy trong `~/.claude.json`, `~/.codex/config.toml`,
   `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/config/mcp_config.json`,
   `~/.cursor/mcp.json`, theo đúng thứ tự đó. Key được lấy từ mục của cùng hub đó.

`cw hub-url` in ra kết quả.

## `cw doctor`

Kiểm tra lần lượt: `node`, `git`, `gh` (không bắt buộc), từng engine, các engine nói chung, config
hub, tình trạng hub, phiên bản worker so với của hub, bước bắt tay, git origin, ánh xạ project trên
hub, và MCP config của các engine.

## `cw check`

Xem [Máy này chạy được project không?](../conductor/workers#will-it-run-my-project-cw-check). Mã
thoát 0 nghĩa là sẵn sàng, 1 là chưa.

## Biến môi trường {#environment-variables}

| Biến | Ý nghĩa |
|---|---|
| `CORTEX_API_KEY`, `CORTEX_HUB_URL`, `CORTEX_AGENT_ID` | Giá trị mặc định cho `--api-key`, `--hub`, `--agent-id` |
| `CORTEX_SETUP_CMD`, `CORTEX_TEST_CMD` | Ghi đè lệnh setup và lệnh test của project trên máy này |
| `CORTEX_GH_BIN` | Đường dẫn tới file chạy `gh` |
| `CORTEX_AGY_BIN` | Đường dẫn tới file chạy `agy` |
| `CORTEX_AGY_MODE` | Chế độ quyền của agy. Mặc định `accept-edits`; lựa chọn còn lại là `auto` |
| `CORTEX_AGY_SKIP_PERMISSIONS=1` | Chủ động bật `--dangerously-skip-permissions` của agy |
| `CORTEX_WORKER_HOME` | Thay cho `~/.cortex/worker` |
| `CORTEX_SKIP_READINESS=1` | Nhận task mà không kiểm tra sẵn sàng |
| `CORTEX_SKIP_CHECK=1` | Script khởi tạo bỏ qua `cw check` |
| `CORTEX_SKIP_CW=1` | Script khởi tạo không cài `cw` |

Worker đặt `CORTEX_WIP_PUSH=1` cho git hook khi push phần việc đang dở, để hook pre-push của project
có thể bỏ qua các bước kiểm tra chậm với việc chưa xong. `CORTEX_WORKER_DAEMON` là biến nội bộ.

`start.json` giữ repo, hub, engine, capability, timeout cùng các giá trị `CORTEX_SETUP_CMD`,
`CORTEX_TEST_CMD`, `CORTEX_GH_BIN`, `CORTEX_SKIP_READINESS` và `CORTEX_AGY_*`, để `cw restart` khởi
động worker theo đúng cách cũ. Nó chỉ lưu key khi key đến từ `--api-key` hoặc `CORTEX_API_KEY`.

## Các file

`~/.cortex/worker/cortex-worker.mjs` là worker. Với mỗi agent, `~/.cortex/worker/<agentId>/` chứa
`worker.pid`, `worker.log`, `state.json`, `worker.stop`, `start.json` (mode 600), `wt/` (các worktree)
và `tasks/<taskId>.log` (10 file mới nhất, mỗi file 10 MB).

## Mã thoát và mã đóng kết nối

| Mã | Ý nghĩa |
|---|---|
| 4001 | Kết nối bị đóng: không có API key |
| 4003 | Kết nối bị đóng: key sai hoặc ngoài phạm vi |
| 4000 | Kết nối bị đóng: bị thay bởi một kết nối mới hơn với cùng agent id |
| 4009 | Kết nối bị đóng: agent id đang được dùng |
| exit 2 | Hub từ chối worker hẳn; thử lại cũng không giúp gì |
