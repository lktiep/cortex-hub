# Biến môi trường và cấu hình

Cortex được cấu hình ở bốn nơi: `infra/.env` trên server, phần thiết lập của hub trong dashboard,
thư mục `.cortex/` của từng project, và biến môi trường trên các máy chạy agent và worker.

## Server: `infra/.env`

Chép `infra/.env.example` thành `infra/.env` rồi điền vào. `docker compose` đọc file này. Xem
[Tự dựng hub](../guide/self-host) cho toàn bộ quá trình thiết lập.

### Bắt buộc

| Biến | Ý nghĩa |
|---|---|
| `MANAGEMENT_PASSWORD` | Key cho management API của LLM proxy. Không có giá trị mặc định |

### Tùy chọn

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `GITNEXUS_AUTH_TOKEN` | tự sinh | Bearer token cho dịch vụ đồ thị code. Để trống thì được sinh một lần và chia sẻ với API qua một volume |
| `DEFAULT_REPO` | không có | Một repo để index ngay lần khởi động đầu |
| `GEMINI_API_KEY` | không có | Cho embedding hoặc chat model của Gemini |
| `PORT` | `4000` | Cổng của `cortex-api` |
| `DATABASE_PATH` | `/app/data/cortex.db` | File SQLite bên trong container |
| `EXTERNAL_MCP_URL` | không có | Địa chỉ công khai mà agent kết nối tới (`/mcp` được nối thêm vào). Để trống thì dashboard hiển thị địa chỉ mà agent đầu tiên đã dùng, nếu không có thì địa chỉ local |
| `EXTERNAL_API_URL`, `EXTERNAL_LLM_PROXY_URL` | không có | Tương tự, cho các đường link trên Settings |
| `BRANCH_RETENTION_DAYS` | `14` | Xóa vector của một branch sau chừng ấy ngày không được index, hoặc khi branch đã merge hay bị xóa. Không bao giờ xóa branch mặc định. `0` là giữ tất cả |
| `SESSION_IDLE_HOURS` | `72` | Đánh dấu một phiên đang mở là `expired` sau chừng ấy giờ không có lời gọi tool. `0` = không bao giờ |
| `CORTEX_LLM` | theo Settings | `off`: không bao giờ gọi chat model. `on`: bỏ qua công tắc trong Settings |
| `MEMORY_LLM` | theo Settings | `off`: lưu bộ nhớ đúng như được viết, không trích xuất sự kiện |
| `RECIPE_CAPTURE` | theo Settings | `off`: không tạo recipe từ các task và phiên đã xong |
| `OLLAMA_MEMORY_LIMIT`, `OLLAMA_CPUS`, `OLLAMA_THREADS`, `QDRANT_MEMORY_LIMIT` | `4G`, `4`, `OLLAMA_CPUS`, `2G` | Giới hạn tài nguyên |
| `CORTEX_IMAGE_NAMESPACE` | `ghcr.io/lktiep` | Nơi kéo image Cortex về |

Embedding không bao giờ cần chat model. Có ba tính năng cần: trích xuất sự kiện cho bộ nhớ, ghi lại
recipe và tự sửa kiến thức. Không có chat model nào được định tuyến thì ba tính năng này tắt.

### Truy cập API

| Biến | Ý nghĩa |
|---|---|
| `API_AUTH` | `required`: `/api` chỉ trả lời loopback, MCP gateway, API key và, khi đặt đủ hai biến `CF_ACCESS_*`, trình duyệt đã qua Cloudflare Access. Không đặt hoặc `off`: ai gọi cũng trả lời |
| `INTERNAL_API_SECRET` | Dùng chung giữa `cortex-api` và `cortex-mcp`. Tạo bằng `openssl rand -hex 32` |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Team domain của Cloudflare Access và audience tag của ứng dụng |
| `API_BIND` | Địa chỉ mở các cổng API. `127.0.0.1` giữ chúng trên chính host |

::: warning
Dashboard không có đăng nhập riêng. Hãy đặt `API_AUTH=required` và đặt dashboard sau một access
proxy trước khi cho truy cập từ bên ngoài. Xem
[Tự dựng hub](../guide/self-host#put-it-on-the-internet).
:::

## Thiết lập của hub

Trang **Settings** trên dashboard chứa cấu hình riêng của hub: các endpoint, định tuyến LLM, MCP
config để sao chép, tùy chọn thông báo và cách chạy worker. Nhà cung cấp LLM và các model dùng cho
chat và embedding được đặt trong **LLM Providers**.

Conductor đọc các khóa sau từ bảng `hub_config` của hub:

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `conductor.defaultFallback` | `[{executor: "claude", model: "opus"}]` | Các tuyến được thử sau tuyến riêng của task |
| `conductor.branchTemplate` | `cx/{key}-{slug}` | Tên branch cho task không có `branch` |
| `conductor.offlineReclaimMinutes` | `30` | Số phút worker được phép offline trước khi task của nó bị lấy lại |
| `conductor.leaseHours` | `24` | Số giờ một task được chạy trước khi bị lấy lại |
| `conductor.baseBranch` | branch mặc định của project, nếu không thì `main` | Nơi các branch của task bắt đầu |

Chỉ `conductor.defaultFallback` được tạo khi hub khởi động lần đầu. Route của Settings chỉ cập nhật
các khóa đã có, nên các khóa còn lại giữ giá trị mặc định trừ khi có ai thêm một dòng vào bảng.

## Project: `.cortex/`

| File | Ai ghi | Ý nghĩa |
|---|---|---|
| `project-profile.json` | trình cài đặt, một lần | Các stack và trình quản lý gói dò được (`fingerprint`), các bước kiểm tra cần chạy (`verify`), và mục [`worker`](../conductor/workers#the-worker-section) tùy chọn |
| `agent-identity.json` | trình cài đặt | Vai trò và capability của agent |
| `.hooks-version` | trình cài đặt | Phiên bản của các hook; trình cài đặt mới hơn sẽ tạo lại chúng |
| `.session-state/` | hook | Các [marker](./hooks#markers) mà gate đọc. Bị git bỏ qua |

`project-profile.json` có `schema_version` là `2.0`. Mục `verify` gồm `pre_commit`, `full`,
`auto_fix` và `max_retries`. Trình cài đặt để nguyên hồ sơ đã có; muốn đổi thì sửa tay.

## Máy chạy agent

| Biến | Dùng bởi | Ý nghĩa |
|---|---|---|
| `HUB_MCP_URL`, `HUB_API_KEY` | trình cài đặt, hook | MCP endpoint của hub và key. Xem [Trình cài đặt](./installer#environment) |
| `CORTEX_MCP_URL` | hook | Được ưu tiên hơn `HUB_MCP_URL` |
| `CORTEX_NUDGE=off`, `CORTEX_NOTES=off` | hook | Tắt lời gợi ý tra cứu hoặc ghi chú theo file. Xem [Hook](./hooks#switches) |

## Máy chạy worker

Danh sách đầy đủ có ở [biến môi trường của `cw`](./cli#environment-variables). Những biến hay được
đặt nhất:

| Biến | Ý nghĩa |
|---|---|
| `CORTEX_HUB_URL`, `CORTEX_API_KEY`, `CORTEX_AGENT_ID` | Hub, key và định danh của worker |
| `CORTEX_SETUP_CMD`, `CORTEX_TEST_CMD` | Ghi đè lệnh setup và lệnh test của project trên máy này |
| `CORTEX_WORKER_HOME` | Thay cho `~/.cortex/worker` |
