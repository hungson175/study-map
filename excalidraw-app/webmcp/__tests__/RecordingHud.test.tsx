import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordingHud } from "../RecordingHud";
import { RetrofitPanel } from "../RetrofitPanel";
import { createRetrofitController } from "../retrofit_controller";

const tools = [
  "select_shapes",
  "align_shapes",
  "equalize_size",
  "distribute_shapes",
  "connect_shapes",
].map((name) => ({ name }));

const makeApi = (liveCount: number) => ({
  getSceneElements: () => [
    ...Array.from({ length: liveCount }, (_, index) => ({
      id: `live-${index}`,
      isDeleted: false,
    })),
    { id: "deleted", isDeleted: true },
  ],
  getAppState: () => ({
    selectedElementIds: {},
    width: 1280,
    height: 1080,
    offsetLeft: 0,
    offsetTop: 0,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
  }),
  updateScene: vi.fn(),
  onChange: vi.fn(() => () => {}),
  onScrollChange: vi.fn(() => () => {}),
});

const makeSnapshot = (selected: number, pending: number, ledger: number) => ({
  selectedIds: Array.from(
    { length: selected },
    (_, index) => `selected-${index}`,
  ),
  pending: pending
    ? {
        elements: Array.from({ length: pending }, (_, index) => ({
          id: `private-pending-${index}`,
        })),
        operations: ["private-operation"],
        baseVersions: {},
      }
    : null,
  ledger: Array.from({ length: ledger }, (_, index) => ({
    sequence: index + 1,
    tool: "private-tool",
    changedIds: ["private-id"],
    outcome: "uncommitted",
  })),
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.pushState({}, "", "/");
});

describe("RecordingHud", () => {
  it("is mounted only for film=1 without replacing the existing panel", async () => {
    const api = makeApi(0);
    const controller = createRetrofitController(api as never);

    window.history.pushState({}, "", "/?film=0");
    const view = render(
      <RetrofitPanel api={api as never} controller={controller} />,
    );
    expect(screen.queryByTestId("film-hud")).toBeNull();
    expect(screen.getByLabelText("Agent layout preview")).toBeTruthy();

    view.unmount();
    window.history.pushState({}, "", "/?film=1");
    render(<RetrofitPanel api={api as never} controller={controller} />);
    expect(screen.getByTestId("film-hud")).toBeTruthy();
    expect(screen.getByLabelText("Agent layout preview")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("WEBMCP UNAVAILABLE")).toBeTruthy(),
    );
  });

  it("renders only live derived counts and updates on parent rerender", () => {
    const controller = {
      listTools: vi.fn(() => tools),
      executeTool: vi.fn(),
      commitFromHuman: vi.fn(),
      discardFromHuman: vi.fn(),
      subscribe: vi.fn(),
    };
    const first = makeSnapshot(2, 3, 4);
    const view = render(
      <RecordingHud
        api={makeApi(7) as never}
        controller={controller as never}
        snapshot={first as never}
        webmcpLabel="WEBMCP 5"
      />,
    );

    expect(screen.getByTestId("film-metric-live")).toHaveTextContent("7");
    expect(screen.getByTestId("film-metric-selected")).toHaveTextContent("2");
    expect(screen.getByTestId("film-metric-preview")).toHaveTextContent("3");
    expect(screen.getByTestId("film-metric-ledger")).toHaveTextContent("4");
    expect(screen.getByTestId("film-metric-tools")).toHaveTextContent("5");
    expect(
      screen.getByText("KEYLESS REPLAY · NOT A NATIVE AGENT"),
    ).toBeTruthy();
    expect(screen.getByText(/native_agent_invocation=UNPROVEN/)).toBeTruthy();

    view.rerender(
      <RecordingHud
        api={makeApi(8) as never}
        controller={controller as never}
        snapshot={makeSnapshot(1, 0, 5) as never}
        webmcpLabel="WEBMCP 5"
      />,
    );
    expect(screen.getByTestId("film-metric-live")).toHaveTextContent("8");
    expect(screen.getByTestId("film-metric-selected")).toHaveTextContent("1");
    expect(screen.getByTestId("film-metric-preview")).toHaveTextContent("0");
    expect(screen.getByTestId("film-metric-ledger")).toHaveTextContent("5");
    expect(screen.getByTestId("film-metric-tools")).toHaveTextContent("5");
    expect(view.container.textContent).not.toContain("private-");
    expect(controller.executeTool).not.toHaveBeenCalled();
    expect(controller.commitFromHuman).not.toHaveBeenCalled();
    expect(controller.discardFromHuman).not.toHaveBeenCalled();
    expect(controller.subscribe).not.toHaveBeenCalled();
  });

  it("advances and cleans the stopwatch while preserving film readability", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const controller = { listTools: vi.fn(() => tools) };
    const view = render(
      <RecordingHud
        api={makeApi(7) as never}
        controller={controller as never}
        snapshot={makeSnapshot(2, 3, 4) as never}
        webmcpLabel="WEBMCP 5"
      />,
    );
    expect(screen.getByTestId("film-clock")).toHaveTextContent("00:00");
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getByTestId("film-clock")).toHaveTextContent("00:01");
    view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();

    const styles = readFileSync(
      resolve("excalidraw-app/webmcp/RecordingHud.scss"),
      "utf8",
    );
    expect(styles).toMatch(/pointer-events:\s*none/);
    expect(styles).toMatch(/\.webmcp-film-clock[\s\S]*font-size:\s*48px/);
    expect(styles).toMatch(/\.webmcp-film-card strong[\s\S]*font-size:\s*32px/);
    expect(styles).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(styles).toMatch(
      /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/,
    );
  });
});
