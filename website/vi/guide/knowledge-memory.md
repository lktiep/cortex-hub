# Kiến thức và bộ nhớ

Hub giữ hai kho. Mỗi kho trả lời một loại câu hỏi khác nhau.

| | Kiến thức (knowledge) | Bộ nhớ (memory) |
|---|---|---|
| Ai thấy | Cả team trong project | Gợi lại theo project, branch và agent |
| Lưu gì | Cách sửa lỗi, pattern, quyết định, rủi ro | Ngữ cảnh phiên: đã làm gì, tiếp theo làm gì |
| Lưu bằng | `cortex_knowledge_store(title, content)` | `cortex_memory_store(content)` |
| Gợi lại bằng | `cortex_knowledge_search(query)` | `cortex_memory_search(query)` |

Cả hai đều được embed và tìm theo nghĩa. `/cs` chạy cả hai lệnh tìm ở đầu mỗi phiên, và hook từ
chối sửa file cho tới khi chúng đã chạy. Hai kho này dành cho lỗi và quyết định, không phải để tìm
code: việc đó dùng [các tool code](./code-intelligence).

## Kiến thức

```
cortex_knowledge_store(
  title: "SQLite busy errors under parallel tests",
  content: "Cause: … Fix: … Verified by: …",
  tags: ["sqlite", "testing"],
  category: "error_fix",
  files: ["apps/dashboard-api/src/db/client.ts"]
)
```

| Tham số | Giá trị |
|---|---|
| `category` | `risk`, `lesson`, `error_fix`, `pattern`, `decision`, `general` |
| `hallType` | `fact`, `event`, `discovery`, `preference`, `advice`, `general` (mặc định) |
| `validFrom` | Ngày ISO mà sự kiện bắt đầu đúng. Tìm với `asOf` để chỉ lấy những gì còn hiệu lực vào một ngày |
| `files` | Các file (đường dẫn tương đối trong repo) hoặc `dir/` mà ghi chú nói tới. Xem phần ghi chú theo file bên dưới |
| `tags`, `projectId`, `agentId` | Bộ lọc và thông tin tác giả |

`cortex_knowledge_search` nhận `query`, cùng `tags`, `projectId`, `hallType`, `asOf` và `limit`
(mặc định 5). Kết quả bị đánh dấu deprecated đi kèm cảnh báo.

Trên dashboard, trang **Knowledge** liệt kê mọi tài liệu, nhóm theo project, cho tạo mới bằng tay
và xuất ra JSON.

### Khi có gì đó hỏng

1. `cortex_knowledge_search(query: "<thông báo lỗi>")`: có thể ai đó đã sửa rồi.
2. `cortex_memory_search(query: "<ngữ cảnh lỗi>")`: có thể bạn đã gặp nó trước đây.
3. Sửa lỗi.
4. Nếu cách sửa không hiển nhiên, lưu lại bằng `cortex_knowledge_store`.

## Ghi chú theo file {#file-notes}

Một ghi chú lưu kèm `files: [...]` được gắn với các đường dẫn đó. Các rủi ro mà một task Conductor
báo lại khi hoàn tất cũng vậy. Agent kế tiếp sắp đọc hay sửa một trong các file đó sẽ nhận được ghi
chú làm ngữ cảnh, mà không cần biết rằng lẽ ra một lần tìm kiếm sẽ ra chúng:

- Trong Claude Code, hook `recall-notes.sh` hỏi hub một lần cho mọi đường dẫn đã gắn ghi chú của
  project (`cortex_file_notes`), cache câu trả lời trong mười phút, và hiển thị tối đa ba ghi chú
  mỗi file, một lần cho mỗi cuộc hội thoại và agent. Nó không bao giờ chặn. `CORTEX_NOTES=off` để tắt.
- Kết quả của tool code có nhắc tới một file đã gắn ghi chú sẽ được nối thêm các ghi chú đó.

`cortex_file_notes(repo, files)` trả về trực tiếp các ghi chú, dạng JSON theo từng đường dẫn.

## Bộ nhớ

```
cortex_memory_store(content: "Moved retries into the client; next: wire the dashboard toggle", branch: "feat/retry")
cortex_memory_search(query: "retry work", branch: "feat/retry")
```

`branch` cần đi kèm `projectId`. Tìm trên một branch mà branch đó không có gì thì sẽ quay về tìm
trên cả project. `cortex_memory_delete(id)` xóa một mục.

`cortex_session_end` lưu bản tóm tắt phiên vào bộ nhớ, và đó là thứ `/cs` lần sau gợi lại. Phiên bị
đóng tự động (agent thoát mà không chạy `/ce`) không được đưa vào phần gợi nhớ đó.
