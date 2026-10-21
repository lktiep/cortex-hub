# Subagent

Một subagent của Claude Code khởi đầu chỉ với prompt mà agent cha viết cho nó, không có gì khác.
Nó không có phần gợi nhớ mà `/cs` đã làm, nên có thể sửa file mà không biết các cách sửa lỗi và rủi
ro team đã lưu cho file đó. Hook coi nó là một agent riêng.

## Chuyện gì xảy ra

1. **Khi nó khởi động**, hook `subagent-start.sh` (SubagentStart) thêm một ghi chú ngắn vào ngữ
   cảnh của nó: nó đang ở trong một phiên Cortex, phần gợi nhớ của agent cha không nằm trong ngữ
   cảnh của nó, và nó phải tự chạy `cortex_knowledge_search` và `cortex_memory_search` cho task của
   mình trước khi sửa file. Nó cũng nhận được các quy tắc tìm code.
2. **Khi nó định sửa file**, `enforce-session.sh` tìm các marker gợi nhớ được ghi dưới id riêng của
   subagent (`.cortex/.session-state/agents/<agent_id>/`). Marker của agent cha không được tính.
   Cho tới khi subagent chạy cả hai lệnh tìm, mọi thao tác sửa của nó đều bị từ chối.
3. **Khi nó đọc hoặc sửa một file** có ghi chú gắn kèm, `recall-notes.sh` hiển thị chúng cho nó,
   mỗi subagent một lần. Xem [ghi chú theo file](./knowledge-memory#file-notes).

Bản thân phiên là dùng chung: subagent không gọi `cortex_session_start`. Nếu thư mục làm việc không
có phiên Cortex, hoặc gate đã được khai báo tắt, hook SubagentStart không nói gì.

## Viết prompt cho subagent

Subagent tự tìm kiếm theo task của nó, nên hãy mô tả task bằng những từ mà một lần tìm kiếm dùng
được: thông báo lỗi, tính năng, các file. Một prompt kiểu "sửa cái bug mình vừa bàn" không cho nó gì
để gợi nhớ.
