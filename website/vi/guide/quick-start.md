# Cài nhanh

Bạn cần một hub đang chạy và một API key. Nếu chưa có hub, hãy [tự dựng một hub](./self-host)
trước; chỉ cần một lệnh `docker compose up`.

## 1. Lấy API key

Mở dashboard, vào **API Keys** (`/keys`) và tạo một key. Mỗi người, mỗi máy worker nên có key
riêng: hub phân biệt các phiên theo tên key, và thông báo của Conductor được gửi theo từng key.

## 2. Cài vào dự án

Chạy lệnh này ở thư mục gốc của dự án bạn đang làm. `HUB_MCP_URL` là MCP endpoint của hub, còn
`HUB_API_KEY` là key ở bước 1.

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

::: warning Nhớ đặt HUB_MCP_URL
Không có `HUB_MCP_URL`, trình cài đặt sẽ dùng một URL hub viết sẵn trong script, và đó không phải
hub của bạn. Nếu IDE đã có một mục MCP tên `cortex-hub`, trình cài đặt giữ nguyên mục đó và không
ghi mục mới.
:::

Trình cài đặt dò các IDE (Claude Code, Gemini/Antigravity, Cursor, Windsurf, VS Code, Codex) và
ghi MCP config cùng rule quy trình cho từng IDE. Với Claude Code, nó cài thêm tám hook và hai lệnh
`/cs`, `/ce`. Chạy lại bao nhiêu lần cũng an toàn; `--check` báo những gì đã cài mà không thay đổi
gì. Mọi cờ đều có trong [tra cứu trình cài đặt](../reference/installer).

Sau lần chạy đầu tiên, Claude Code có thêm lệnh toàn cục `/install` để chạy lại trình cài đặt ở
bất kỳ dự án nào.

Key cũng được đọc từ dòng `HUB_API_KEY=` trong file `.env` của dự án, hoặc từ mục `cortex-hub` đã
có trong config của một IDE khác.

## 3. Mở phiên

Khởi động lại agent để nó nạp MCP server mới, rồi gõ:

```
/cs
```

`/cs` mở một phiên trên hub, gợi lại kiến thức của team và bộ nhớ của bạn cho repo này, cho biết ai
khác đang sửa gì, và nhận task được giao cho bạn nếu có. Trong Claude Code, mọi thao tác sửa file bị
chặn cho tới khi lệnh này chạy xong. Xem [Phiên làm việc và nhớ lại](./sessions).

Khi xong việc:

```
/ce
```

`/ce` chạy build, typecheck và lint, báo kết quả về hub, lưu những gì bạn học được và đóng phiên
kèm một bản tóm tắt để phiên sau bắt đầu từ đó.

## Không dùng trình cài đặt

MCP client nào cũng có thể nói chuyện trực tiếp với hub. Với Claude Code:

```bash
claude mcp add --transport http --scope user cortex-hub https://<your-mcp-host>/mcp \
  --header "Authorization: Bearer <api-key>"
```

Nếu viết tay trong `~/.claude.json`, mục này cần `"type": "http"`; thiếu nó, Claude Code sẽ hiểu đây
là một server stdio:

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

Trang **Settings** của dashboard hiển thị đúng đoạn này với URL hub của bạn điền sẵn. Các IDE khác
có trong [Nhiều IDE](./multi-ide). Làm cách này bạn có đủ tool, nhưng không có các hook buộc agent
phải dùng chúng.

## Tiếp theo

- [Tự dựng hub](./self-host)
- [Chạy một worker](../conductor/workers) để các máy khác nhận task
- [Tra cứu `cw`](../reference/cli)
