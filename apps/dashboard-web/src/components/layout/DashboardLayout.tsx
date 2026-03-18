import Sidebar from './Sidebar'
import SetupGuard from './SetupGuard'
import styles from './DashboardLayout.module.css'

interface DashboardLayoutProps {
  children: React.ReactNode
  title?: string
  subtitle?: string
}

export default function DashboardLayout({ children, title, subtitle }: DashboardLayoutProps) {
  return (
    <SetupGuard>
      <div className={styles.wrapper}>
        <Sidebar />
        <main className={styles.main}>
          {title && (
            <header className={styles.pageHeader}>
              <h1 className={styles.title}>{title}</h1>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </header>
          )}
          <div className={styles.content}>{children}</div>
        </main>
      </div>
    </SetupGuard>
  )
}
