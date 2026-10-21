# Quyết định thiết kế

Năm bản ghi quyết định kiến trúc (ADR) đầu tiên được viết vào tháng 3/2026, trước phần lớn code hiện
tại. Chúng nằm trong
[`docs/architecture/architecture-decision-records/ADR-001-to-005.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/architecture/architecture-decision-records/ADR-001-to-005.md).
Trang này nêu từng quyết định và chỗ code đã đi xa hơn kể từ đó.

| ADR | Quyết định | Hiện nay |
|---|---|---|
| 001 Monorepo dạng module | pnpm workspaces và Turborepo; `hub-mcp`, `dashboard-api`, `dashboard-web` là các ứng dụng | Vẫn giữ. Worker, extension VS Code và benchmark đã gia nhập. Dashboard không nằm trên Cloudflare Pages như dự kiến: `cortex-api` phục vụ nó |
| 002 MCP, REST và WebSocket | MCP cho agent, REST cho dashboard, WebSocket cho cập nhật trực tiếp, không dùng message broker | Vẫn giữ. Các route REST nằm dưới `/api/*`. WebSocket còn mang cả Conductor: worker và các cửa sổ extension kết nối tới `/ws/conductor` |
| 003 SQLite, vector và đồ thị | SQLite (WAL) cho dữ liệu ứng dụng, Qdrant cho vector, GitNexus cho chỉ mục code | Vẫn giữ. Tìm kiếm code giờ là tìm kiếm lai: vector và BM25 được gộp trong Qdrant |
| 004 API key và OAuth | API key cho agent; đăng nhập GitHub OAuth cho dashboard | API key vẫn giữ. Đăng nhập dashboard chưa được làm: dashboard không có đăng nhập, thay vào đó `API_AUTH` cùng một access proxy bảo vệ API |
| 005 Một tenant | Một cơ sở dữ liệu và một collection; agent được phân biệt bằng `agent_id` | Đã bị thay thế. Project thuộc về tổ chức, key có phạm vi theo tổ chức, tìm kiếm xuyên repo nằm trong một tổ chức, và vector code của mỗi project có collection Qdrant riêng |

## Các quyết định về sau, theo những gì code cho thấy

- **Hook cưỡng chế quy trình, dựa trên bằng chứng.** Một marker chỉ được tính khi một lời gọi tool
  đã ghi nó, và một thao tác ghi sau khi qua gate sẽ xóa chúng. Xem [Hook](../reference/hooks).
- **Tìm kiếm code lai.** Đây là lựa chọn duy nhất cải thiện được độ chính xác ở hạng 1 trên benchmark
  của chính repo; một LLM reranker thì không. Xem [Benchmark](./benchmarks).
- **Thông báo đi kèm kết quả tool.** Lead biết về review, gate và escalation trong kết quả của lần gọi
  hub kế tiếp, không phải bằng cách hỏi vòng. Xem [Review](../conductor/review).
- **Worker push công việc của mình.** Worker hết quota hoặc bị dừng sẽ commit và push những gì đã có,
  để lần thử kế tiếp làm tiếp từ đó. Xem [Chạy một worker](../conductor/workers).
- **CI giữ quyền đánh số phiên bản.** Mỗi lần merge vào `master` lấy một số patch; bản phát hành ổn
  định chạy cùng workflow đó. Xem [Script](../reference/scripts#release).

Thiết kế Conductor nằm trong
[`docs/architecture/conductor-design.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/architecture/conductor-design.md),
còn trạng thái hiện tại nằm trong
[`docs/conductor.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor.md). Tài liệu
thiết kế có trước worker TypeScript; hãy đọc tài liệu thứ hai trước.
