# Hiểu code

Hub index mỗi repo thành một đồ thị AST (GitNexus) và một chỉ mục vector (Qdrant). Agent truy vấn
cả hai qua MCP, nên tìm được code ở bất kỳ repo nào trong tổ chức mà không cần clone về.

## Chọn tool theo những gì bạn đã biết {#pick-the-tool-by-what-you-already-know}

| Bạn đã biết | Bắt đầu bằng | Vì sao |
|---|---|---|
| Tên một symbol (`buildHybridQuery`) | `cortex_code_context(name)` | Tra cứu chính xác trên đồ thị. Nơi gọi, hàm được gọi và import trong một lần gọi |
| Chỉ biết hành vi ("ta kiểm tra API key ở đâu?") | `cortex_code_search(query, limit: 10)` | Tìm kiếm lai có xếp hạng trên chỉ mục |
| Một chuỗi chính xác: biến môi trường, khóa config, thông báo lỗi | `rg` / `grep` | Không phải bài toán xếp hạng; chuỗi đó có hoặc không |
| Một quan hệ ("ai gọi X qua các package") | `cortex_cypher` | Một truy vấn đồ thị thay cho nhiều lần tìm |
| Có ai khác đang sửa file này không | `cortex_changes` | Trước khi sửa bất cứ thứ gì dùng chung |

Đây cũng là bảng mà `/cs` đưa cho agent ở đầu mỗi phiên.

## Tìm một lần, rồi đọc cả mười kết quả

Trên chỉ mục của chính repo này (`benchmarks/retrieval_bench.ts`, một bộ 15 câu truy vấn viết tay),
file đích nằm trong top 10 ở cả 15/15 câu, trong top 3 ở 11 câu và đứng đầu ở 8 câu. Vì vậy:

- **Đọc hết danh sách rồi mới chọn.** Chỉ dựa vào kết quả #1 thì khoảng bốn lần trong mười là sai.
- **Đừng diễn đạt lại cùng một câu hỏi.** Với recall@10 là 1.000, câu hỏi viết lại sẽ trả về đúng
  tập kết quả cũ. Nếu không có gì khớp, hãy hỏi một câu khác hoặc đổi tool.

`cortex_code_search` mặc định `limit: 5`; hãy truyền `limit: 10`. Kết quả trả về cho biết
`retrieval` đã dùng: `hybrid` (vector và BM25 được gộp bằng reciprocal rank fusion) hoặc `vector`.
Một repo có tìm kiếm lai từ lần index lại kế tiếp. Số liệu đằng sau lựa chọn này nằm ở
[Benchmark](../architecture/benchmarks).

## Các tool

| Tool | Dùng để |
|---|---|
| `cortex_code_search` | Tìm code theo hành vi. `repo`, `branch`, `limit` |
| `cortex_code_context` | Định nghĩa, nơi gọi, hàm được gọi và import của một symbol. `name`, tùy chọn `file` |
| `cortex_code_impact` | Phạm vi ảnh hưởng trước khi sửa một thứ được export. `direction`: `downstream` (mặc định) hoặc `upstream` |
| `cortex_detect_changes` | Các symbol mà một diff đụng tới, kèm mức rủi ro |
| `cortex_cypher` | Cypher thô trên đồ thị. Node có `id`, `name`, `filePath`, `startLine`, `endLine`; dùng `labels(n)` để biết loại |
| `cortex_list_repos` | Các repo mà một lần tìm xuyên repo bao phủ |
| `cortex_code_reindex` | Index lại một repo và branch sau khi push |

Tham số của từng tool có trong [tra cứu MCP tool](../reference/mcp-tools#code).

## Xuyên repo

Project thuộc về một **tổ chức** (organization). Hãy để client, server và tool của cùng một sản phẩm
trong cùng một tổ chức; đó là ranh giới của tìm kiếm xuyên repo.

```
cortex_code_search(query: "login packet")                  # mọi repo trong tổ chức
cortex_code_search(query: "user auth", repo: "my-backend")  # một repo
cortex_code_context(name: "validateToken", repo: "my-backend")
cortex_list_repos()                                         # "mọi repo" gồm những repo nào
```

Tổ chức được lấy từ `org` nếu bạn truyền vào, nếu không thì từ repo bạn chỉ định, nếu không nữa thì
từ lần `cortex_session_start` gần nhất (trường `project.orgId`). Nếu bạn thuộc nhiều tổ chức mà
không có nguồn nào ở trên, lần tìm bị từ chối chứ không bị nới rộng.

## Trước khi commit, sau khi push

Hub không nhìn thấy cây làm việc của bạn, nên `cortex_detect_changes` cần được truyền diff:

```bash
git diff --staged
# với thay đổi lớn, chỉ gửi phần header:
git diff --staged -U0 | grep -E '^(diff |--- |\+\+\+ |@@ )'
```

`risk_level: "unknown"` nghĩa là một bước tra cứu bị lỗi, không có nghĩa thay đổi là an toàn.

Sau khi push, `cortex_code_reindex(repo, branch)` giữ đồ thị luôn cập nhật. Index của một branch bị
xóa sau `BRANCH_RETENTION_DAYS` ngày (mặc định 14) không được index lại, hoặc khi branch đã merge hay
bị xóa.
