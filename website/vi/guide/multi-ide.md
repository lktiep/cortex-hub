# Nhiều IDE

Mọi agent đều tới hub qua cùng một MCP endpoint, `https://<your-mcp-host>/mcp`, với API key làm
bearer token. Khác nhau giữa các IDE là file config và mức độ quy trình có thể bị bắt buộc.

## Trình cài đặt thiết lập gì

| IDE | MCP config | Quy trình |
|---|---|---|
| Claude Code | `~/.claude.json` | 8 hook trong `.claude/settings.json`, `/cs` và `/ce`, một mục Cortex trong `CLAUDE.md` |
| Gemini / Antigravity | `~/.gemini/antigravity/mcp_config.json` | 5 hook trong `.gemini/hooks/` và `.gemini/settings.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursorrules` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `.windsurfrules` |
| VS Code (Copilot) | `.vscode/mcp.json` | `.vscode/copilot-instructions.md` |
| Codex | không ghi; xem bên dưới | `.codex/instructions.md` |

File rule được giữ giữa hai marker `<!-- cortex-hub:auto-mcp -->`, nên chạy lại trình cài đặt chỉ cập
nhật phần của nó và để nguyên phần còn lại. Hook thì chặn; file rule chỉ nhắc. Chỉ Claude Code và
Gemini bắt buộc quy trình. Xem [tra cứu trình cài đặt](../reference/installer).

## Tự viết mục config {#writing-the-entry-yourself}

Các dạng dưới đây lấy từ [`docs/conductor/setup.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor/setup.md#5-point-each-engine-at-the-hub).

### Claude Code

```bash
claude mcp add --transport http --scope user cortex-hub https://<your-mcp-host>/mcp \
  --header "Authorization: Bearer <api-key>"
```

Viết dạng JSON trong `~/.claude.json` thì bắt buộc có `"type": "http"`; thiếu nó, Claude Code hiểu
mục này là một server stdio:

```json
{
  "mcpServers": {
    "cortex-hub": {
      "type": "http",
      "url": "https://<your-mcp-host>/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

### Antigravity (agy) và Cursor

`~/.gemini/antigravity/mcp_config.json` hoặc `~/.cursor/mcp.json`, qua `mcp-remote`:

```json
{
  "mcpServers": {
    "cortex-hub": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-mcp-host>/mcp", "--header", "Authorization: Bearer <api-key>"],
      "env": { "HUB_API_KEY": "<api-key>" }
    }
  }
}
```

Antigravity 2.x, cả app lẫn agy đi kèm, đọc `~/.gemini/config/mcp_config.json` thay vào đó, và cũng
chấp nhận dạng kết nối trực tiếp với `serverUrl` và `headers`.

::: warning
`agy mcp list` in bí mật của MCP server ra dạng văn bản thường. Đừng chạy nó khi người khác nhìn
được màn hình, và đừng bao giờ dán kết quả của nó ra ngoài.
:::

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.cortex-hub]
command = "npx"
args = ["-y", "mcp-remote", "https://<your-mcp-host>/mcp", "--header", "Authorization: Bearer <api-key>"]

[mcp_servers.cortex-hub.env]
HUB_API_KEY = "<api-key>"
```

Codex cũng có thể kết nối trực tiếp với `url = "https://<your-mcp-host>/mcp"` và
`bearer_token_env_var` là tên một biến môi trường chứa key.

## Extension cho VS Code

Extension `cortex-agent` (`cortex-hub.cortex-agent`) thêm một Agent Panel vào Antigravity IDE,
VS Code, Cursor và Windsurf, và kết nối mỗi cửa sổ tới hub như một agent qua WebSocket của
Conductor. Cài từ bản phát hành mới nhất:

::: code-group

```bash [macOS / Linux]
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.sh | bash
```

```powershell [Windows]
irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.ps1 | iex
```

:::

`--ide antigravity|code|cursor|windsurf` chọn một IDE, `--release vX` chọn một bản phát hành, và
`--vsix <path>` cài từ một file trên máy.

Mỗi cửa sổ có thể có tên agent và key riêng, đặt bằng nút bút chì trong Agent Panel; key được lưu vào
keychain của hệ điều hành. Extension tìm hub theo thứ tự: setting `cortexHub.hubUrl`, rồi
`CORTEX_HUB_WS_URL` hoặc `CORTEX_HUB_URL`, rồi MCP config nó dò được. Nó không đọc
`~/.codex/config.toml`.

## Mỗi người, mỗi máy một key

Hub phân biệt các phiên theo tên API key, và Conductor gửi mỗi thông báo một lần cho mỗi key. Hai
agent dùng chung một key sẽ chia nhau thông báo của nhau. Hãy tạo key cho từng người và từng máy
worker trong **API Keys**.
