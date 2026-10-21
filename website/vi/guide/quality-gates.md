# Quality gate

Cortex Hub kiểm tra công việc của agent ở ba thời điểm: kế hoạch trước khi bắt đầu, mỗi lần commit,
và lúc kết thúc phiên. Bước kiểm tra commit là bắt buộc; hai bước còn lại được ghi nhận.

## Trước: chấm điểm kế hoạch

`cortex_plan_quality(plan, request)` chấm một kế hoạch từ 0 đến 10 theo tám tiêu chí: đầy đủ, cụ
thể, khả thi, ý thức về rủi ro, phạm vi, thứ tự, khả năng kiểm thử và mức ảnh hưởng. Đây là một
heuristic chạy trên hub, không gọi LLM.

| Tham số | Ý nghĩa |
|---|---|
| `plan` | Các bước đánh số, file mà mỗi bước đụng tới, cách kiểm chứng |
| `request` | Yêu cầu gốc, dùng để đánh giá độ đầy đủ và phạm vi |
| `iteration` | Từ 1 đến 3 (mặc định 1) |
| `threshold` | Điểm đạt (mặc định 8.0) |
| `plan_type` | `feature`, `bugfix`, `refactor`, `architecture`, `migration`, `general` |

Dưới ngưỡng, agent chỉnh lại kế hoạch và gọi lại với `iteration + 1`. Sau lần thứ ba, nó chuyển lên
cho bạn kèm các gợi ý cải thiện. `/cs` yêu cầu agent làm việc này với mọi thay đổi không tầm thường.

## Trong lúc làm: gate commit

Trong Claude Code, các hook đã cài từ chối `git commit` cho tới khi, trong phiên này:

- `cortex_session_start` đã chạy,
- đã dùng một tool khám phá code, và
- build, typecheck và lint đều đã qua.

`--no-verify`, `git commit -n` và `LEFTHOOK=0` bị từ chối thẳng. Gate qua là chứng nhận cho cây
làm việc, không phải cho phiên: bất kỳ thao tác ghi file nào sau đó đều đóng gate lại, nên hãy chạy
gate sau cùng rồi commit. Quy tắc chính xác, gồm cả lệnh nào được tính, có trong [Hook](../reference/hooks).

Trình cài đặt cũng thiết lập [lefthook](https://github.com/evilmartians/lefthook) từ
`.cortex/project-profile.json`, để các bước kiểm tra tương tự chạy như git hook cho người và agent
không dùng Claude Code. Nếu repo đã có git hook riêng, chỉ hook post-push của Cortex được gộp vào.

## Sau: báo cáo kết quả

`/ce` chạy các gate và báo cáo bằng `cortex_quality_report`:

| Tham số | Ý nghĩa |
|---|---|
| `gate_name` | Cái được kiểm tra, ví dụ `Session Quality` |
| `passed` | `true` hoặc `false` |
| `score` | Tùy chọn, thang 100 |
| `details` | Tùy chọn, log hoặc ghi chú |

Hub xếp loại mỗi báo cáo và chia thành bốn khía cạnh: **Build**, **Regression**, **Standards** và
**Traceability**. Gọi `cortex_quality_report` không mở được gate commit; chỉ có gate qua thật mới mở.

## Xem ở đâu

- Trang **Quality** trên dashboard: bốn khía cạnh, phân bố xếp loại và xu hướng 30 ngày.
- `cortex_tool_stats(days, agentId, projectId)`: agent đã dùng những tool Cortex nào, mặc định trong
  7 ngày gần nhất. Trang **Usage** của dashboard hiển thị cùng dữ liệu dưới mục Cortex Tool Savings.
