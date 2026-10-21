# MCP tool

MCP server của hub (`apps/hub-mcp`) cung cấp 32 tool, tất cả đều có tên `cortex_*`. Agent dùng chúng
qua mục `cortex-hub` mà [trình cài đặt](./installer) ghi ra. Mỗi lần gọi đều mang theo API key; một
key thấy được gì tùy vào phạm vi project và tổ chức của nó.

Trang này liệt kê từng tool và tham số. Các trang hướng dẫn giải thích khi nào nên dùng chúng.

## Phiên làm việc {#session}

| Tool | Tham số | Làm gì |
|---|---|---|
| `cortex_session_start` | `repo`, `mode`, `agentId`, `hostname`, `os`, `ide`, `branch`, `capabilities`, `role`, `clientSessionId` | Mở phiên và trả về project, một mission brief, kiến thức liên quan và các phiên gần đây. `clientSessionId` khớp với một phiên đang mở thì dùng lại phiên đó |
| `cortex_session_end` | `sessionId`, `summary`, `auto` | Đóng phiên; bản tóm tắt được lưu vào bộ nhớ. `auto: true` là thứ hook lúc thoát gửi đi: phiên được ghi là `abandoned` |
| `cortex_changes` | `agentId`, `projectId` | Các commit và file mà agent khác đã push nhưng agent này chưa thấy |
| `cortex_health` | không có | Tình trạng các dịch vụ backend của hub |

Xem [Phiên làm việc](../guide/sessions).

## Hiểu code {#code}

| Tool | Tham số | Làm gì |
|---|---|---|
| `cortex_code_search` | `query`, `repo`, `projectId`, `org`, `branch`, `limit` | Tìm kiếm lai có xếp hạng (vector và BM25) trên chỉ mục. Không có `repo` thì tìm mọi repo trong tổ chức của bạn |
| `cortex_code_context` | `name`, `repo`, `projectId`, `org`, `file` | Nơi gọi, hàm được gọi, import của một symbol và các luồng thực thi chứa nó |
| `cortex_code_impact` | `target`, `repo`, `projectId`, `org`, `branch`, `direction` | Một thay đổi trên symbol lan tới đâu. `direction` là `downstream` (mặc định) hoặc `upstream` |
| `cortex_cypher` | `query`, `repo`, `projectId`, `org` | Một truy vấn Cypher trên đồ thị code |
| `cortex_detect_changes` | `diff`, `repo`, `projectId`, `org`, `scope`, `baseRef` | Các symbol và luồng mà một diff đụng tới, kèm mức rủi ro. `unknown` nghĩa là một bước tra cứu bị lỗi |
| `cortex_list_repos` | `org` | Các repo đã index trong tổ chức của bạn và project id của chúng |
| `cortex_code_reindex` | `repo`, `branch` | Bắt đầu index lại một branch. Chạy sau khi push |

Xem [Hiểu code](../guide/code-intelligence).

## Kiến thức và bộ nhớ {#knowledge}

| Tool | Tham số | Làm gì |
|---|---|---|
| `cortex_knowledge_store` | `title`, `content`, `tags`, `projectId`, `agentId`, `hallType`, `validFrom`, `files`, `category` | Lưu một tài liệu cho team. Có `files` thì nó trở thành ghi chú theo file cho các đường dẫn đó |
| `cortex_knowledge_search` | `query`, `tags`, `projectId`, `limit`, `hallType`, `asOf` | Tìm theo nghĩa trong kho kiến thức |
| `cortex_file_notes` | `repo`, `projectId`, `files` | Rủi ro, bài học và cách sửa lỗi gắn với các file, dạng JSON. Không có `files` thì trả mọi đường dẫn đã gắn ghi chú của project |
| `cortex_memory_store` | `content`, `agentId`, `projectId`, `branch`, `metadata` | Lưu một mục bộ nhớ cho agent này. `branch` cần đi kèm `projectId` |
| `cortex_memory_search` | `query`, `agentId`, `projectId`, `branch`, `limit` | Tìm trong bộ nhớ: branch trước, rồi project, rồi agent |
| `cortex_memory_delete` | `id` | Xóa một mục bộ nhớ sai hoặc đã lỗi thời |

Xem [Kiến thức và bộ nhớ](../guide/knowledge-memory).

## Chất lượng {#quality}

| Tool | Tham số | Làm gì |
|---|---|---|
| `cortex_plan_quality` | `plan`, `request`, `iteration`, `threshold`, `plan_type` | Chấm một kế hoạch theo tám tiêu chí, thang 0 đến 10; đạt từ 8.0 |
| `cortex_quality_report` | `gate_name`, `passed`, `score`, `details` | Ghi kết quả một quality gate để hiển thị trên dashboard |
| `cortex_tool_stats` | `days`, `agentId`, `projectId` | Thống kê dùng tool: tỷ lệ thành công, độ trễ, ước lượng token, xu hướng |

Xem [Quality gate](../guide/quality-gates).

## Task {#tasks}

| Tool | Tham số | Làm gì |
|---|---|---|
| `cortex_task_create` | `title`, `description`, `assignTo`, `requiredCapabilities`, `dependsOn`, `notifyOnComplete`, `context`, `parentTaskId`, `model`, `effort`, `fallback`, `files`, `branch`, `reviewRequired`, `projectId` | Tạo một task, có thể giao cho agent khác |
| `cortex_task_pickup` | `agentId`, `projectId` | Các task được giao cho agent này hoặc cho API key của nó |
| `cortex_task_accept` | `taskId` | Nhận một task được giao |
| `cortex_task_update` | `taskId`, `status`, `message`, `result`, `parentTaskId` | Chuyển task sang `in_progress`, `review`, `completed` hoặc `failed` |
| `cortex_task_list` | `projectId`, `status`, `assignedTo`, `limit` | Liệt kê task |
| `cortex_task_status` | `taskId` | Một task cùng log và lịch sử của nó |
| `cortex_task_submit_strategy` | `taskId`, `summary`, `roles`, `subtasks`, `estimatedEffort` | Đề xuất vai trò và subtask để dashboard hiển thị chờ duyệt |

## Conductor {#conductor}

Các tool cho agent lead, bên lập kế hoạch và review. Xem [Conductor](../conductor/overview).

| Tool | Tham số | Làm gì |
|---|---|---|
| `cortex_task_tree_create` | `parentId`, `projectId`, `tasks`, `upload` | Tạo cả kế hoạch dưới dạng cây task; các task tham chiếu nhau bằng key. `upload: true` thì trả về một lệnh `curl` dùng một lần để gửi file JSON, có hiệu lực 15 phút |
| `cortex_agents` | không có | Các worker đang kết nối (engine, model, bận hay rảnh, quota đã hết) và các phiên MCP đang hoạt động |
| `cortex_task_review` | `taskId`, `verdict`, `feedback` | Duyệt hoặc từ chối một task đang `review`, hoặc quyết định một gate của lead. User gate bị từ chối (403) |
| `cortex_task_route` | `taskId`, `executor`, `model`, `effort`, `fallback`, `pinnedAgent`, `priority`, `files`, `dependsOn`, `clearEscalation` | Đổi cách định tuyến một task. Chỉ các trường bạn truyền mới đổi; `null` xóa một trường. `dependsOn` nhận id task đã lưu |
| `cortex_task_cancel` | `taskId`, `reason` | Hủy một task; các task phụ thuộc vẫn bị chặn. Hủy một group sẽ hủy mọi thứ bên dưới |

Các trường task của một kế hoạch được liệt kê ở mục [Một kế hoạch](../conductor/overview).

## Thông báo trong kết quả tool

Hai loại nội dung có thể được thêm vào kết quả của bất kỳ lần gọi tool hub nào:

- **Thông báo Conductor** cho lead, dưới `📋 Conductor:`. Xem [Review](../conductor/review#notices-not-polling).
- **Ghi chú theo file** cho các file mà kết quả của một tool code trỏ tới. Xem
  [Ghi chú theo file](../guide/knowledge-memory#file-notes).
