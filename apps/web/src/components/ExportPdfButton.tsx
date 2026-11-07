import type { SVGProps } from 'react'
import { t } from '../i18n'

/** Label of the PDF export action (translated at call time). */
export function exportPdfLabel(): string {
  return t('exportPdf.label')
}

/** Line printer icon (same stroke style as components/Icons.tsx). */
export function PrinterIcon({ size = 18, ...props }: Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M7 9V3h10v6" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <path d="M7 14h10v7H7z" />
    </svg>
  )
}
