import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Cortex Hub',
  description: 'The Neural Intelligence Platform for AI Agent Orchestration',
  icons: { icon: '/icon.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  )
}
