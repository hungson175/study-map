import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RetrofitPanel } from "../RetrofitPanel";
import {
  PLAIN_REPLAY_REQUEST_EVENT,
  PLAIN_REPLAY_STATUS_EVENT,
} from "../plain_replay";
import { createRetrofitController } from "../retrofit_controller";

const elements = [
  {
    id: "left",
    type: "rectangle",
    x: 10,
    y: 20,
    width: 80,
    height: 40,
    version: 1,
    versionNonce: 10,
    isDeleted: false,
    locked: false,
    angle: 0,
  },
  {
    id: "right",
    type: "rectangle",
    x: 160,
    y: 100,
    width: 100,
    height: 50,
    version: 1,
    versionNonce: 20,
    isDeleted: false,
    locked: false,
    angle: 0,
  },
];

const makeApi = () => ({
  getSceneElements: () => elements,
  getAppState: () => ({
    selectedElementIds: {},
    width: 1200,
    height: 800,
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

describe("RetrofitPanel", () => {
  it("renders an inert amber ghost and keeps commit a human-only button", async () => {
    const api = makeApi();
    const controller = createRetrofitController(api as never);
    await controller.executeTool(
      "align_shapes",
      { ids: ["left", "right"], edge: "left", to: "first" },
      { signal: new AbortController().signal },
    );

    const { container } = render(
      <RetrofitPanel api={api as never} controller={controller} />,
    );

    await waitFor(() =>
      expect(screen.getByText("WEBMCP UNAVAILABLE")).toBeTruthy(),
    );
    expect(screen.getByText("UNCOMMITTED")).toBeTruthy();
    expect(container.querySelectorAll("[data-ghost='true']")).toHaveLength(2);
    expect(container.querySelector("[data-ghost-overlay='true']")).toHaveStyle({
      pointerEvents: "none",
    });

    const commit = screen.getByRole("button", { name: "Commit layout" });
    expect(commit).toHaveAttribute("type", "button");
    expect(commit.closest("form")).toBeNull();

    // DOM test events are synthetic (`isTrusted === false`) and must not cross
    // the same human boundary the WebMCP caller cannot cross.
    fireEvent.click(commit);
    expect(api.updateScene).not.toHaveBeenCalled();
    expect(screen.getByText("Human click required")).toBeTruthy();
  });

  it("runs the explicit replay through its sole controller and only stages", async () => {
    const api = { ...makeApi(), getSceneElements: () => [] };
    const controller = createRetrofitController(api as never);
    const statuses: unknown[] = [];
    const onStatus = (event: Event) =>
      statuses.push((event as CustomEvent).detail);
    window.addEventListener(PLAIN_REPLAY_STATUS_EVENT, onStatus);
    const view = render(
      <RetrofitPanel api={api as never} controller={controller} />,
    );

    expect(screen.getByText("READY")).toBeTruthy();
    expect(api.updateScene).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event(PLAIN_REPLAY_REQUEST_EVENT)));

    await waitFor(() => expect(screen.getByText("UNCOMMITTED")).toBeTruthy());
    expect(view.container.querySelectorAll("[data-ghost='true']")).toHaveLength(
      8,
    );
    expect(screen.getByText(/Explicit local replay staged/)).toBeTruthy();
    expect(screen.getByText(/not a native agent/i)).toBeTruthy();
    expect(api.updateScene).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Commit layout" })).toBeEnabled();
    expect(statuses.at(-1)).toEqual({
      ok: true,
      status: "uncommitted",
      completedSteps: 5,
    });

    view.unmount();
    window.removeEventListener(PLAIN_REPLAY_STATUS_EVENT, onStatus);
  });
});
