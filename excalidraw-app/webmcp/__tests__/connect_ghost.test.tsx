import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RetrofitPanel } from "../RetrofitPanel";
import { createRetrofitController } from "../retrofit_controller";

const elements = [
  {
    id: "service-a",
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
    boundElements: null,
  },
  {
    id: "service-b",
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
    boundElements: null,
  },
  {
    id: "gateway",
    type: "diamond",
    x: 420,
    y: 60,
    width: 120,
    height: 100,
    version: 1,
    versionNonce: 30,
    isDeleted: false,
    locked: false,
    angle: 0,
    boundElements: null,
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

describe("connector ghost preview", () => {
  it("renders one inert amber directed ghost per staged source", async () => {
    const api = makeApi();
    const controller = createRetrofitController(api as never);
    await controller.executeTool(
      "connect_shapes",
      { sourceIds: ["service-a", "service-b"], targetId: "gateway" },
      { signal: new AbortController().signal },
    );

    const { container } = render(
      <RetrofitPanel api={api as never} controller={controller} />,
    );

    await waitFor(() =>
      expect(screen.getByText("WEBMCP UNAVAILABLE")).toBeTruthy(),
    );
    expect(screen.getByText("UNCOMMITTED")).toBeTruthy();
    expect(
      container.querySelector(".webmcp-retrofit > p")?.textContent,
    ).toContain("connect_shapes");
    const connectors = container.querySelectorAll(
      "[data-ghost-connector='true']",
    );
    expect(connectors).toHaveLength(2);
    connectors.forEach((connector) => {
      expect(connector).toHaveAttribute("marker-end", "url(#webmcp-arrowhead)");
    });
    expect(container.querySelector("[data-ghost-overlay='true']")).toHaveStyle({
      pointerEvents: "none",
    });
  });
});
