import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RetrofitPanel } from "../RetrofitPanel";
import { createRetrofitController } from "../retrofit_controller";

const makeApi = () => ({
  getSceneElements: () => [],
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

describe("create_shapes ghost preview", () => {
  it("renders staged rectangle, ellipse, diamond, and labels honestly", async () => {
    const api = makeApi();
    const controller = createRetrofitController(api as never);
    await act(async () => {
      await controller.executeTool(
        "create_shapes",
        {
          shapes: [
            { type: "rectangle", label: "Browser", x: 80, y: 100 },
            { type: "ellipse", label: "Worker", x: 280, y: 100 },
            { type: "diamond", label: "Storage", x: 480, y: 100 },
          ],
        },
        { signal: new AbortController().signal },
      );
    });

    const view = render(
      <RetrofitPanel api={api as never} controller={controller} />,
    );
    await waitFor(() =>
      expect(screen.getByText("WEBMCP UNAVAILABLE")).toBeTruthy(),
    );
    const overlay = view.container.querySelector("[data-ghost-overlay='true']");
    expect(overlay?.querySelectorAll("rect[data-ghost='true']")).toHaveLength(
      1,
    );
    expect(
      overlay?.querySelectorAll("ellipse[data-ghost='true']"),
    ).toHaveLength(1);
    expect(
      overlay?.querySelectorAll("polygon[data-ghost='true']"),
    ).toHaveLength(1);
    expect(
      Array.from(
        overlay?.querySelectorAll("text[data-ghost='true']") ?? [],
      ).map((node) => node.textContent),
    ).toEqual(["Browser", "Worker", "Storage"]);
    expect(api.updateScene).not.toHaveBeenCalled();
  });
});
