# Study Map — the WebMCP retrofit boundary

Study Map is a focused learning product retrofitted onto the existing MIT-licensed Excalidraw app, not a new canvas built for a demo. The editor remains usable; WebMCP adds page-owned tools for reading the live study graph, finding open questions, and writing an answer next to the node a person chose.

**[Open Study Map](https://hungson175.github.io/study-map/) · [Inspect the public source](https://github.com/hungson175/study-map)**

The inherited retrofit history below describes the seed on which Study Map is built. Study Map adds a study-first welcome, a human-pinned question marker, bounded chart reads, and an immediate undoable answer path. Native invocation claims remain pending until this exact origin passes its own gate.

## Measured cost

The interval from assignment at 08:51 to independent public closure at 10:18 was **87 minutes of agent-assisted elapsed time**. It includes the host spike, tests-first implementation, pair review, deploy, and two different public browser gates. It is not a claim about human engineer-hours, dollars, or causal speed.

Pinned snapshot: upstream `e1bb9ff8` → audited public product `59ca1586`. The documentation generator is outside that snapshot, so the numbers do not count themselves.

| Slice      |  Files |    Added | Deleted |
| ---------- | -----: | -------: | ------: |
| Product    |      8 |     1529 |       0 |
| Tests      |      8 |     1145 |       0 |
| Host spike |      1 |       15 |       0 |
| **Total**  | **17** | **2689** |   **0** |

<details><summary>All measured paths</summary>

| Path | Slice | + | − |
| --- | --- | --: | --: |
| `excalidraw-app/App.tsx` | Product | 2 | 0 |
| `excalidraw-app/index.html` | Product | 4 | 0 |
| `excalidraw-app/vite.config.mts` | Product | 2 | 0 |
| `excalidraw-app/webmcp/RetrofitPanel.scss` | Product | 107 | 0 |
| `excalidraw-app/webmcp/RetrofitPanel.tsx` | Product | 217 | 0 |
| `excalidraw-app/webmcp/__tests__/AppRetrofitIntegration.test.ts` | Tests | 21 | 0 |
| `excalidraw-app/webmcp/__tests__/RetrofitPanel.test.tsx` | Tests | 84 | 0 |
| `excalidraw-app/webmcp/__tests__/WebMCPPanelRegistration.test.tsx` | Tests | 55 | 0 |
| `excalidraw-app/webmcp/__tests__/connect_ghost.test.tsx` | Tests | 97 | 0 |
| `excalidraw-app/webmcp/__tests__/connect_shapes.test.ts` | Tests | 412 | 0 |
| `excalidraw-app/webmcp/__tests__/origin_trial_meta.test.ts` | Tests | 26 | 0 |
| `excalidraw-app/webmcp/__tests__/retrofit_controller.test.ts` | Tests | 255 | 0 |
| `excalidraw-app/webmcp/__tests__/webmcp_adapter.test.ts` | Tests | 195 | 0 |
| `excalidraw-app/webmcp/retrofit_controller.ts` | Product | 955 | 0 |
| `excalidraw-app/webmcp/tool_registry.ts` | Product | 140 | 0 |
| `excalidraw-app/webmcp/webmcp_adapter.ts` | Product | 102 | 0 |
| `spike-tests/base-path.test.mjs` | Host spike | 15 | 0 |

</details>

## What changed

- **Eight host-facing product files.** The app mount changed by two lines, the Origin Trial tag added four, and the static-host base added two. The rest is an isolated panel, typed registry, adapter, and controller under `excalidraw-app/webmcp/`.
- **Four composable tools.** `select_shapes` feeds `align_shapes`, `equalize_size`, and `connect_shapes`. Later calls read the pending projection, not stale canonical geometry.
- **Public host seams only.** The retrofit uses `ExcalidrawImperativeAPI`, one exported `convertToExcalidrawElements` call for the complete binding graph, and `updateScene` as a storage boundary. It does not mutate an undocumented scene store.
- **Progressive browser registration.** Unsupported browsers retain normal Excalidraw and register nothing. An owned `AbortSignal` prevents a partial or stale tool lifetime.

## The safety boundary is visible

Agent changes render as amber `UNCOMMITTED` ghosts while the saved scene stays unchanged. Duplicate or stale connector work refuses with `unsafe_retry`; cancellation leaves no delta. There is deliberately no commit tool. Only a trusted click on **Commit layout** atomically applies replacements and additions; Discard removes the proposal.

## Public proof

In stock Chrome 154 with no WebMCP flags or injection, the live page exposed exactly four tools. One gate composed six rectangles into six bound arrows while the scene stayed at seven elements until a trusted click changed it to thirteen. A separate independent gate used four rectangles and one diamond, refused a duplicate, and changed five elements to nine. Both fresh second profiles were empty and both runs recorded zero console, page, or request errors.

- `browser_api=PASS`
- `native_agent_invocation=UNPROVEN`

## Why this belongs in the page, not an extension

An extension could reach undocumented app internals in the main world, but it would break with host releases and need a different extension for every app. This retrofit is shipped by the page against explicit seams—the friction a shared browser standard is meant to remove.

## Reproduce this page

```bash
python3 artifacts/retrofit-cost-ledger/generate_retrofit_md.py --config artifacts/retrofit-cost-ledger/config.json --output RETROFIT.md --check
```

The command uses only Python's standard library and the pinned local Git commits.
