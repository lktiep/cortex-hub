import { defineConfig, type DefaultTheme } from 'vitepress'

const repo = 'https://github.com/lktiep/cortex-hub'

// The showcase's mark: three nodes, one plan.
const favicon =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 26 26'><rect width='26' height='26' rx='6' fill='%23dc440c'/><g fill='white'><circle cx='8' cy='9' r='2.4'/><circle cx='18' cy='9' r='2.4'/><circle cx='13' cy='18' r='2.4'/></g><path d='M10.2 9.6 L15.8 9.6 M9.2 11 L11.8 15.8 M16.8 11 L14.2 15.8' stroke='white' stroke-width='1.4'/></svg>"

/** Both locales share one page tree; `p` is '' for English and '/vi' for Vietnamese. */
function sidebar(p: string, t: Record<string, string>): DefaultTheme.SidebarItem[] {
  return [
    {
      text: t.start,
      items: [
        { text: t.overview, link: `${p}/guide/what-is-cortex` },
        { text: t.quickStart, link: `${p}/guide/quick-start` },
        { text: t.selfHost, link: `${p}/guide/self-host` },
      ],
    },
    {
      text: t.guides,
      items: [
        { text: t.sessions, link: `${p}/guide/sessions` },
        { text: t.code, link: `${p}/guide/code-intelligence` },
        { text: t.knowledge, link: `${p}/guide/knowledge-memory` },
        { text: t.gates, link: `${p}/guide/quality-gates` },
        { text: t.subagents, link: `${p}/guide/subagents` },
        { text: t.multiIde, link: `${p}/guide/multi-ide` },
      ],
    },
    {
      text: 'Conductor',
      items: [
        { text: t.plans, link: `${p}/conductor/overview` },
        { text: t.workers, link: `${p}/conductor/workers` },
        { text: t.review, link: `${p}/conductor/review` },
        { text: t.showcase, link: '/conductor/index.html', target: '_self' },
      ],
    },
    {
      text: t.reference,
      items: [
        { text: t.cli, link: `${p}/reference/cli` },
        { text: t.installer, link: `${p}/reference/installer` },
        { text: t.commands, link: `${p}/reference/slash-commands` },
        { text: t.hooks, link: `${p}/reference/hooks` },
        { text: t.tools, link: `${p}/reference/mcp-tools` },
        { text: t.config, link: `${p}/reference/configuration` },
        { text: t.mods, link: `${p}/reference/mods` },
        { text: t.dashboard, link: `${p}/reference/dashboard` },
        { text: t.scripts, link: `${p}/reference/scripts` },
      ],
    },
    {
      text: t.architecture,
      items: [
        { text: t.archOverview, link: `${p}/architecture/` },
        { text: t.stack, link: `${p}/architecture/tech-stack` },
        { text: t.adr, link: `${p}/architecture/decisions` },
        { text: t.bench, link: `${p}/architecture/benchmarks` },
      ],
    },
  ]
}

function nav(p: string, t: Record<string, string>): DefaultTheme.NavItem[] {
  return [
    { text: t.navGuide, link: `${p}/guide/what-is-cortex`, activeMatch: `^${p}/guide/` },
    { text: 'Conductor', link: `${p}/conductor/overview`, activeMatch: `^${p}/conductor/` },
    { text: t.reference, link: `${p}/reference/cli`, activeMatch: `^${p}/reference/` },
    { text: t.architecture, link: `${p}/architecture/`, activeMatch: `^${p}/architecture/` },
    {
      text: 'v1.3',
      items: [
        { text: t.releases, link: `${repo}/releases` },
        { text: t.showcase, link: '/conductor/index.html', target: '_self' },
        { text: 'CONTRIBUTING', link: `${repo}/blob/master/docs/CONTRIBUTING.md` },
      ],
    },
  ]
}

const en = {
  start: 'Getting started', overview: 'What is Cortex Hub', quickStart: 'Quick start',
  selfHost: 'Self-host the hub', guides: 'Guides', sessions: 'Sessions and recall',
  code: 'Code intelligence', knowledge: 'Knowledge and memory', gates: 'Quality gates',
  subagents: 'Subagents', multiIde: 'Multi-IDE', plans: 'Plans and the lead', workers: 'Workers',
  review: 'Review, gates and quota', showcase: 'Conductor showcase', reference: 'Reference',
  cli: 'cw (cortex-worker)', installer: 'Installer', commands: 'Slash commands and skills',
  hooks: 'Hooks', tools: 'MCP tools', config: 'Environment and config', mods: 'Mods: cortex-bar',
  dashboard: 'Dashboard', scripts: 'Scripts', architecture: 'Architecture',
  archOverview: 'Overview', stack: 'Tech stack', adr: 'Decisions (ADRs)', bench: 'Benchmarks',
  navGuide: 'Guide', releases: 'Changelog and releases',
}

const vi = {
  start: 'Bắt đầu', overview: 'Cortex Hub là gì', quickStart: 'Cài nhanh',
  selfHost: 'Tự dựng hub', guides: 'Hướng dẫn', sessions: 'Phiên làm việc và nhớ lại',
  code: 'Hiểu code', knowledge: 'Knowledge và memory', gates: 'Cổng chất lượng',
  subagents: 'Subagent', multiIde: 'Nhiều IDE', plans: 'Kế hoạch và lead', workers: 'Worker',
  review: 'Review, gate và quota', showcase: 'Trang giới thiệu Conductor', reference: 'Tra cứu',
  cli: 'cw (cortex-worker)', installer: 'Bộ cài', commands: 'Lệnh slash và skill',
  hooks: 'Hook', tools: 'Công cụ MCP', config: 'Biến môi trường và cấu hình', mods: 'Mod: cortex-bar',
  dashboard: 'Dashboard', scripts: 'Script', architecture: 'Kiến trúc',
  archOverview: 'Tổng quan', stack: 'Công nghệ', adr: 'Quyết định (ADR)', bench: 'Benchmark',
  navGuide: 'Hướng dẫn', releases: 'Nhật ký thay đổi',
}

export default defineConfig({
  title: 'Cortex Hub',
  description: 'Self-hosted memory, code intelligence and multi-agent orchestration for every AI coding agent.',
  base: '/cortex-hub/',
  cleanUrls: true,
  // The showcase is a plain HTML page in public/, outside the VitePress router.
  ignoreDeadLinks: [/^\/conductor\/index\.html$/],
  head: [
    ['link', { rel: 'icon', href: favicon }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap',
      },
    ],
    ['meta', { name: 'theme-color', content: '#dc440c' }],
  ],
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: nav('', en),
        sidebar: sidebar('', en),
        editLink: { pattern: `${repo}/edit/master/website/:path`, text: 'Edit this page on GitHub' },
      },
    },
    vi: {
      label: 'Tiếng Việt',
      lang: 'vi',
      link: '/vi/',
      title: 'Cortex Hub',
      description: 'Bộ nhớ, hiểu code và điều phối nhiều agent, tự host, cho mọi AI coding agent.',
      themeConfig: {
        nav: nav('/vi', vi),
        sidebar: sidebar('/vi', vi),
        editLink: { pattern: `${repo}/edit/master/website/:path`, text: 'Sửa trang này trên GitHub' },
        outline: { label: 'Trên trang này' },
        docFooter: { prev: 'Trang trước', next: 'Trang sau' },
        darkModeSwitchLabel: 'Giao diện',
        lightModeSwitchTitle: 'Chuyển sang nền sáng',
        darkModeSwitchTitle: 'Chuyển sang nền tối',
        sidebarMenuLabel: 'Mục lục',
        returnToTopLabel: 'Lên đầu trang',
        langMenuLabel: 'Đổi ngôn ngữ',
        notFound: {
          title: 'KHÔNG TÌM THẤY TRANG',
          quote: 'Trang này không có, hoặc đã đổi chỗ.',
          linkLabel: 'về trang chủ',
          linkText: 'Về trang chủ',
        },
      },
    },
  },
  themeConfig: {
    logo: { src: '/mark.svg', alt: '' },
    siteTitle: 'Cortex Hub',
    socialLinks: [{ icon: 'github', link: repo }],
    outline: { level: [2, 3] },
    search: {
      provider: 'local',
      options: {
        locales: {
          vi: {
            translations: {
              button: { buttonText: 'Tìm kiếm', buttonAriaLabel: 'Tìm kiếm' },
              modal: {
                displayDetails: 'Hiện chi tiết',
                resetButtonTitle: 'Xoá từ khoá',
                backButtonTitle: 'Đóng',
                noResultsText: 'Không có kết quả cho',
                footer: { selectText: 'chọn', navigateText: 'di chuyển', closeText: 'đóng' },
              },
            },
          },
        },
      },
    },
    footer: {
      message: 'MIT License',
      copyright: 'Cortex Hub contributors',
    },
  },
})
