import { createContext, useContext } from 'react'

/**
 * Inside the table view's keyboard grid (docs/adr/1407-*): the cell itself takes the Tab stop (roving
 * tabindex), so the buttons inside a cell are not Tab stops of their own, and the cell's opener carries
 * `data-cell-edit` (what Enter/F2 presses), its editing field `data-cell-input` (Enter there saves and
 * moves down) and its pop-up list `data-cell-popup` (arrows move between the options).
 */
export const InGridContext = createContext(false)

export function useInGrid(): boolean {
  return useContext(InGridContext)
}

/** tabIndex for a control inside a grid cell: out of the Tab order there, unchanged elsewhere. */
export function useCellTabIndex(): number | undefined {
  return useInGrid() ? -1 : undefined
}
