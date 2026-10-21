# Script

Mọi thứ trong `scripts/`, nhóm theo người chạy. Script nào có bản `.ps1` song song thì chạy y hệt
trên Windows.

## Thiết lập một project

| Script | Làm gì |
|---|---|
| `install.sh`, `install.ps1` | Thiết lập một project: MCP config, hook, lệnh, rule, hồ sơ project, git hook. Xem [Trình cài đặt](./installer) |
| `onboard.sh`, `onboard.ps1` | Onboarding tương tác: hỏi API key, MCP URL và IDE, ghi MCP config, rồi giao phần hook và rule cho `install.sh`. `--tool claude` (hoặc IDE khác) để bỏ qua câu hỏi; `--tool bot` in thông tin kết nối cho một agent không có giao diện |
| `uninstall.sh` | Gỡ config Cortex trên máy cho mọi IDE |
| `setup-hooks.sh` | Tạo `lefthook.yml` từ `.cortex/project-profile.json`, với bộ lọc file theo từng ngôn ngữ. Cần `python3`; tự cài lefthook nếu thiếu |
| `install-extension.sh`, `install-extension.ps1` | Cài extension VS Code `cortex-agent` vào Antigravity, VS Code, Cursor và Windsurf. `--ide`, `--release`, `--vsix`. Xem [Nhiều IDE](../guide/multi-ide) |

## Thiết lập một hub

| Script | Làm gì |
|---|---|
| `bootstrap.sh` | Hỏi bạn là quản trị viên (toàn bộ stack Docker) hay thành viên (kết nối một project tới hub có sẵn) rồi chạy trình cài đặt tương ứng |
| `install-hub.sh` | Cài hub: kiểm tra phụ thuộc, chuẩn bị thư mục và môi trường, khởi động stack, build các package dùng chung |
| `prune-leaked-images.sh` | Dọn dẹp khẩn cấp: xóa các image Cortex đang cache trên máy và cache của builder, phòng khi một image được build kèm dữ liệu không nên có trong đó. Hãy dừng stack trước |

Xem [Tự dựng hub](../guide/self-host).

## Chạy agent

| Script | Làm gì |
|---|---|
| `run-agent.sh`, `run-agent.ps1` | Script khởi tạo worker: tải worker TypeScript từ hub của bạn, cài `cw` và khởi động nó. Xem [Chạy một worker](../conductor/workers) |
| `cortex-agent.sh`, `cortex-agent.ps1` | Một client shell cho WebSocket conductor của hub, nhận task và khởi động engine. Nó nói giao thức agent đời đầu của hub |
| `cortex-worker.sh`, `cortex-worker.ps1` | Một vòng lặp chạy nền, hỏi vòng các task được giao và chạy chúng bằng `claude -p` (hoặc `--engine codex`). `--name`, `--interval` |
| `cortex-listen.sh` | Một listener để chạy nền trong Claude Code; in một dòng khi có task tới |
| `orchestrator-prompt.md` | Prompt biến một agent thành lead của Conductor. Xem [Conductor](../conductor/overview) |
| `merge-check.sh <worktree>` | Kiểm tra worktree của một agent chạy song song trước khi bạn merge, kết thúc bằng một smoke test API khi có server đang chạy |

## Bảo trì Cortex

| Script | Làm gì |
|---|---|
| `release.sh` | Tạo một bản phát hành ổn định; xem bên dưới |
| `bump-version.sh` | Đổi `version.json`: `patch` (mặc định), `minor`, `major`, hoặc `set <x.y.z>` |
| `sync-install-templates.sh` | Chép các hook và lệnh chuẩn vào cả hai trình cài đặt; `--check` báo chỗ lệch và thoát với mã 1, dùng cho CI. Là lớp bọc quanh `sync_install_templates.py` |
| `test-hooks.sh` | Test cho các [hook](./hooks) cưỡng chế. Mỗi ca là một lỗ hổng từng tồn tại trong một phiên bản đã phát hành |
| `test-run-agent.sh` | Test cho `cw` theo cách `run-agent.sh` cài nó, trên một thư mục home tạm và một hub giả lập chạy local |

## Phát hành {#release}

CI giữ quyền đánh số phiên bản. Mỗi lần merge vào `master` có đụng tới code của hub sẽ lấy số patch
kế tiếp trong `version.json` và phát hành các image dưới số đó (`cortex-api`, `cortex-hub-web`,
`cortex-mcp`, `cortex-gitnexus` trên `ghcr.io/lktiep`).

Bản phát hành ổn định đi qua cùng workflow đó:

```bash
./scripts/release.sh            # minor (mặc định)
./scripts/release.sh patch      # hoặc major
./scripts/release.sh current    # hoàn tất một bản phát hành đã lấy số nhưng build bị lỗi
```

Script cần `gh`. Nó từ chối chạy khi đang có một lượt phát hành khác, hỏi xác nhận, rồi chạy workflow
**Build and Publish Docker Images** với `stable` bật. Workflow đó lấy số phiên bản, build mọi image từ
một commit, gắn tag `v<version>` và `:stable`, rồi tạo git tag và một GitHub Release trên chính commit
đó. Sửa ghi chú phát hành sau đó bằng:

```bash
gh release edit v<version> --notes-file notes.md
```

Một stack tự host có Watchtower sẽ tự nhận image mới: Watchtower kiểm tra mỗi 5 phút và chỉ cập nhật
các container có nhãn cho phép (các image Cortex, không phải Qdrant hay Ollama).
