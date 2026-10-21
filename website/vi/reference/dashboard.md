# Dashboard

Dashboard là một ứng dụng Next.js (`apps/dashboard-web`) do container `cortex-api` phục vụ ở cổng
4000. Nó hiển thị những gì hub biết, và là nơi con người, chứ không phải agent, đưa ra quyết định:
API key, nhà cung cấp LLM, user gate.

::: warning
Dashboard không có đăng nhập. Ai mở được nó là tạo được key và duyệt được gate. Hãy để nó trong mạng
nội bộ hoặc sau một access proxy, và đặt `API_AUTH=required`. Xem
[Tự dựng hub](../guide/self-host#put-it-on-the-internet).
:::

## Các trang

| Trang | Đường dẫn | Có gì |
|---|---|---|
| Dashboard | `/` | Tổng quan hệ thống: lượng tiết kiệm nhờ tool cortex, trí tuệ, kết nối nhanh, hoạt động gần đây, tài nguyên hệ thống |
| Organizations | `/orgs` | Các tổ chức và project của chúng. Thêm repo (GitHub, GitLab, Bitbucket, Azure hoặc local), kèm token tùy chọn cho repo private. Tìm kiếm xuyên repo nằm trong một tổ chức |
| Project | `/projects?id=…` | Một project: tiến độ index, các branch, index lại, chạy lại embedding bộ nhớ, quét tài liệu của repo vào kho kiến thức, chuyển sang tổ chức khác, xóa |
| Knowledge | `/knowledge` | Kho kiến thức theo project: tài liệu, chunk, số lần được tìm thấy, và các file mà mỗi ghi chú được hiển thị cho |
| API Keys | `/keys` | Tạo, sửa và thu hồi các key mà agent và worker dùng. Key mới chỉ hiển thị một lần |
| LLM Providers | `/providers` | Các nhà cung cấp (API key hoặc OAuth) và định tuyến model chat, model embedding, kèm fallback |
| Usage | `/usage` | Lượng token và request theo thời gian, cùng lượng tiết kiệm của tool cortex trong 7 ngày |
| Quality | `/quality` | Các báo cáo chất lượng, chấm theo bốn khía cạnh |
| Conductor | `/conductor` | Kế hoạch dạng cây, thẻ agent cập nhật trực tiếp, chi tiết task, **Needs you**, user gate, **Delete pipeline** |
| Sessions | `/sessions` | Các phiên của agent và các lần bàn giao, kèm chi tiết |
| Settings | `/settings` | Endpoint và truy cập từ xa, MCP config để sao chép, cách chạy worker, công tắc LLM, cấu hình hub, tùy chọn thông báo, các dịch vụ Docker, môi trường |
| Setup | `/setup` | Trình hướng dẫn lần đầu: chào mừng, đăng nhập nhà cung cấp, chọn model |

## Agent thấy gì từ đây

Mọi thứ trên dashboard đến từ cùng API mà các MCP tool dùng. `cortex_quality_report` của một agent
hiện ở **Quality**, phiên của nó ở **Sessions**, kiến thức của nó ở **Knowledge**, task Conductor của
nó ở **Conductor**. Chỉ con người mới duyệt được [user gate](../conductor/review#gates); lời gọi MCP bị
từ chối.
