---
layout: home
title: Cortex Hub
titleTemplate: Bộ nhớ, hiểu code và điều phối cho các AI agent lập trình

hero:
  name: Cortex Hub
  text: Một hub cho mọi coding agent bạn đang chạy
  tagline: Bộ nhớ, hiểu code, quality gate và điều phối nhiều agent, tự host, qua một MCP endpoint duy nhất.
  image:
    src: /mark.svg
    alt: Cortex Hub
  actions:
    - theme: brand
      text: Cài nhanh
      link: /vi/guide/quick-start
    - theme: alt
      text: Cortex Hub là gì?
      link: /vi/guide/what-is-cortex
    - theme: alt
      text: Xem Conductor
      link: /conductor/index.html
      target: _self

features:
  - icon: 🧠
    title: Phiên làm việc có trí nhớ
    details: "/cs mở phiên, gợi lại kiến thức của team và bộ nhớ riêng của bạn, cho biết ai khác đang sửa file nào. /ce đóng phiên kèm một bản tóm tắt để phiên sau đọc tiếp."
    link: /vi/guide/sessions
    linkText: Phiên làm việc và nhớ lại
  - icon: 🔎
    title: Hiểu code xuyên repo
    details: "Tìm kiếm lai vector + BM25, ngữ cảnh symbol, phạm vi ảnh hưởng và Cypher trên mọi repo đã index trong tổ chức của bạn, không cần clone về."
    link: /vi/guide/code-intelligence
    linkText: Hiểu code
  - icon: 📚
    title: Kiến thức tích lũy dần
    details: "Kiến thức chung của team có phân loại và ngày hiệu lực, bộ nhớ riêng cho từng agent, và ghi chú theo file hiện rủi ro cũ trước khi agent mở file đó."
    link: /vi/guide/knowledge-memory
    linkText: Kiến thức và bộ nhớ
  - icon: 🛡️
    title: Gate mà agent không lách được
    details: "Tám hook chặn sửa file khi chưa nhớ lại, chặn commit khi build, typecheck và lint chưa qua, và từ chối --no-verify."
    link: /vi/reference/hooks
    linkText: Các hook
  - icon: 🎼
    title: Conductor
    details: "Agent lead lập một cây task; worker trên bất kỳ máy nào nhận task, làm trong worktree, mở PR, rồi qua review, gate và cơ chế chuyển engine khi hết quota."
    link: /vi/conductor/overview
    linkText: Kế hoạch và worker
  - icon: 🧩
    title: Mọi IDE, một endpoint
    details: "Claude Code, Cursor, Windsurf, VS Code, Gemini/Antigravity và Codex. Một trình cài đặt ghi MCP config, hook và rule cho từng IDE."
    link: /vi/guide/multi-ide
    linkText: Nhiều IDE
---

<div class="cx-home">

<section class="cx-section">

<p class="cx-kicker">Vì sao</p>

## Agent nào cũng bắt đầu từ con số không. Cortex Hub sửa chuyện đó.

<p class="cx-lede">Đổi IDE, đổi máy hay đổi dự án là một coding agent thông thường quên sạch những gì nó đã học. Cortex Hub là một backend bạn tự host. Mọi agent trong team nói chuyện với nó qua một MCP endpoint, nên các quyết định, các bản sửa lỗi và đồ thị code vẫn còn đó sau khi cuộc chat kết thúc.</p>

| | Coding agent thông thường | Có Cortex Hub |
|---|---|---|
| Phiên mới | Trống trơn | `/cs` gợi lại tóm tắt phiên trước, kiến thức của team và bộ nhớ của bạn |
| Tìm code | grep rồi đọc từng file cho tới khi thấy chỗ cần sửa | `cortex_code_search` / `cortex_code_context` trên đồ thị AST, repo nào trong tổ chức cũng được |
| Lỗi người khác đã sửa rồi | Sửa lại từ đầu | `cortex_knowledge_search` tìm ra cách sửa đã lưu |
| Hai agent cùng sửa một file | Tới lúc merge mới biết | `cortex_changes` cho biết ai khác đang sửa |
| Commit | Agent muốn sao làm vậy | Hook từ chối commit cho tới khi build, typecheck và lint đều qua |
| Việc lớn hơn một phiên | Một agent, một cuộc chat | Conductor chia thành kế hoạch để worker trên các máy khác chạy |

</section>

<section class="cx-section">

<p class="cx-kicker">Đo đạc</p>

## Số liệu từ chính benchmark của repo này

<div class="cx-stats">
  <div class="cx-stat"><b>96.0%</b><span>R@5 trên LongMemEval-S, 500 câu hỏi</span></div>
  <div class="cx-stat"><b>15 / 15</b><span>câu truy vấn code có file đích nằm trong top 10</span></div>
  <div class="cx-stat"><b>0.703</b><span>MRR của tìm kiếm code lai đang chạy (vector: 0.656)</span></div>
  <div class="cx-stat"><b>32</b><span>MCP tool: 20 tool lõi, 12 tool Conductor</span></div>
</div>

<p class="cx-note">LongMemEval được đo với một embedder chạy trong tiến trình, nay đã thay bằng Ollama <code>all-minilm</code>. Bộ câu hỏi truy vấn code còn nhỏ (n = 15). Chi tiết và cách chạy lại: <a href="./architecture/benchmarks">Benchmark</a>.</p>

</section>

<section class="cx-section">

<p class="cx-kicker">Bắt đầu</p>

## Hai lệnh

```bash
# 1. Trong dự án của bạn: MCP config, hook, /cs và /ce cho mọi IDE tìm thấy
curl -fsSL "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh" | bash

# 2. Trong agent
/cs
```

<p class="cx-lede">Chưa có hub? <a href="./guide/self-host">Tự dựng một hub</a> bằng Docker Compose. Muốn agent trên các máy khác nhận việc? <a href="./conductor/workers">Chạy một worker</a>.</p>

</section>

</div>
