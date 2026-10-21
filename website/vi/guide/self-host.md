# Tự dựng hub

Hub là một stack Docker Compose nằm trong `infra/`. Một server Linux có Docker 24 trở lên chạy
được toàn bộ: tối thiểu 2 vCPU, 4 GB RAM và 20 GB ổ đĩa.

## Khởi động

```bash
git clone https://github.com/lktiep/cortex-hub.git
cd cortex-hub
cp infra/.env.example infra/.env
# sửa infra/.env: bắt buộc phải có MANAGEMENT_PASSWORD
cd infra && docker compose up -d
```

Compose sẽ không chạy nếu thiếu `MANAGEMENT_PASSWORD` ("Set MANAGEMENT_PASSWORD in .env"). Đây là
management key của cổng LLM, và là thông tin xác thực duy nhất cho các route `/v0/management/*`.

Khi các container đã lên:

| Cái gì | Ở đâu |
|---|---|
| Dashboard và REST API | `http://localhost:4000` (cũng mở ở cổng 3000 và 3080) |
| MCP endpoint cho agent | `http://localhost:8318/mcp` |

Mở dashboard. Trang `/setup` dẫn bạn qua các bước chọn nhà cung cấp LLM, đăng nhập và chọn model.
Sau đó tạo API key trong **API Keys**, rồi làm tiếp phần [cài nhanh](./quick-start) trên máy của
từng lập trình viên.

## Các dịch vụ

| Dịch vụ | Image | Cổng trên host | Vai trò |
|---|---|---|---|
| `cortex-api` | `cortex-api` | `${API_BIND:-0.0.0.0}:4000` | REST API, Conductor, phục vụ dashboard |
| `cortex-mcp` | `cortex-mcp` | `8318` → 8317 | MCP endpoint mà agent kết nối tới |
| `gitnexus` | `cortex-gitnexus` | `127.0.0.1:4848` | Đồ thị code AST và việc index |
| `qdrant` | `qdrant/qdrant:v1.13.6` | `127.0.0.1:6333`, `6334` | Kho vector |
| `ollama` | `ollama/ollama:0.34.4` | không | Embedding chạy local |
| `llm-proxy` | `eceasy/cli-proxy-api` | không | Cổng LLM (CLIProxy) |
| `watchtower` | `containrrr/watchtower` | không | Kéo image Cortex mới về |

Ba image của Cortex có cả mục `image` lẫn `build`. Compose dùng image trong
`CORTEX_IMAGE_NAMESPACE` (mặc định `ghcr.io/lktiep`), hoặc build từ mã nguồn của bạn bằng
`docker compose build`.

Dữ liệu nằm trong các named volume: `qdrant-data`, `api-data` (cơ sở dữ liệu SQLite),
`gitnexus-data`, `cliproxy-auth` và `ollama-models`.

## Đưa hub ra internet {#put-it-on-the-internet}

Agent trên các máy khác cần gọi được tới `cortex-mcp`. Bản cài của chính dự án dùng Cloudflare
Tunnel, nên không phải mở cổng nào trên host. Dùng cách nào thì cũng đặt các biến sau trong
`infra/.env`:

| Biến | Để làm gì |
|---|---|
| `EXTERNAL_MCP_URL` | Địa chỉ agent kết nối tới (`/mcp` được nối thêm vào). Dashboard hiển thị nó ở **Settings** và trong lệnh chạy worker. Để trống thì dashboard hiển thị địa chỉ https mà agent gần nhất đã dùng để kết nối. |
| `API_AUTH=required` | Khi đó `/api` chỉ trả lời loopback, MCP gateway, API key, và trình duyệt đã qua Cloudflare Access (khi đặt đủ hai biến `CF_ACCESS_*`). Không đặt thì ai gọi nó cũng trả lời. |
| `INTERNAL_API_SECRET` | Dùng chung giữa `cortex-api` và `cortex-mcp`. Tạo bằng `openssl rand -hex 32`. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Team domain và application audience tag của Cloudflare Access. |
| `API_BIND=127.0.0.1` | Chỉ mở cổng API trên chính host này, đủ cho một `cloudflared` chạy trên đó. |

::: danger Dashboard không có đăng nhập
Ai mở được dashboard là quản lý được key và duyệt được user gate. Hãy đặt nó sau một lớp kiểm soát
truy cập như Cloudflare Access, và đặt `API_AUTH=required`.
:::

Mọi biến đều có trong [Biến môi trường và cấu hình](../reference/configuration).

## Index code

Trên dashboard, tạo một project trong **Organizations**, mở nó và dùng **Connect Git Repository**
(URL của repo, kèm username và token nếu repo private). Hoặc đặt `DEFAULT_REPO` để index một repo
ngay lần khởi động đầu. Sau mỗi lần push, agent gọi `cortex_code_reindex(repo, branch)` để giữ đồ
thị luôn mới. Index của một branch bị xóa sau `BRANCH_RETENTION_DAYS` ngày (mặc định 14) không
được index lại, hoặc khi branch đã merge hay bị xóa; branch mặc định không bao giờ bị xóa.

## Cập nhật

Watchtower kiểm tra mỗi 300 giây và chỉ cập nhật các container có nhãn cho phép: `cortex-api`,
`cortex-mcp` và `gitnexus`. Bản phát hành được tạo từ CI (xem [Script](../reference/scripts#release)),
CI gắn tag `v<version>` và `stable` cho image.

## Các script cài đặt cũ

`scripts/bootstrap.sh` (menu cho cài đặt của admin, onboarding thành viên và gỡ cài đặt) và
`scripts/install-hub.sh` (kiểm tra Docker và pnpm, chép file env, chạy Compose và health check)
vẫn còn. Các bước ở trên mới là cách `infra/` hiện tại cần.
