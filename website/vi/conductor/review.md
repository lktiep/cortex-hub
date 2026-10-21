# Review, gate và escalate

Task work có `reviewRequired: true` trừ khi kế hoạch nói khác. Worker làm xong một task sẽ báo nó để
review kèm link PR và kết quả test, và hub báo cho lead.

## Thông báo, không phải hỏi vòng {#notices-not-polling}

Thông báo cho lead đến ngay trong kết quả của lần gọi tool hub kế tiếp, dưới một khối
`📋 Conductor:`, mỗi thông báo một dòng. Chúng được gửi tới API key đã tạo task. Dashboard hiển thị
cùng thông tin đó.

| Loại | Khi nào |
|---|---|
| `review_ready` | Một task đang chờ review, kèm PR và kết quả test |
| `escalated` | Một task thất bại hoặc bị từ chối hai lần |
| `gate_ready` | Các phụ thuộc của một gate đã xong; nó đang chờ duyệt |
| `capacity` | Mọi tuyến của một task đều hết quota; nó chờ tới lần reset sớm nhất |
| `no_worker` | Không worker nào đang kết nối nhận được một task |

## Review một task

1. `cortex_task_status(taskId)` để lấy URL PR, kết quả test và log.
2. `gh pr diff <pr>` để đọc thay đổi.
3. `cortex_task_review(taskId, verdict: "approve")`, hoặc
   `cortex_task_review(taskId, verdict: "reject", feedback: "...")`.

**Approve** hoàn tất task và khởi động các task phụ thuộc vào nó. Approve không merge: task phụ thuộc
bắt đầu từ `origin/<base branch>`, nên nếu nó cần code vừa được duyệt, hãy merge PR trước rồi mới
approve. Các task dùng chung một `branch` thì chồng tiếp lên nhau.

**Reject** trả chính task đó về `pending` với phản hồi của bạn được thêm vào phần review. Lần thử kế
tiếp tiếp tục trên cùng branch, ưu tiên trên cùng máy. Hãy viết phản hồi cụ thể: file nào, vấn đề gì,
kết quả bạn mong đợi. Đừng tạo subtask kiểu review hay sửa lại.

## Gate {#gates}

Gate là một task `kind: "gate"` mà không worker nào chạy. Nó chờ tới khi các phụ thuộc hoàn tất, rồi
chờ duyệt.

- `approver: "user"` (mặc định): chỉ con người đóng được, từ dashboard. Lời gọi MCP bị từ chối. Dùng
  cho thiết kế, mockup và duyệt kế hoạch.
- `approver: "lead"`: lead đóng nó bằng `cortex_task_review`.

Từ chối một gate sẽ trả từng task work phụ thuộc trực tiếp của nó về kèm phản hồi, và gate lại chờ
tiếp. Hãy treo phần việc sau vào gate, không phải vào task mà gate kiểm tra.

::: warning
Dashboard không có đăng nhập. Ai mở được nó là duyệt được user gate. Hãy đặt nó sau một lớp kiểm soát
truy cập; xem [Tự dựng hub](../guide/self-host#put-it-on-the-internet).
:::

## Escalate

Task thất bại hai lần, hoặc bị từ chối hai lần, sẽ bị escalate. Nó giữ nguyên trạng thái nhưng bộ phân
phối bỏ qua nó, và nó xuất hiện trong mục **Needs you** trên dashboard. Task hết quota không tính là
thất bại; nó chuyển sang tuyến kế tiếp.

Để xử lý một escalation, đọc log và các lần review của nó, rồi chọn một trong hai:

- đổi tuyến: `cortex_task_route(taskId, executor, model, effort, fallback, pinnedAgent, files,
  clearEscalation: true)`. Chỉ các trường bạn truyền mới thay đổi; `null` xóa một trường. Task đang
  chạy sẽ bị dừng và trả về `pending` trước. Hoặc
- thay thế nó. Không có tool nào sửa mô tả task:
  1. tạo task thay thế bằng `cortex_task_tree_create({ parentId, tasks: [...] })`;
  2. trỏ từng task phụ thuộc sang nó bằng `cortex_task_route({ taskId, dependsOn: [<stored ids>] })`
     (ở đây `dependsOn` nhận id đã lưu, không phải key trong kế hoạch);
  3. hủy task cũ bằng `cortex_task_cancel({ taskId, reason })`.

Các task phụ thuộc vào một task đã hủy sẽ bị chặn cho tới khi bạn trỏ chúng sang chỗ khác.

## Trên dashboard

**Conductor** (`/conductor` trên dashboard) hiển thị mỗi kế hoạch dưới dạng cây cùng các phụ thuộc và
gate, thẻ agent cập nhật trực tiếp, và một bảng chi tiết cho từng task gồm log, kết quả, review và
định tuyến. User gate được duyệt ở đây. **Delete pipeline** xóa một kế hoạch.
