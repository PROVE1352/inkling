# 0759. Hot-loop / memory-hierarchy work: measured, mostly rejected; notes for a Rust port

- Status: Accepted
- Date: 2026-11-07

## Measured
- Collection GET (10k rows): DB 26 ms, row DTO spread 0.4 ms, `JSON.stringify` 2.6 ms; the rest is the driver materialising rows (jsonb parse, Date objects). Rewriting the per-row loops for monomorphic shapes or typed arrays cannot move the needle — rejected.
- Store path: Yjs → BlockNote conversion is 8.2 ms per 300-block page; removed from the per-store path by debouncing (ADR 0750) rather than micro-optimised. The remaining per-store CPU (~1.9 ms for 93 KB) is postgres-js serialising the bytea as hex text.
- Rollup aggregation and diff3 merge were not hot in any measured scenario; not touched.

## Where a Rust (or native) port would pay off
- Yjs ⇄ document conversion and plain-text/link/tag/task extraction (`yrs` reads the update directly without materialising a JS object tree per block).
- Binary bytea transport (the Node driver hex-encodes; a native client can use the binary protocol — ~2x less CPU and bandwidth per store).
- Index extraction over contiguous buffers (one pass over the XML fragment, no intermediate block objects), and zip streaming with a fixed-size window.
These are layout/allocation wins that V8 cannot be steered into from JS without rewriting the libraries involved.
