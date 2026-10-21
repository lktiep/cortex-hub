# Conductor

Conductor cho phép một agent, gọi là **lead**, lập kế hoạch công việc thành một cây task để các
**worker** trên máy khác nhận và chạy. Mỗi worker chạy một task trong git worktree riêng bằng một
engine có trên máy (`agy`, `claude`, `codex` hoặc `gemini`), push một branch, mở PR rồi trả lại để
review.

[Mở trang giới thiệu Conductor →](/cortex-hub/conductor/index.html){target="_self"}

```
 lead (MCP client bất kỳ)               hub                       worker (cw)
 ────────────────────────               ───                       ───────────
 cortex_task_tree_create ───────▶  kế hoạch, phụ thuộc, ───────▶  worktree → engine → PR
 cortex_task_review      ◀───────  khóa file, quota     ◀───────  review / fail / quota
          ▲                         📋 thông báo
          └──────────── review_ready · escalated · capacity · gate_ready · no_worker
```

## Làm lead

Phiên MCP nào kết nối tới hub cũng có thể làm lead. Hướng dẫn cho lead nằm trong
[`scripts/orchestrator-prompt.md`](https://github.com/lktiep/cortex-hub/blob/master/scripts/orchestrator-prompt.md).
Trong Claude Code:

> Read `scripts/orchestrator-prompt.md` and act as the conductor lead.

Dùng cho lead một key mà không worker nào dùng. Thông báo được gửi một lần tới key đã tạo task, cho
phiên nào gọi tool trước, nên một worker dùng chung key sẽ lấy mất thông báo của lead.

## Một kế hoạch

Một lần gọi tạo cả kế hoạch. Đặt nó dưới một task gốc có `kind: "group"`, và cho mọi mục ở cấp cao
nhất `parentKey` là key của gốc đó; nếu không, dashboard sẽ hiển thị mỗi task như một kế hoạch riêng.

```
cortex_task_tree_create(
  tasks: [
    { key: "JWT", title: "JWT refresh token rotation", kind: "group" },
    { key: "API", title: "Add rotation endpoint", parentKey: "JWT",
      files: ["apps/api/src/auth.ts"], priority: "high" },
    { key: "TESTS", title: "Test the rotation endpoint", parentKey: "JWT",
      files: ["apps/api/src/auth.test.ts"], dependsOn: ["API"] },
    { key: "OK", title: "Approve before merge", parentKey: "JWT",
      kind: "gate", approver: "user", dependsOn: ["TESTS"] }
  ]
)
```

Hub kiểm tra key không trùng và đồ thị phụ thuộc không có vòng (thông báo lỗi nêu rõ vòng đó), rồi
trả về id đã lưu của từng key và chạy một lượt phân phối.

Với kế hoạch hơn khoảng 15 task, hãy ghi nó ra một file JSON (`{"parentId"?, "projectId"?,
"tasks": [...]}`) và gọi `cortex_task_tree_create(upload: true)`. Lệnh này trả về một câu curl dùng
một lần để nhập file trong một request. Đường link dùng được cho một kế hoạch trong 15 phút.

### Các trường của task

| Trường | Dùng để |
|---|---|
| `key`, `title`, `description` | Mô tả phải tự đứng được: mục tiêu, tiêu chí nghiệm thu, các file, lệnh test. Các agent không dùng chung bộ nhớ |
| `kind` | `work` (mặc định), `gate` hoặc `group` |
| `parentKey`, `dependsOn` | Các key trong cùng lần gọi |
| `priority` | `critical`, `high`, `medium`, `low`, hoặc 1–10; số nhỏ chạy trước |
| `requiredCapabilities` | Các tag mà worker phải có, như `backend` hay `testing` |
| `executor`, `model`, `effort`, `fallback`, `pinnedAgent` | Định tuyến; xem bên dưới |
| `files`, `branch` | Khóa file và tên branch |
| `reviewRequired` | Mặc định `true` với task work |
| `approver` | Với gate: `user` (mặc định) hoặc `lead` |
| `context.testCommand`, `context.allowEmpty`, `context.estimate` | Lệnh test, cho phép kết quả không có thay đổi, ước lượng theo ngày |

### Các loại task

- **work** được phân cho worker.
- **group** không bao giờ được phân. Nó hoàn tất khi mọi task bên dưới (trừ task đã hủy) đã hoàn tất,
  nhờ vậy task khác có thể phụ thuộc vào cả một giai đoạn. Hủy một group sẽ hủy mọi thứ bên dưới; hủy
  task gốc để dừng cả kế hoạch.
- **gate** không bao giờ được phân. Khi các phụ thuộc của nó hoàn tất, nó chờ duyệt. Gate `user` chỉ
  được đóng từ dashboard; lời gọi MCP để đóng nó bị từ chối. Gate `lead` được đóng bằng
  `cortex_task_review`. Từ chối một gate sẽ trả các task work phụ thuộc trực tiếp của nó về kèm
  phản hồi. Hãy treo phần việc sau vào gate, không phải vào task mà gate kiểm tra.

## Hub phân phối thế nào

Một task work sẵn sàng khi nó đang `pending`, mọi phụ thuộc đã hoàn tất, không bị escalate, và không
file nào trong `files` của nó chồng lên file của một task đang chạy. Hai task chồng nhau khi một đường
dẫn trùng với đường dẫn kia hoặc nằm dưới một tiền tố thư mục của nó (thư mục kết thúc bằng `/`; không
dùng glob). Task sẵn sàng được gửi đi theo độ ưu tiên, rồi theo độ cũ.

Với mỗi task, hub thử các tuyến theo thứ tự: `{executor, model, effort}`, rồi từng mục trong
`fallback`, rồi mặc định của project (`claude` / `opus` nếu không đổi). Một tuyến lấy worker đủ điều
kiện đầu tiên: đang kết nối và rảnh, đã đăng ký cho project, không bị ghim cho task khác, có đủ
capability yêu cầu, cung cấp engine và model đó, và chưa bị ghi nhận là hết quota cho tuyến đó. Trong
số đó, hub ưu tiên máy đã chạy task này lần trước.

Khi không ai nhận được một task đã sẵn sàng, task ghi lại lý do:

| Lý do chờ | Ý nghĩa | Lead có được báo |
|---|---|---|
| `capacity` | Mọi tuyến đều bị chặn vì quota; chờ tới lần reset sớm nhất | Một lần (`capacity`) |
| `no_worker` | Không worker nào đang kết nối có thể nhận nó (engine, model, capability, ghim) | Một lần (`no_worker`) |
| `lock` | Một task đang chạy giữ một trong các file của nó | Không |

Task không có `files` không bao giờ giữ khóa, nên có thể đụng nhau với task khác. Hãy đặt `files` cho
mọi task work.

## Lease và những máy biến mất

Mỗi phút, hub thu hồi các task có lease (24 giờ, được gia hạn khi có tiến độ) đã hết hạn, hoặc có
worker đã 30 phút không thấy đâu. Task bị thu hồi tính là một lần thất bại và quay về `pending`. Các
bản ghi quota đã hết hạn cũng được xóa trong cùng lượt đó.

## Tiếp theo

- [Chạy một worker](./workers): cài `cw` và kết nối một máy.
- [Review, gate và escalate](./review): lead làm gì với công việc đã xong.
- [MCP tool](../reference/mcp-tools#conductor): mọi tool và tham số của Conductor.
- Trạng thái của từng phần, cùng các test kèm theo, có trong
  [`docs/conductor.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor.md#current-status).
