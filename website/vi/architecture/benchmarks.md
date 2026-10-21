# Benchmark

Các benchmark nằm trong `benchmarks/` dưới dạng một package riêng, `@cortex/benchmarks`. Số liệu ở
đây được lấy từ [README](https://github.com/lktiep/cortex-hub/blob/master/benchmarks/README.md) của
nó, nơi có phương pháp, các cờ và log đầy đủ.

## Tìm kiếm code: vector, BM25 và lai

`benchmarks/retrieval_bench.ts` chạy 15 câu hỏi viết tay trên chỉ mục của chính repo này, mỗi câu
kèm file trả lời nó. Embedder `all-minilm`.

| Chế độ | r@1 | r@3 | r@5 | r@10 | MRR | Chi phí mỗi truy vấn |
|---|---:|---:|---:|---:|---:|---|
| vector | 0.533 | 0.667 | 0.800 | 1.000 | 0.656 | ~12 ms, 0 token |
| BM25 | 0.267 | 0.667 | 0.933 | 1.000 | 0.530 | ~8 ms, 0 token |
| **lai (RRF)** | **0.600** | **0.733** | 0.800 | 1.000 | **0.703** | ~8 ms, 0 token |
| vector + LLM rerank | r@1 không đổi | | | | | +2.1 s, 1.359 token |
| `bge-m3` dense | kém hơn `all-minilm` | | | | | độ trễ truy vấn gấp 226 lần |

Tìm kiếm lai là thứ được đưa vào sản phẩm: đó là lựa chọn duy nhất cải thiện r@1. File đúng luôn nằm
trong top mười, vì vậy các trang hướng dẫn khuyên [đọc cả mười kết quả](../guide/code-intelligence)
thay vì tìm lại.

```bash
pnpm --filter @cortex/benchmarks bench:retrieval -- --project <projectId>
```

## Tìm kiếm bộ nhớ

`bench:mem9` đo thứ tự kết quả của `cortex_memory_search` trên 100 câu hỏi, `all-minilm`:

| Tập dữ liệu | Chế độ | n | r@1 | r@5 | r@10 | MRR |
|---|---|---:|---:|---:|---:|---:|
| dev | vector | 24 | 0.917 | 1.000 | 1.000 | 0.951 |
| dev | **lai** | 24 | **1.000** | 1.000 | 1.000 | **1.000** |
| LongMemEval | vector | 100 | 0.450 | 0.800 | 0.890 | 0.601 |
| LongMemEval | **lai** | 100 | **0.550** | **0.870** | **0.900** | **0.685** |

Lưu một mục bộ nhớ (`add()`, 8 sự kiện mỗi lần gọi, LLM được giả lập) giảm từ p50 1.430 ms xuống
248 ms với collection lai.

Hãy chạy nó trên một Qdrant và Ollama dùng xong bỏ, đừng bao giờ chạy trên một hub đang hoạt động.

## Tìm kiếm kiến thức: LongMemEval-S

`bench:longmemeval` nhập các phiên của bộ LongMemEval-S đã làm sạch vào một project, rồi hỏi cả 500
câu trên đó.

| | R@5 | R@10 |
|---|---:|---:|
| Cortex Hub, lai | 96.0% | 97.8% |
| Cortex Hub, chỉ vector | 93.8% | 97.0% |
| MemPalace, mốc đã công bố (embedding của OpenAI) | 96.6% | 98.2% |

::: warning
Các lần chạy này từ tháng 4/2026 và dùng một embedder MiniLM chạy trong tiến trình, nay đã bị gỡ bỏ;
embedding giờ đi qua cổng LLM của hub tới Ollama. README cũng báo NDCG@10 lớn hơn 1, điều mà một chỉ
số đã chuẩn hóa không thể đạt, nên cột đó được bỏ ra khỏi đây.
:::

## Lộ trình

ConvoMem, LoCoMo và MemBench được liệt kê trong README là dự kiến, chưa được làm.
