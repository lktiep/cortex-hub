# Hook

[Trình cài đặt](./installer) đặt tám hook của Claude Code vào `.claude/hooks/` và khai báo chúng
trong `.claude/settings.json`. Chúng giữ agent đi đúng quy trình Cortex: mở phiên, nhớ lại, tìm code,
qua gate, rồi mới commit. Đây là các shell script; vài cái có chứa JavaScript bên trong và cần
`node`. `run-hook.mjs` nằm cạnh chúng và chạy bản `.sh` hoặc `.ps1` của hook, tùy theo nền tảng.

| Hook | Phiên bản | Sự kiện và matcher | Có chặn? |
|---|---|---|---|
| `session-init.sh` | v7.3 | `SessionStart` | Không; reset các marker |
| `subagent-start.sh` | v1.0 | `SubagentStart` | Không; thêm ngữ cảnh |
| `enforce-session.sh` | v6.2 | `PreToolUse`: `Edit\|Write\|NotebookEdit\|Bash` | Có |
| `enforce-commit.sh` | v5.1 | `PreToolUse`: `Bash` | Có |
| `nudge-lookup.sh` | v1 | `PreToolUse`: `Bash\|Grep\|Glob` và các tool code của cortex | Không; một dòng gợi ý |
| `recall-notes.sh` | v1 | `PreToolUse`: `Read\|Edit\|Write\|MultiEdit\|NotebookEdit` | Không; hiển thị ghi chú theo file |
| `track-quality.sh` | v4.3 | `PostToolUse`, mọi tool | Không; ghi lại bằng chứng |
| `session-end-check.sh` | v7.1 | `SessionEnd`, timeout 15 giây | Không; đóng phiên |

Hook chặn sẽ thoát với mã 2 và một thông báo bắt đầu bằng `BLOCKED:`. Claude Code đưa thông báo đó
cho agent, nhờ vậy agent biết cần chạy gì.

## Marker {#markers}

Các hook chia sẻ trạng thái qua các file trong `.cortex/.session-state/`. `track-quality.sh` ghi
chúng sau mỗi lần gọi tool; các hook chặn thì đọc chúng. Một marker chỉ được tính khi nó chứa dòng
`tool=<name> at=<time>`, nên tạo một file rỗng không mở được gate nào.

| Marker | Được ghi sau |
|---|---|
| `session-started`, `session-id` | `cortex_session_start` (id là `sess_…` của hub) |
| `knowledge-recalled`, `memory-recalled` | `cortex_knowledge_search`, `cortex_memory_search` |
| `discovery-used` | `cortex_code_search`, `cortex_code_context`, `cortex_code_impact`, `cortex_cypher` |
| `gate-build`, `gate-typecheck`, `gate-lint` | `pnpm\|npm\|yarn build`/`typecheck`/`lint`, `cargo build`, `cargo clippy`, `go build`, `go vet`, `dotnet build`, khi output không có dấu hiệu lỗi |
| `quality-gates-passed` | Cả ba gate; hoặc build và lint khi hồ sơ project không có typecheck |
| `quality-reported` | `cortex_quality_report` |
| `tasks-checked`, `changes-checked` | `cortex_task_pickup`; `cortex_detect_changes` hoặc `cortex_changes` |
| `session-ended` | `cortex_session_end` |
| `agents/<agent_id>/…` | Phần gợi nhớ kiến thức và bộ nhớ của riêng một subagent |

Tìm kiến thức và bộ nhớ là nhớ lại, không phải khám phá code: chỉ chạy `/cs` thì chưa tính là đã tìm
code.

Một lệnh gate có output chứa `ERR_PNPM`, `ELIFECYCLE`, `error TS<n>`, `Command failed`, `FAIL `,
`Exit status <n>` hoặc dòng ESLint `✖ N problems (N errors…` với số lỗi lớn hơn không sẽ không bật
marker của nó, kể cả khi lệnh thoát với mã 0.

## `session-init.sh`

Chạy ở mọi `SessionStart`. Với phiên mới (khởi động hoặc `/clear`), nó xóa mọi marker của phiên trước
để không gì còn hiệu lực lâu hơn một cuộc hội thoại, và in lời nhắc chạy `/cs`. Với `compact` và
`resume`, nó giữ nguyên marker: một task dài không bị chặn lại giữa chừng chỉ vì ngữ cảnh bị nén. Dù
trường hợp nào, nó cũng in `clientSessionId` của cuộc hội thoại để `/cs` truyền cho
`cortex_session_start`.

Nó cũng xóa các bản ghi hội thoại cũ hơn một tuần, và bản ghi gợi ý hoặc ghi chú theo file cũ hơn
một ngày.

## `subagent-start.sh`

Khi đang có phiên mở và gate không bị tắt, nó đưa cho mỗi subagent một bản hướng dẫn ngắn: phần gợi
nhớ của agent cha không có trong ngữ cảnh của bạn, hãy tự chạy `cortex_knowledge_search` và
`cortex_memory_search` cho task của mình trước khi sửa file, dùng `cortex_code_context` hoặc
`cortex_code_search` để tìm code, tìm trong kiến thức trước khi sửa một lỗi. Xem
[Subagent](../guide/subagents).

## `enforce-session.sh`

Trước `cortex_session_start`:

- `Edit`, `Write` và `NotebookEdit` bị từ chối.
- Lệnh Bash ghi file bị từ chối: chuyển hướng vào file (`>`, `>>`), `sed -i`, `tee`, `dd`,
  `truncate`, `install -`, và `git add|commit|push|reset`, `rm`, `mv`, `cp`, `mkdir`, `touch`,
  `chmod`. Chuyển hướng tới `/dev/*` và `>&2` không tính là ghi.
- Lệnh Bash bắt đầu bằng `grep`, `egrep`, `fgrep`, `rg`, `ag`, `ack`, `find`, `fd` hoặc `git grep`
  bị từ chối. Đứng sau một pipe thì được phép: `pnpm build | grep error` là lọc output, không phải
  tìm code.
- Lệnh chỉ đọc thì qua: `ls`, `cat`, `head`, `tail`, `git status|log|diff|show`, các lệnh của trình
  quản lý gói, v.v.

Sau `cortex_session_start`:

- Cho tới khi có một lần gọi khám phá code, lệnh Bash bắt đầu bằng một lệnh tìm code bị từ chối.
- Mọi thao tác ghi file, bằng tool hay qua Bash, đều cần cả `knowledge-recalled` lẫn
  `memory-recalled`. Điều này áp dụng suốt phiên; một lần gọi khám phá không gỡ được nó.
- Một subagent (lời gọi có mang `agent_id`) cần marker gợi nhớ của riêng nó trong
  `agents/<agent_id>/`; marker của agent cha không được tính.

::: info
Script này còn có các nhánh từ chối tool `Grep` và `Glob`. Matcher của nó trong `settings.json`
không gồm hai tool đó, nên các nhánh này không bao giờ chạy; trong Claude Code chỉ có lệnh tìm
kiếm qua Bash bị giữ lại.
:::

## `enforce-commit.sh`

Với mọi lệnh Bash, đầu tiên nó từ chối mọi thứ bỏ qua git hook của repo: `--no-verify` (hoặc bất kỳ
tiền tố nào của nó, như `--no-veri`), `git commit -n`, và `LEFTHOOK=0` hoặc `LEFTHOOK=false`. Chữ nằm
trong dấu nháy và heredoc được bỏ qua, nên một commit message có nhắc tới cờ đó vẫn ổn. `git push -n`
là chạy thử và vẫn được phép.

Với lệnh bắt đầu bằng `git commit`, nó cần:

- `session-started`;
- `discovery-used`;
- `quality-gates-passed`.

Gọi `cortex_quality_report` không thay được cho các gate. Không có báo cáo thì commit vẫn qua, kèm
một lời nhắc. Sau `git push`, nó nhắc agent chạy `cortex_code_reindex`.

### Build xanh là chứng nhận cho cây làm việc

Bất kỳ thao tác ghi nào sau khi gate đã qua đều xóa `quality-gates-passed` và ba marker `gate-*`:
một lần `Edit`, `Write` hoặc `NotebookEdit`, hoặc một lệnh Bash chuyển hướng vào file hay chạy
`sed -i`, `tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `patch` hoặc `git apply`. Một lệnh gate tự ghi log
của nó (`pnpm build | tee build.log`) không xóa marker nó vừa bật. Hãy chạy gate sau cùng, rồi commit.

## `nudge-lookup.sh`

Không bao giờ chặn. Khi một lệnh grep toàn repo tìm một symbol hay một từ, nó thêm một dòng nêu lời
gọi cortex sẽ trả lời được câu đó, tối đa một lần sau mỗi vài lần tìm của một agent. Nó im lặng với
chuỗi chính xác (biến môi trường, khóa config, thông báo lỗi), với các lần tìm trong file đã biết hoặc
ngoài repo, với tìm theo tên file, và ngay sau một lần tra cứu cortex. `CORTEX_NUDGE=off` để tắt.
Không có `node` thì nó không làm gì.

## `recall-notes.sh`

Không bao giờ chặn. Trước khi agent đọc hoặc sửa một file, nó hiển thị các rủi ro, bài học và cách
sửa lỗi đã được lưu bằng `cortex_knowledge_store(files: [...])` cho đường dẫn đó. Nó hỏi hub một lần
cho cả project (`cortex_file_notes`) và cache câu trả lời trong 10 phút; hub không trả lời thì 2 phút
sau mới hỏi lại, và trong lúc đó hook im lặng. Nó hiển thị tối đa ba ghi chú mỗi file, một lần cho
mỗi cuộc hội thoại và agent. `CORTEX_NOTES=off` để tắt. Không có `node` thì nó không làm gì. Xem
[Ghi chú theo file](../guide/knowledge-memory#file-notes).

## `track-quality.sh`

Chạy sau mọi lần gọi tool và ghi các marker ở trên. Nó cũng ghi session id của hub dưới cuộc hội
thoại đã mở phiên đó (`conversations/<clientSessionId>`), để hook lúc thoát đóng đúng phiên khi
nhiều cuộc hội thoại dùng chung một thư mục làm việc.

## `session-end-check.sh`

Khi phiên Claude Code kết thúc mà `/ce` chưa đóng phiên trên hub, nó đóng phiên với `auto: true`. Hub
ghi phiên đó là `abandoned` và loại nó khỏi phần gợi nhớ của các phiên sau. Nó tìm hub theo cách
agent tìm: `CORTEX_MCP_URL` hoặc `HUB_MCP_URL` cùng với `HUB_API_KEY`, nếu không thì mục `cortex-hub`
trong MCP config của project hoặc của máy. Nó cần `python3`. `settings.json` cho nó 15 giây.

## `gate-off`: khi hub bị sập

Nếu không gọi được tới hub, các gate không có lối nào để qua. Hãy nói rõ chuyện đó, rồi ghi lý do:

```bash
echo 'hub unreachable' > .cortex/.session-state/gate-off
```

Việc ghi file này không bao giờ bị chặn. Khi file còn đó, `enforce-session.sh` cho mọi thứ qua, còn
bản hướng dẫn cho subagent, lời gợi ý tra cứu và ghi chú theo file đều im lặng. Gate commit vẫn áp
dụng. Phiên mới kế tiếp sẽ xóa file này.

## Công tắc {#switches}

| Biến | Tác dụng |
|---|---|
| `CORTEX_NUDGE=off` | Tắt `nudge-lookup.sh` |
| `CORTEX_NOTES=off` | Tắt `recall-notes.sh` |
| `CORTEX_MCP_URL` hoặc `HUB_MCP_URL`, cùng `HUB_API_KEY` | Địa chỉ hub và key cho `session-end-check.sh` và `recall-notes.sh`. Không có thì chúng dùng mục MCP `cortex-hub` |

## Gemini và Antigravity

Trình cài đặt đặt năm hook trong số này vào `.gemini/hooks/`: session-init, enforce-session,
enforce-commit, track-quality và session-end-check.

## Kiểm thử hook

`scripts/test-hooks.sh` đưa cho từng hook những payload từng lọt qua một phiên bản đã phát hành. Một
ca thất bại ở đó nghĩa là một lỗ hổng cũ đã quay lại.
