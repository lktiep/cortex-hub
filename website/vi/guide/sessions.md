# Phiên làm việc và nhớ lại

Một phiên là một đợt làm việc của một agent trên một repo. Hub ghi lại phiên, chuyển những gì phiên
này học được cho phiên sau, và cho các agent cùng repo biết về nhau.

## Mở phiên: `/cs`

`/cs` là một slash command mà trình cài đặt đặt vào `.claude/commands/cs.md`. Nó chạy bảy bước:

1. **Khởi động.** `cortex_session_start` với repo, `mode`, `agentId`, IDE, branch và
   `clientSessionId`. Agent giữ lại `session_id`, project id và `project.orgId` trả về để dùng
   suốt cuộc hội thoại.
2. **Nhớ lại.** Chạy song song `cortex_knowledge_search` và `cortex_memory_search`.
3. **Còn ai ở đây.** `cortex_changes` liệt kê các commit và file mà agent khác đã push nhưng agent
   này chưa thấy.
4. **Task.** `cortex_task_pickup` kiểm tra task Conductor được giao cho agent này.
5. **Cây làm việc của bạn.** `git status`; nếu có thay đổi chưa commit thì chạy
   `cortex_detect_changes` với `git diff HEAD`.
6. **Tóm tắt.** Một bản báo cáo ngắn về tình hình.
7. **Quy trình.** Các quy tắc cho phần còn lại của phiên: tìm code thế nào, gặp lỗi thì làm gì,
   chạy gì trước khi commit.

Trong Claude Code, hook từ chối mọi thao tác sửa file cho tới khi bước 1 và 2 đã chạy. Xem
[Hook](../reference/hooks).

### `cortex_session_start` trả về gì

| Trường | Ý nghĩa |
|---|---|
| `session_id` | Truyền cho `cortex_session_end` |
| `project.id`, `project.orgId` | Project tương ứng với repo, và tổ chức của nó. Tìm kiếm xuyên repo bị giới hạn trong tổ chức đó |
| `mission_brief` | Tên project và mode, cùng mục kiến thức khớp nhất với "session summary progress next session": thường là bản tóm tắt của phiên trước |
| `recent_sessions`, `relevant_knowledge` | Các phiên gần đây trên repo, và ba kết quả kiến thức đứng đầu |
| `auto_registered`, `project_note` | Có giá trị khi hub tự tạo project lúc thấy repo lần đầu |
| `hub_error` | Có giá trị khi một phần của bước khởi động bị lỗi; phiên vẫn được mở |

### `clientSessionId`

Hook SessionStart của Claude Code in id của cuộc hội thoại ra dưới tên `clientSessionId`, và `/cs`
truyền tiếp nó. Một cuộc hội thoại bị nén (compact) rồi tiếp tục vẫn giữ id cũ, nên hub giữ nguyên
một phiên thay vì mở phiên thứ hai.

## Đóng phiên: `/ce`

`/ce` chạy tám bước:

1. `cortex_detect_changes` trên diff; cảnh báo khi rủi ro ở mức HIGH.
2. `pnpm build && pnpm typecheck && pnpm lint`.
3. `cortex_quality_report` với kết quả.
4. Hoàn tất task Conductor nào còn đang làm dở.
5. `cortex_knowledge_store` khi phiên phát hiện điều gì đó cả team nên biết.
6. `cortex_memory_store` với những gì đã làm, các quyết định và bước tiếp theo.
7. `cortex_session_end` kèm bản tóm tắt. Hub cũng lưu bản tóm tắt này vào bộ nhớ, và đó là thứ
   `/cs` lần sau sẽ gợi lại.
8. Báo cáo cuối.

## Những phiên không ai đóng

- **Claude Code thoát.** Hook SessionEnd đóng phiên qua hub với `auto: true`. Phiên được ghi là bị
  bỏ dở, và bản tóm tắt của nó bị loại khỏi phần gợi nhớ, để một phiên chưa từng chạy `/ce` không
  "dạy" sai cho phiên sau.
- **Agent im lặng.** Mỗi giờ một lần, hub đánh dấu `expired` (chứ không phải `completed`) cho các
  phiên không có lời gọi tool nào trong `SESSION_IDLE_HOURS` giờ (mặc định 72; `0` để tắt), nên
  chúng cũng không được gợi lại. Agent quay lại sau đó sẽ nhận phiên mới ở lần `/cs` tiếp theo.

## Hai agent, một repo

`cortex_changes(agentId, projectId)` trả về các commit đã push kể từ lần cuối agent này xem, cùng
các file chúng đụng tới. `/cs` gọi nó lúc bắt đầu; hãy gọi lại trước khi sửa một file dùng chung.
