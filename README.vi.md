<p align="center"><a href="README.md">English</a> · <strong>Tiếng Việt</strong></p>

<p align="center">
  <img src="docs/assets/logo.png" alt="Cortex Hub" width="120" />
</p>

<h1 align="center">Cortex Hub</h1>

<p align="center">
  <strong>Bộ nhớ và trí tuệ code tự host cho mọi AI agent</strong><br/>
  <em>Một MCP endpoint cho mọi agent: bộ nhớ lâu dài, tìm kiếm code theo AST, cưỡng chế chất lượng.</em>
</p>

<p align="center">
  📖 <a href="https://lktiep.github.io/cortex-hub/vi/"><strong>Trang tài liệu</strong></a> (<a href="https://lktiep.github.io/cortex-hub/">English</a> · Tiếng Việt) ·
  🎼 <a href="https://lktiep.github.io/cortex-hub/conductor/">Showcase Conductor</a>
</p>

---

## Vì sao cần Cortex?

Mỗi AI coding agent làm việc **một mình**. Đổi IDE, đổi máy, đổi dự án là agent bắt đầu lại từ
đầu. Những quyết định, bản sửa lỗi và khuôn mẫu kiến trúc mà team phải vất vả mới có được chỉ sống
trong từng phiên chat rồi mất đi.

**Cortex Hub** là một backend tự host, cho **mọi agent trong team một bộ nhớ lâu dài, kiến thức dùng
chung và hiểu biết xuyên dự án** qua một [MCP](https://modelcontextprotocol.io/) endpoint duy nhất.

## Có gì bên trong

- **Phiên làm việc và nhớ lại.** `/cs` mở phiên, gợi lại kiến thức của team và bộ nhớ của bạn cho
  repo, cho biết ai đang sửa gì. `/ce` chạy build, typecheck, lint và đóng phiên kèm tóm tắt.
- **Trí tuệ code.** Tìm kiếm lai (vector và BM25) trên chỉ mục của mọi repo trong tổ chức, cùng đồ
  thị code: symbol, lời gọi, import và tầm ảnh hưởng của một thay đổi.
- **Kiến thức và bộ nhớ.** Kiến thức dùng chung cho cả team, bộ nhớ riêng cho từng agent, và ghi
  chú gắn với file hiện ra trước khi agent mở file đó.
- **Hook cưỡng chế quy trình.** Tám hook cho Claude Code chặn sửa file trước khi mở phiên, và chặn
  commit khi build, typecheck và lint chưa qua.
- **Conductor.** Lead chia một kế hoạch thành cây task; worker trên nhiều máy, nhiều IDE và nhiều
  engine nhận task, làm, rồi gửi lại để review.
- **Dashboard.** Phiên, chất lượng, kiến thức, project, nhà cung cấp LLM, mức dùng, API key, tổ
  chức và cài đặt.

32 MCP tool: 20 tool lõi và 12 tool Conductor. Danh sách đầy đủ ở
[tra cứu MCP tool](https://lktiep.github.io/cortex-hub/vi/reference/mcp-tools).

## Cài nhanh

Bạn cần một hub đang chạy và một API key (dashboard, mục **API Keys**). Chạy ở thư mục gốc của dự án:

```bash
curl -fsSL "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh" \
  | HUB_MCP_URL=https://<your-mcp-host>/mcp HUB_API_KEY=<api-key> bash
```

Khởi động lại agent rồi gõ `/cs`. Windows, các cờ của trình cài đặt và cách cài không dùng script có
trong [hướng dẫn cài nhanh](https://lktiep.github.io/cortex-hub/vi/guide/quick-start).

## Tự dựng hub

```bash
git clone https://github.com/lktiep/cortex-hub.git
cd cortex-hub
cp infra/.env.example infra/.env   # điền các giá trị cần thiết
cd infra && docker compose up -d
```

Các container, cổng, biến môi trường và cách đưa hub ra internet có trong
[hướng dẫn tự dựng hub](https://lktiep.github.io/cortex-hub/vi/guide/self-host).

## Tài liệu

| Trang | Nội dung |
|---|---|
| [Hướng dẫn](https://lktiep.github.io/cortex-hub/vi/guide/what-is-cortex) | Cortex là gì, cài đặt, phiên làm việc, trí tuệ code, kiến thức và bộ nhớ, gate chất lượng, subagent, nhiều IDE |
| [Conductor](https://lktiep.github.io/cortex-hub/vi/conductor/overview) | Điều phối nhiều agent, chạy worker `cw`, review |
| [Tra cứu](https://lktiep.github.io/cortex-hub/vi/reference/cli) | `cw`, trình cài đặt, lệnh slash, hook, MCP tool, cấu hình, mod, dashboard, script |
| [Kiến trúc](https://lktiep.github.io/cortex-hub/vi/architecture/) | Các thành phần, công nghệ, quyết định thiết kế, benchmark |

Tài liệu thiết kế gốc nằm trong [`docs/`](docs/) (tiếng Anh).

## Giấy phép

MIT
