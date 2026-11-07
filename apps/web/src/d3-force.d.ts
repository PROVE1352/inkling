// @types/d3-force is not installed — declare only the minimal surface the graph layout needs, as any.
declare module 'd3-force' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceSimulation<N = any>(nodes?: N[]): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceLink<L = any>(links?: L[]): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceManyBody(): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceCenter(x?: number, y?: number): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceX(x?: number): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceY(y?: number): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceCollide(radius?: number | ((d: any) => number)): any
}
