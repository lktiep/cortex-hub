# Trình cài đặt

`scripts/install.sh` (macOS, Linux) và `scripts/install.ps1` (Windows) thiết lập một project để dùng
hub. Chạy chúng ở thư mục gốc của project. Chúng idempotent: chạy lần hai chỉ cập nhật những gì đã
đổi và để nguyên phần còn lại.

::: code-group

```bash [macOS / Linux]
curl -fsSL "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh" \
  | HUB_MCP_URL=https://<your-mcp-host>/mcp HUB_API_KEY=<api-key> bash
```

```powershell [Windows]
$env:HUB_MCP_URL="https://<your-mcp-host>/mcp"; $env:HUB_API_KEY="<api-key>"
iwr -useb "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.ps1" -OutFile $env:TEMP\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\install.ps1
```

:::

Để truyền cờ qua `curl | bash`, dùng `bash -s -- <flags>`.

## Các cờ

| `install.sh` | `install.ps1` | Tác dụng |
|---|---|---|
| `--force`, `-f` | `-Force` | Tạo lại mọi file, kể cả khi đã mới nhất |
| `--check`, `-c` | `-CheckOnly` | Báo những gì đã cài; không thay đổi gì |
| `--skip-global` | `-SkipGlobal` | Chỉ cài cho project; bỏ qua skill toàn cục `/install` |
| `--tools <list>`, `-t`, `--tools=<list>` | `-Tools <list>` | Chỉ các IDE này: `claude`, `gemini`, `cursor`, `windsurf`, `vscode`, `codex` |

Không có `--tools`, trình cài đặt tự dò IDE: `claude` trong PATH hoặc `~/.claude`, `~/.gemini`,
`~/.cursor`, `~/.codeium` hoặc `windsurf`, `code`, `codex` hoặc `~/.codex`. Không tìm thấy gì thì nó
thiết lập cho Claude Code.

## Biến môi trường {#environment}

| Biến | Ý nghĩa |
|---|---|
| `HUB_MCP_URL` | MCP endpoint của hub, kết thúc bằng `/mcp`. Không đặt thì script dùng một URL viết sẵn bên trong, và đó không phải hub của bạn |
| `HUB_API_KEY` | API key. Cũng được đọc từ dòng `HUB_API_KEY=` trong `.env` của project, hoặc từ mục `cortex-hub` đã có trong config của một IDE khác |
| `CORTEX_MCP_URL` | Được các hook đã cài đọc lúc chạy; được ưu tiên hơn `HUB_MCP_URL` |

Nếu config của một IDE đã có mục `cortex-hub`, trình cài đặt giữ nguyên và không ghi mục mới.

## Nó làm gì, theo thứ tự

1. **Skill toàn cục `/install`**: `~/.claude/skills/install/SKILL.md`, để project nào cũng chạy lại
   được trình cài đặt từ Claude Code. Bỏ qua khi có `--skip-global`.
2. **MCP config** cho mỗi IDE được chọn:

   | IDE | File |
   |---|---|
   | Claude Code | `~/.claude.json` |
   | Cursor | `~/.cursor/mcp.json` |
   | Windsurf | `~/.codeium/windsurf/mcp_config.json` |
   | Gemini / Antigravity | `~/.gemini/antigravity/mcp_config.json` |
   | VS Code | `.vscode/mcp.json` |

3. **Hồ sơ project**: `.cortex/project-profile.json`, dựa trên các stack nó dò được (Node.js, Go,
   Rust, Python, .NET, Godot). Mục `verify` liệt kê các bước kiểm tra cho lượt `pre_commit` và
   `full`. Với Conductor, hãy thêm tay một [mục `worker`](../conductor/workers#the-worker-section).
   Hồ sơ đã có sẵn thì được giữ nguyên.
4. **Định danh agent**: `.cortex/agent-identity.json`. Sửa file này để thêm vai trò hoặc capability.
5. **Claude Code**: tám [hook](./hooks) trong `.claude/hooks/`, `.claude/settings.json`, và hai
   [lệnh `/cs` và `/ce`](./slash-commands) trong `.claude/commands/`. Các hook Cortex cũ bị gỡ khỏi
   `~/.claude/settings.json` để không chạy hai lần.
6. **Gemini / Antigravity**: năm hook trong `.gemini/hooks/` (session-init, enforce-session,
   enforce-commit, track-quality, session-end-check) và `.gemini/settings.json`.
7. **File rule** cho các IDE không có hook: `.cursorrules`, `.windsurfrules`,
   `.vscode/copilot-instructions.md`, `.codex/instructions.md`. Phần của Cortex nằm giữa hai marker
   `<!-- cortex-hub:auto-mcp -->`.
8. **`CLAUDE.md`**: được tạo mới, hoặc được thêm một mục Cortex giữa các marker.
9. **Marker phiên bản**: `.cortex/.hooks-version`. Trình cài đặt mới hơn sẽ tạo lại các hook.
10. **Git hook** qua [lefthook](https://github.com/evilmartians/lefthook), dựa trên hồ sơ project.
11. **`.gitignore`**: `.claude/`, `.cortex/.session-state/`, `.codex/`, `.windsurfrules`,
    `.cursorrules`.

## Repo đã có git hook riêng

Nếu repo đã tự chạy kiểm tra qua git hook (một config lefthook đã commit, husky, một
`.pre-commit-config.yaml`, hoặc một `core.hooksPath` có chứa hook), trình cài đặt không thêm
pre-commit hay pre-push. Ở chỗ config lefthook của repo nhận được, nó chỉ gộp vào hook post-push của
Cortex. Một `core.hooksPath` không chứa hook nào sẽ bị bỏ đặt để lefthook cài được.

## `/install` trong Claude Code

Sau lần chạy đầu, `/install` là một skill toàn cục của Claude Code. Nó nhận cùng các cờ (`--force`,
`--check`, `--tools claude,gemini`), tải `install.sh` mới nhất từ GitHub và chạy. Claude không tự gọi
nó (`disable-model-invocation: true`).

## Gỡ cài đặt

`scripts/uninstall.sh` gỡ config Cortex trên máy cho mọi IDE.
