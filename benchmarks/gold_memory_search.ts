/**
 * A small agent-memory corpus written the way memories on a hub actually read:
 * short facts about one codebase, some in English, some in Vietnamese, many
 * carrying an identifier. The project is fictional so nothing here is anyone's
 * real configuration.
 *
 * It exists because LongMemEval is English chat, while the memories this hub
 * stores are mixed-language facts recalled through an English-only embedding
 * model (all-minilm). Each query names the one memory that answers it; a third
 * of them are Vietnamese, and a few are typed without diacritics, the way people
 * type on a keyboard without an IME.
 */

export const DEV_MEMORIES: string[] = [
  /* 0 */ 'The payments service retries a failed Stripe webhook three times with exponential backoff before paging on-call.',
  /* 1 */ 'Checkout totals are computed in integer cents to avoid floating point rounding errors.',
  /* 2 */ 'Use `pnpm --filter api test` to run only the API tests; the full suite takes eight minutes.',
  /* 3 */ 'The staging database is reset every Sunday night, so do not keep test fixtures there.',
  /* 4 */ 'The flag for the new cart is `cart_v2_enabled` in LaunchDarkly.',
  /* 5 */ 'Người dùng muốn mọi báo cáo cuối phiên viết bằng tiếng Việt, ngắn gọn và có số liệu cụ thể.',
  /* 6 */ 'Không được chạy migration trực tiếp trên database production; mọi thay đổi schema phải đi qua pipeline CI.',
  /* 7 */ 'Ảnh sản phẩm được lưu trên S3 và được resize bằng Lambda ngay khi upload.',
  /* 8 */ 'The mobile app reads the API base URL from `EXPO_PUBLIC_API_URL`.',
  /* 9 */ 'Order IDs are ULIDs so they sort by creation time.',
  /* 10 */ 'The search page uses Meilisearch; run the `reindexProducts` job after a bulk import.',
  /* 11 */ '`OrderService.cancelOrder` must release reserved inventory before it refunds the customer.',
  /* 12 */ "Lỗi 'connection pool exhausted' xảy ra khi worker mở transaction mà không đóng; tăng kích thước pool không giải quyết được.",
  /* 13 */ 'The team prefers small pull requests under 400 lines, squash-merged.',
  /* 14 */ 'Rate limiting on the public API is 100 requests per minute per API key.',
  /* 15 */ 'Người dùng không thích thư viện UI nặng; ưu tiên CSS modules viết tay.',
  /* 16 */ 'Emails are sent through Postmark and the templates live in `apps/api/src/emails`.',
  /* 17 */ 'The nightly job `syncExchangeRates` fetches currency rates at 02:00 UTC.',
  /* 18 */ 'Khách hàng ở Việt Nam thanh toán qua VNPay; callback phải kiểm tra chữ ký HMAC-SHA512 trước khi cập nhật đơn.',
  /* 19 */ 'Store every timestamp in UTC and convert to Asia/Ho_Chi_Minh only when rendering.',
  /* 20 */ 'Unit tests mock the clock with `vi.useFakeTimers()` and never rely on the real date.',
  /* 21 */ 'The admin dashboard is a Next.js app deployed to Vercel; the API runs on Fly.io.',
  /* 22 */ 'Shipping fees for domestic orders are quoted by the GHN API.',
  /* 23 */ 'Mật khẩu người dùng được băm bằng argon2id; không dùng bcrypt cho tài khoản mới.',
  /* 24 */ 'Coupons cannot be stacked; only the highest discount applies to an order.',
  /* 25 */ 'Logs go to Grafana Loki; filter by the `service` label, not the pod name.',
  /* 26 */ 'Người dùng muốn commit message viết bằng tiếng Anh theo Conventional Commits.',
  /* 27 */ 'A 409 from the inventory service means the SKU is already reserved by another cart.',
  /* 28 */ "Product slugs are built from the Vietnamese name with diacritics removed, so 'áo thun' becomes 'ao-thun'.",
  /* 29 */ 'Refunds over 5,000,000 VND need manual approval from finance.',
  /* 30 */ 'The recommendation widget is disabled on mobile because it delayed first paint by 800 ms.',
  /* 31 */ "Đơn hàng bị treo ở trạng thái 'pending' thường do webhook thanh toán đến trễ; job `reconcilePayments` xử lý lại mỗi 15 phút.",
  /* 32 */ 'The CI cache key includes the pnpm lockfile hash; bump it if installs look stale.',
  /* 33 */ 'Customer support uses Zendesk and the ticket link is stored on the order as `supportTicketUrl`.',
  /* 34 */ 'Push notifications go through Firebase Cloud Messaging; iOS also needs the APNs key uploaded.',
  /* 35 */ 'Người dùng yêu cầu luôn chạy test trước khi mở pull request.',
]

/** [query, index of the memory that answers it] */
export const DEV_MEMORY_GOLD: Array<[string, number]> = [
  ['how are money amounts stored to avoid rounding problems', 1],
  ['cart_v2_enabled', 4],
  ['which env var holds the API URL in the mobile app', 8],
  ['cancelOrder inventory', 11],
  ['báo cáo cuối phiên nên viết thế nào', 5],
  ['có được chạy migration trên production không', 6],
  ['connection pool exhausted', 12],
  ['VNPay callback signature', 18],
  ['what timezone should dates be stored in', 19],
  ['mật khẩu băm bằng thuật toán gì', 23],
  ['can a customer combine two discount codes', 24],
  ['reconcilePayments', 31],
  ['don hang bi treo pending', 31],
  ['who approves large refunds', 29],
  ['ao thun slug', 28],
  ['why is the recommendation widget off on phones', 30],
  ['thư viện UI', 15],
  ['commit message format', 26],
  ['how do I run just the API tests', 2],
  ['mock the date in tests', 20],
  ['where are the email templates', 16],
  ['ảnh sản phẩm lưu ở đâu', 7],
  ['409 from inventory', 27],
  ['nightly exchange rate job', 17],
]
