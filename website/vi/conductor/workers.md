# Chạy một worker

Worker là một chương trình Node nhỏ, `cortex-worker.mjs`, kết nối một máy tới hub, nhận task
Conductor và chạy chúng bằng một coding engine cài trên máy đó. `cw` là giao diện dòng lệnh của nó.
Danh sách đầy đủ lệnh và cờ có trong [tra cứu `cw`](../reference/cli).

## Trước khi bắt đầu

- Node 20 trở lên, và git. `gh` không bắt buộc; không có nó, worker báo một URL compare thay vì mở PR.
- Ít nhất một engine đã cài và đăng nhập: `agy`, `claude`, `codex` hoặc `gemini`. Lệnh cài cho từng
  engine có trong
  [`docs/conductor/setup.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor/setup.md).
- Một bản clone của project mà worker sẽ làm.
- Một API key cho worker lấy từ dashboard (**API Keys**). Đừng dùng lại key của lead.
- Mỗi engine cần một mục MCP `cortex-hub` với key đó, để nó báo được tiến độ. Xem
  [Nhiều IDE](../guide/multi-ide#writing-the-entry-yourself).

## Cài và khởi động {#install-and-start}

Chạy lệnh này bên trong bản clone:

::: code-group

```bash [macOS / Linux]
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh \
  | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub https://<your-mcp-host>
```

```powershell [Windows]
$env:CORTEX_API_KEY="<worker-api-key>"
iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host>
```

:::

Trang **Settings** của dashboard có sẵn lệnh này với địa chỉ hub của bạn điền sẵn, trong mục
**Run a worker**.

Script khởi tạo sẽ:

1. tải `cortex-worker.mjs` từ hub của bạn về `~/.cortex/worker/`;
2. cài `cw` vào `~/.local/bin/cw` (Windows: `%USERPROFILE%\.local\bin\cw.cmd`) và thêm thư mục đó
   vào PATH qua `~/.zshrc`, `~/.bashrc` hoặc `~/.profile` (Windows: PATH của người dùng).
   `CORTEX_SKIP_CW=1` để bỏ qua bước này;
3. chạy `cw check --if-changed` (bỏ qua bằng `CORTEX_SKIP_CHECK=1`);
4. chạy lệnh bạn truyền vào, ở đây là `start --daemon`.

Nếu `cw` không có trong PATH, các lệnh tương tự vẫn chạy được dưới dạng
`node ~/.cortex/worker/cortex-worker.mjs <command>`.

## Dùng hằng ngày

```bash
cw ls                # các agent trên máy này, có đánh số
cw status 1          # trạng thái chạy, task, lần đăng ký gần nhất
cw tail 1 -f         # engine đang in gì cho task hiện tại
cw logs 1 -f         # log của chính worker
cw restart 1         # chạy nền, với các thiết lập của lần khởi động trước
cw stop --all
cw update            # thay cortex-worker.mjs bằng phiên bản của hub
cw doctor --probe    # kiểm tra thiết lập và chạy thử từng engine một lần
```

`[agent]` là tên hoặc số thứ tự trong `cw ls`. Nếu bỏ trống, `stop`, `logs`, `tail` và `restart` dùng
agent của repo này, hoặc agent duy nhất trên máy, và sẽ hỏi khi có nhiều agent.

## Máy này chạy được project không? `cw check` {#will-it-run-my-project-cw-check}

`cw check` liệt kê những gì máy còn thiếu cho repo này và đề nghị cài, rồi chạy thử lệnh setup và lệnh
test của project trong một worktree tạm của `origin/HEAD` (20 phút cho mỗi bước). Nó thoát với mã 0
khi máy đã sẵn sàng.

Nó đọc yêu cầu từ:

- git (luôn luôn) và `gh` (chỉ cảnh báo);
- `engines.node` trong `package.json`, `.nvmrc` hoặc `.node-version`;
- `packageManager` hoặc file lock;
- các tool mà git hook của repo gọi;
- mục `worker` trong `.cortex/project-profile.json`;
- các engine bạn yêu cầu.

Tool còn thiếu được cài bằng winget, Homebrew hoặc `npm -g`. Trên Linux nó chỉ dùng npm và không bao
giờ chạy sudo. Trong kết quả, `✓` là ổn, `✗` chặn task và `!` là cảnh báo.

### Mục `worker` {#the-worker-section}

```json
{
  "worker": {
    "setupCommand": "pnpm install --frozen-lockfile",
    "testCommand": "pnpm test",
    "requires": ["docker"]
  }
}
```

`CORTEX_SETUP_CMD` và `CORTEX_TEST_CMD` ghi đè hai lệnh này trên một máy.

Worker đang chạy lặp lại bước kiểm tra sẵn sàng mỗi phút. Cho tới khi qua, `cw ls` hiển thị agent là
`not ready` và worker từ chối các task được giao với lý do bận, để hub giao chúng cho máy khác.
`CORTEX_SKIP_READINESS=1` để tắt bước kiểm tra này.

## Worker làm gì với một task

1. Tạo một git worktree trong `~/.cortex/worker/<agentId>/wt/` trên branch của task (mặc định
   `cx/{key}-{slug}`), từ `origin/<base branch>`.
2. Chạy lệnh setup: của chính task, nếu không thì của máy này (`CORTEX_SETUP_CMD`), nếu không nữa thì
   của project. Sau đó chạy engine với mô tả task, các lần review trước và phần bàn giao nếu có.
3. Chạy lệnh test.
4. Commit `<key>: <title>`, push, và mở PR bằng `gh`, hoặc báo một URL compare.
5. Báo task để review kèm link PR và kết quả test.

Nếu engine hết quota, worker push phần việc đang làm, báo hub khi nào quota được reset, và hub gửi
task sang tuyến kế tiếp trong chuỗi fallback, trên máy này hoặc máy khác. Khi một task bị thu hồi (bị
hủy, đổi tuyến hoặc reclaim), worker dừng engine, push những gì đã có và xóa worktree.

## Mọi thứ nằm ở đâu

Mọi thứ của một agent nằm trong `~/.cortex/worker/<agentId>/` (`CORTEX_WORKER_HOME` đổi thư mục cha):

| File | Là gì |
|---|---|
| `worker.pid`, `worker.log` | Tiến trình đang chạy và log của nó |
| `state.json` | Trạng thái hiện tại |
| `start.json` | Các thiết lập mà `cw restart` dùng lại (mode 600). Key chỉ được lưu nếu nó đến từ `--api-key` hoặc `CORTEX_API_KEY` |
| `wt/` | Các worktree |
| `tasks/<taskId>.log` | Output của engine theo từng task: 10 file mới nhất, mỗi file tối đa 10 MB |

## Khi không kết nối được

| Mã đóng | Ý nghĩa |
|---|---|
| 4001 | Không có API key |
| 4003 | Key sai, hoặc không được phép cho project này |
| 4000 | Một kết nối mới hơn với cùng agent id đã thay thế kết nối này |
| 4009 | Một máy khác đang dùng agent id này |

Một lần bị từ chối mà thử lại cũng không sửa được sẽ khiến worker thoát với mã 2. `cw doctor` kiểm tra
lần lượt từng bước: node, git, gh, từng engine, config và tình trạng của hub, phiên bản worker, bước
bắt tay, git origin và ánh xạ project, cùng MCP config của các engine.
