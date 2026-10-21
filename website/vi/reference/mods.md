# Mod: cortex-bar

`mods/cortex-bar` là một mod cho Claude Code (plugin phiên bản 0.9.0), hiển thị các lời gọi Cortex
của phiên hiện tại ngay trên ô nhập prompt: một thanh chồng màu theo từng nhóm, lời gọi gần nhất,
kết quả tốn và tiết kiệm bao nhiêu token, agent có mở đúng những gì một lần tra cứu code xếp hạng
hay không, và `/cs` đang tới đâu. Mỗi dòng tool cortex trong transcript được gắn một nhãn theo màu
nhóm của nó.

```
◆ cortex ████████████████████████████████████████ 9 calls · last plan_quality 1.3s ✓
■ session 2  ■ knowledge 1  ■ memory 1  ■ code 3  ■ quality 1  ■ tasks 1
tokens ~3.3k in · ~9.8k saved est.  │ lookups cortex 3 · grep 9 · 25% · 1 fallback  │ hit@1 1/3 · …
/cs ● session  ● recall  ● changes  ● tasks  │ ● build  ● typecheck  ○ lint  ○ report
```

Dưới mỗi dòng tool cortex:

```
● cortex-hub - cortex_code_search (MCP)(query: "hybrid search")
■ code · 233ms ✓ · ~700 tok · 3 files ~13k · used #2
```

Cần Claude Code 2.1.287 trở lên, trong terminal hoặc ứng dụng desktop.

## Cài đặt

Cho một phiên, từ một bản clone:

```bash
claude --plugin-dir mods/cortex-bar
```

Hoặc dùng repo này làm plugin marketplace:

```bash
claude plugin marketplace add lktiep/cortex-hub
claude plugin install cortex-bar@cortex-hub      # --scope project để chia sẻ cùng repo
```

Sau đó mở một cuộc hội thoại mới.

### Trong VS Code, Antigravity và Cursor

Khung chat của extension Claude Code không vẽ giao diện của mod. Hãy chạy Claude Code trong terminal
của IDE: đặt `"claudeCode.useTerminal": true` trong settings của IDE, khi đó thanh trạng thái, các
nhãn và khung danh sách đều hiện ra.

## Các lệnh

| Lệnh | Làm gì |
|---|---|
| `/cortex-bar` | Hiện hoặc ẩn thanh trạng thái và các nhãn (được ghi nhớ) |
| `/cortex-bar on`, `/cortex-bar off` | Hiện hoặc ẩn một cách rõ ràng |
| `/cortex-bar reset` | Xóa số đếm lời gọi và các chỉ số |
| `/cortex-calls` | Mở một khung với các chỉ số, bảng theo từng tool và 50 lời gọi gần nhất |

## Nó đo những gì

Mọi thứ được đếm trong phiên Claude Code này. `cortex_tool_stats` của hub đếm trên server, với mốc
so sánh riêng, nên hai con số khác nhau.

| Chỉ số | Ý nghĩa |
|---|---|
| Tokens in | Số ký tự của mỗi kết quả cortex chia 4: lượng mà kết quả thêm vào ngữ cảnh |
| Saved | Với mỗi lần tra cứu: kích thước các file nó trỏ tới (mỗi file tối đa 25k token), trừ chi phí của chính kết quả, trừ các file agent vẫn mở. Đây là giới hạn trên |
| Used / missed | Agent đã mở một trong các file mà lần tra cứu nêu ra (`used #n` là thứ hạng), hoặc mở file khác (`missed`) |
| hit@k | Tỷ lệ các lần tra cứu được đánh giá có file tốt nhất mà agent mở nằm ở hạng k hoặc cao hơn |
| Lookups vs grep | Số lần tra cứu code bằng cortex so với số lần agent tự tìm mà lẽ ra cortex trả lời được. Một fallback là một lần tự tìm như vậy trong vòng ba lời gọi sau một lần tra cứu cortex |
| Quality | Lấy từ output của chính từng tool: số kết quả, điểm cao nhất, `risk_level`, điểm kế hoạch |

Danh sách kiểm tra `/cs` đọc cùng các [marker](./hooks#markers) mà hook dùng để chặn. `gate-off` hiển
thị là `⚠ gates off`.

Mod không gửi gì đi đâu cả. Các đối số có tên giống thông tin xác thực (`key`, `token`, `secret`,
`password`, `authorization`) không bao giờ được hiển thị.

## Màu sắc

| Nhóm | Tool |
|---|---|
| session | `session_start`, `session_end`, `changes`, `health`, `list_repos` |
| knowledge | `knowledge_search`, `knowledge_store` |
| memory | `memory_search`, `memory_store`, `memory_delete` |
| code | `code_search`, `code_context`, `code_impact`, `code_reindex`, `cypher`, `detect_changes` |
| quality | `quality_report`, `plan_quality`, `tool_stats` |
| tasks | `task_*` |
| other | mọi tool cortex không có trong danh sách |

## Các phiên trước

Cùng các chỉ số đó, đọc lại từ transcript của Claude Code:

```bash
node mods/cortex-bar/scripts/lookup-audit.mjs             # 5 phiên mới nhất của thư mục này
node mods/cortex-bar/scripts/lookup-audit.mjs --last 0    # tất cả
```

Mô tả đầy đủ nằm trong [README](https://github.com/lktiep/cortex-hub/tree/master/mods/cortex-bar)
của mod.
