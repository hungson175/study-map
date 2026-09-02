import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  resolveQuestionTarget,
  StudyMapPanel,
  submitQuestionFromHuman,
} from "../study/StudyMapPanel";
import { ProductShell } from "../product/ProductShell";
import { RetrofitPanel } from "../RetrofitPanel";

const studyToolNames = [
  "how_to_use",
  "get_chart",
  "get_selection",
  "list_questions",
  "answer_question",
];

const node = (id = "hang-lang", locked = false) =>
  ({
    id,
    type: "rectangle",
    x: 100,
    y: 100,
    width: 180,
    height: 72,
    angle: 0,
    isDeleted: false,
    locked,
    customData: null,
  } as unknown as ExcalidrawElement);

const makeApi = (initial: ExcalidrawElement[] = []) => {
  let elements = initial;
  let selectedElementIds: Record<string, boolean> = {};
  const updateScene = vi.fn(
    (scene: { elements: readonly ExcalidrawElement[] }) => {
      elements = [...scene.elements];
    },
  );
  return {
    api: {
      getSceneElements: vi.fn(() => elements),
      getAppState: vi.fn(() => ({ selectedElementIds })),
      getFiles: vi.fn(() => ({})),
      updateScene,
    },
    setSelected: (...ids: string[]) => {
      selectedElementIds = Object.fromEntries(ids.map((id) => [id, true]));
    },
    updateScene,
  };
};

const makeController = () => ({
  listTools: vi.fn(() =>
    studyToolNames.map((name, index) => ({
      name,
      description: index === 0 ? "Start here: Study Map" : name,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: index < 4 },
    })),
  ),
  executeTool: vi.fn(async () => ({ ok: true })),
  pinQuestionFromHuman: vi.fn(() => ({
    ok: true as const,
    questionId: "question-1",
  })),
  dispose: vi.fn(),
});

const invokeReactHandler = (
  element: Element,
  name: "onClick" | "onPointerDown" | "onSubmit",
  payload: unknown,
) => {
  const key = Object.keys(element).find((entry) =>
    entry.startsWith("__reactProps"),
  );
  if (!key) {
    throw new Error("React test props were unavailable");
  }
  const handler = (
    element as unknown as Record<string, Record<string, unknown>>
  )[key][name];
  if (typeof handler !== "function") {
    throw new Error(`${name} was unavailable`);
  }
  return handler(payload);
};

const originalModelContext = (document as Document & { modelContext?: unknown })
  .modelContext;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: originalModelContext,
  });
});

describe("Study Map panel", () => {
  it("starts with a study welcome and dismisses without changing the scene", async () => {
    const fixture = makeApi();
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "What are you learning today?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Learn anything as a map you and ChatGPT draw together.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Paste what you are learning")).toBeTruthy();
    expect(screen.getByLabelText("Choose a PDF")).toHaveAttribute(
      "accept",
      ".pdf,application/pdf",
    );
    expect(
      screen.getByRole("button", { name: "Talk to ChatGPT" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open a blank study map" }),
    );
    expect(
      screen.queryByRole("heading", { name: "What are you learning today?" }),
    ).toBeNull();
    expect(fixture.updateScene).not.toHaveBeenCalled();
    expect(fixture.api.getFiles).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/WebMCP (unavailable|count unavailable)/),
    ).toBeTruthy();
  });

  it("bounds pasted text and records only sanitized PDF metadata", async () => {
    const fixture = makeApi();
    const fileReader = vi.fn();
    vi.stubGlobal("FileReader", fileReader);
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
      />,
    );

    const paste = screen.getByLabelText(
      "Paste what you are learning",
    ) as HTMLTextAreaElement;
    fireEvent.change(paste, { target: { value: "x".repeat(5000) } });
    expect(paste.value).toHaveLength(4000);

    const pdf = new File(["not read"], "vua Đinh?.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByLabelText("Choose a PDF"), {
      target: { files: [pdf] },
    });
    expect(screen.getByText(/vua__inh_.pdf/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${pdf.size} bytes`))).toBeTruthy();
    expect(fixture.api.getFiles).not.toHaveBeenCalled();
    expect(fileReader).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/WebMCP (unavailable|count unavailable)/),
    ).toBeTruthy();
  });

  it("rejects non-PDF input without reading it", async () => {
    const fixture = makeApi();
    const fileReader = vi.fn();
    vi.stubGlobal("FileReader", fileReader);
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
      />,
    );

    fireEvent.change(screen.getByLabelText("Choose a PDF"), {
      target: {
        files: [new File(["plain"], "notes.txt", { type: "text/plain" })],
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Choose one PDF");
    expect(fileReader).not.toHaveBeenCalled();
    expect(fixture.api.getFiles).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/WebMCP (unavailable|count unavailable)/),
    ).toBeTruthy();
  });

  it("accepts a dropped PDF through the same metadata-only seam", async () => {
    const fixture = makeApi();
    const fileReader = vi.fn();
    vi.stubGlobal("FileReader", fileReader);
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
      />,
    );

    const pdf = new File(["still not read"], "lesson?.pdf", {
      type: "application/pdf",
    });
    const dropZone = screen.getByText("Drop a PDF").closest("label");
    expect(dropZone).toBeTruthy();
    fireEvent.drop(dropZone!, { dataTransfer: { files: [pdf] } });

    expect(screen.getByText(/lesson_.pdf/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${pdf.size} bytes`))).toBeTruthy();
    expect(fileReader).not.toHaveBeenCalled();
    expect(fixture.api.getFiles).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/WebMCP (unavailable|count unavailable)/),
    ).toBeTruthy();
  });

  it("keeps all sixteen sibling tools while how_to_use is attempted first", async () => {
    const definitions: Array<{ name: string }> = [];
    const signals: AbortSignal[] = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(
          async (
            definition: { name: string },
            options: { signal: AbortSignal },
          ) => {
            definitions.push(definition);
            signals.push(options.signal);
          },
        ),
        getTools: vi.fn(async () => definitions),
      },
    });
    const api = {
      ...makeApi().api,
      addFiles: vi.fn(),
      getAppState: vi.fn(() => ({
        selectedElementIds: {},
        exportBackground: true,
        viewBackgroundColor: "#fff",
        width: 1200,
        height: 800,
        offsetLeft: 0,
        offsetTop: 0,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      })),
      onChange: vi.fn(() => () => undefined),
      onScrollChange: vi.fn(() => () => undefined),
    };
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(),
      list: vi.fn(async () => []),
      rename: vi.fn(async () => null),
      delete: vi.fn(async () => false),
    };
    const view = render(
      <>
        <StudyMapPanel
          api={api as never}
          controller={makeController() as never}
        />
        <RetrofitPanel api={api as never} />
        <ProductShell api={api as never} store={store as never} />
      </>,
    );

    const expected = [
      ...studyToolNames,
      "select_shapes",
      "align_shapes",
      "equalize_size",
      "distribute_shapes",
      "connect_shapes",
      "create_shapes",
      "get_canvas_state",
      "list_saved_canvases",
      "save_canvas",
      "create_canvas",
      "open_saved_canvas",
    ];
    await waitFor(() => expect(definitions).toHaveLength(16));
    expect(await screen.findByText("16 tools observed")).toBeTruthy();
    expect(definitions[0].name).toBe("how_to_use");
    expect(new Set(definitions.map(({ name }) => name))).toEqual(
      new Set(expected),
    );
    expect(new Set(definitions.map(({ name }) => name)).size).toBe(16);

    view.unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("re-observes the actual sibling registry after concurrent registration settles", async () => {
    const definitions: Array<{ name: string }> = [];
    const getTools = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 15 }, (_, index) => ({ name: `early-${index}` })),
      )
      .mockImplementation(async () => definitions);
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(async (definition: { name: string }) => {
          definitions.push(definition);
        }),
        getTools,
      },
    });
    const api = {
      ...makeApi().api,
      addFiles: vi.fn(),
      getAppState: vi.fn(() => ({
        selectedElementIds: {},
        exportBackground: true,
        viewBackgroundColor: "#fff",
        width: 1200,
        height: 800,
        offsetLeft: 0,
        offsetTop: 0,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      })),
      onChange: vi.fn(() => () => undefined),
      onScrollChange: vi.fn(() => () => undefined),
    };
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(),
      list: vi.fn(async () => []),
      rename: vi.fn(async () => null),
      delete: vi.fn(async () => false),
    };
    const view = render(
      <>
        <StudyMapPanel
          api={api as never}
          controller={makeController() as never}
        />
        <RetrofitPanel api={api as never} />
        <ProductShell api={api as never} store={store as never} />
      </>,
    );

    expect(await screen.findByText("15 tools observed")).toBeTruthy();
    expect(
      await screen.findByText("16 tools observed", {}, { timeout: 1000 }),
    ).toBeTruthy();
    expect(definitions).toHaveLength(16);
    expect(getTools.mock.calls.length).toBeGreaterThanOrEqual(2);

    view.unmount();
  });

  it("cancels delayed registry observations when the panel unmounts", async () => {
    const getTools = vi.fn(async () => studyToolNames);
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(async () => undefined),
        getTools,
      },
    });
    const view = render(
      <StudyMapPanel
        api={makeApi().api as never}
        controller={makeController() as never}
      />,
    );

    expect(await screen.findByText("5 tools observed")).toBeTruthy();
    expect(getTools).toHaveBeenCalledOnce();
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(getTools).toHaveBeenCalledOnce();
  });

  it("copies a live-origin prompt that tells the agent to call how_to_use first", async () => {
    window.history.replaceState({}, "", "/study-map/");
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <StudyMapPanel
        api={makeApi().api as never}
        controller={makeController() as never}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Talk to ChatGPT" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("Study Map");
    expect(writeText.mock.calls[0][0]).toContain("/study-map/");
    expect(writeText.mock.calls[0][0]).toMatch(/call how_to_use first/i);
  });

  it("fails a missing or rejecting clipboard without leaking the study input", async () => {
    const fixture = makeApi();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const first = render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Talk to ChatGPT" }));
    expect(screen.getByRole("status")).toHaveTextContent("Copy unavailable");
    first.unmount();

    const writeText = vi.fn(async (_value: string) => {
      throw new Error("denied");
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Talk to ChatGPT" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Copy unavailable"),
    );
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("registers only the five study tools through ownerDocument and aborts on unmount", async () => {
    const definitions: Array<{ name: string }> = [];
    const signals: AbortSignal[] = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(
          async (
            definition: { name: string },
            options: { signal: AbortSignal },
          ) => {
            definitions.push(definition);
            signals.push(options.signal);
          },
        ),
        getTools: vi.fn(async () => definitions),
      },
    });
    const controller = makeController();
    const view = render(
      <StudyMapPanel
        api={makeApi().api as never}
        controller={controller as never}
      />,
    );

    await waitFor(() =>
      expect(definitions.map(({ name }) => name)).toEqual(studyToolNames),
    );
    expect(definitions[0].name).toBe("how_to_use");
    expect(await screen.findByText("5 tools observed")).toBeTruthy();
    expect(signals.every((entry) => !entry.aborted)).toBe(true);

    view.unmount();
    expect(signals.every((entry) => entry.aborted)).toBe(true);
    expect(controller.dispose).not.toHaveBeenCalled();
  });

  it("reports object-shaped counts, registration failure, and missing count honestly", async () => {
    const controller = makeController();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(async () => undefined),
        getTools: vi.fn(async () => ({ tools: controller.listTools() })),
      },
    });
    const first = render(
      <StudyMapPanel
        api={makeApi().api as never}
        controller={controller as never}
      />,
    );
    expect(await screen.findByText("5 tools observed")).toBeTruthy();
    first.unmount();

    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool: vi.fn(async () => undefined) },
    });
    const second = render(
      <StudyMapPanel
        api={makeApi().api as never}
        controller={makeController() as never}
      />,
    );
    expect(await screen.findByText("WebMCP count unavailable")).toBeTruthy();
    second.unmount();

    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(async () => {
          throw new Error("registration refused");
        }),
      },
    });
    render(
      <StudyMapPanel
        api={makeApi().api as never}
        controller={makeController() as never}
      />,
    );
    expect(
      await screen.findByText("WebMCP registration failed safely"),
    ).toBeTruthy();
  });

  it("owns and disposes its controller when none is supplied", async () => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: undefined,
    });
    const view = render(<StudyMapPanel api={makeApi([node()]).api as never} />);
    expect(
      await screen.findByText("WebMCP unavailable in this browser"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "What are you learning today?" }),
    ).toBeNull();
    view.unmount();
  });

  it("fails visibly when WebMCP is unavailable instead of asserting a count", async () => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: undefined,
    });
    render(
      <StudyMapPanel
        api={makeApi().api as never}
        controller={makeController() as never}
      />,
    );

    expect(await screen.findByText(/WebMCP unavailable/)).toBeTruthy();
    expect(screen.queryByText("16 tools observed")).toBeNull();
  });

  it("resolves a live target only after trust and submits through the S1 seam", () => {
    const fixture = makeApi([node("hang-lang")]);
    fixture.setSelected("hang-lang");
    expect(
      resolveQuestionTarget({ isTrusted: false }, fixture.api as never),
    ).toMatchObject({ ok: false, reason: "human_gesture_required" });
    expect(
      resolveQuestionTarget({ isTrusted: true }, fixture.api as never),
    ).toMatchObject({ ok: true, nodeId: "hang-lang" });

    fixture.setSelected("hang-lang", "other");
    expect(
      resolveQuestionTarget({ isTrusted: true }, fixture.api as never),
    ).toMatchObject({ ok: false, reason: "single_study_node_required" });

    fixture.setSelected("missing");
    expect(
      resolveQuestionTarget({ isTrusted: true }, fixture.api as never),
    ).toMatchObject({ ok: false, reason: "single_study_node_required" });

    const controller = makeController();
    expect(
      submitQuestionFromHuman(
        controller as never,
        { isTrusted: true },
        { nodeId: "hang-lang", text: "Mẹ là ai?" },
      ),
    ).toEqual({ ok: true, questionId: "question-1" });
    expect(controller.pinQuestionFromHuman).toHaveBeenCalledWith(
      { isTrusted: true },
      { nodeId: "hang-lang", text: "Mẹ là ai?" },
    );

    const labelled = node("labelled") as ExcalidrawElement & {
      boundElements: Array<{ id: string; type: "text" }>;
    };
    labelled.boundElements = [{ id: "label", type: "text" }];
    const label = {
      id: "label",
      type: "text",
      text: `  ${"Vua Đinh ".repeat(20)}  `,
      isDeleted: false,
    } as unknown as ExcalidrawElement;
    const labelledFixture = makeApi([labelled, label]);
    labelledFixture.setSelected("labelled");
    const resolved = resolveQuestionTarget(
      { isTrusted: true },
      labelledFixture.api as never,
    );
    expect(resolved).toMatchObject({ ok: true, nodeId: "labelled" });
    expect(resolved.ok && resolved.label.length).toBe(120);

    for (const rejected of [
      node("locked", true),
      { ...node("deleted"), isDeleted: true },
      { ...node("line"), type: "line" },
      { ...node("question"), customData: { kind: "question" } },
      { ...node("answer"), customData: { kind: "answer" } },
    ]) {
      const rejectedFixture = makeApi([rejected as ExcalidrawElement]);
      rejectedFixture.setSelected(rejected.id);
      expect(
        resolveQuestionTarget(
          { isTrusted: true },
          rejectedFixture.api as never,
        ),
      ).toMatchObject({ ok: false, reason: "single_study_node_required" });
    }
  });

  it("opens, cancels, and submits the question form through the trusted handler path", async () => {
    const fixture = makeApi([node("hang-lang")]);
    fixture.setSelected("hang-lang");
    const controller = makeController();
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={controller as never}
        initialWelcomeOpen={false}
      />,
    );
    const open = screen.getByRole("button", {
      name: "? Ask about selected node",
    });
    act(() =>
      invokeReactHandler(open, "onClick", { nativeEvent: { isTrusted: true } }),
    );
    expect(screen.getByRole("form", { name: "Ask about node" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Ask about node" })).toBeNull();
    expect(fixture.updateScene).not.toHaveBeenCalled();

    act(() =>
      invokeReactHandler(open, "onClick", { nativeEvent: { isTrusted: true } }),
    );
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Mẹ là ai?" },
    });
    const form = screen.getByRole("form", { name: "Ask about node" });
    act(() =>
      invokeReactHandler(form, "onSubmit", {
        preventDefault: vi.fn(),
        nativeEvent: { isTrusted: true },
      }),
    );
    expect(controller.pinQuestionFromHuman).toHaveBeenCalledWith(
      { isTrusted: true },
      { nodeId: "hang-lang", text: "Mẹ là ai?" },
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "answer lands directly",
    );
    expect(screen.queryByRole("form", { name: "Ask about node" })).toBeNull();
    expect(
      await screen.findByText(/WebMCP (unavailable|count unavailable)/),
    ).toBeTruthy();
  });

  it("keeps the trusted pointer target when Excalidraw clears selection before click", async () => {
    const fixture = makeApi([node("hang-lang")]);
    fixture.setSelected("hang-lang");
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
        initialWelcomeOpen={false}
      />,
    );
    const open = screen.getByRole("button", {
      name: "? Ask about selected node",
    });

    act(() =>
      invokeReactHandler(open, "onPointerDown", {
        nativeEvent: { isTrusted: true },
      }),
    );
    fixture.setSelected();
    act(() =>
      invokeReactHandler(open, "onClick", { nativeEvent: { isTrusted: true } }),
    );

    expect(screen.getByRole("form", { name: "Ask about node" })).toBeTruthy();
    expect(screen.getByText("Selected node")).toBeTruthy();
    expect(await screen.findByText(/WebMCP unavailable/)).toBeTruthy();
  });

  it("refuses a pointer target deleted before its trusted click is consumed", async () => {
    const fixture = makeApi([node("hang-lang")]);
    fixture.setSelected("hang-lang");
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
        initialWelcomeOpen={false}
      />,
    );
    const open = screen.getByRole("button", {
      name: "? Ask about selected node",
    });

    act(() =>
      invokeReactHandler(open, "onPointerDown", {
        nativeEvent: { isTrusted: true },
      }),
    );
    fixture.updateScene({
      elements: [{ ...node("hang-lang"), isDeleted: true }],
    });
    fixture.updateScene.mockClear();
    fixture.setSelected();
    act(() =>
      invokeReactHandler(open, "onClick", { nativeEvent: { isTrusted: true } }),
    );

    expect(screen.queryByRole("form", { name: "Ask about node" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Select one unlocked study node",
    );
    expect(fixture.updateScene).not.toHaveBeenCalled();
    expect(await screen.findByText(/WebMCP unavailable/)).toBeTruthy();
  });

  it("refuses synthetic UI clicks before reading selection or writing", async () => {
    const fixture = makeApi([node()]);
    fixture.setSelected("hang-lang");
    render(
      <StudyMapPanel
        api={fixture.api as never}
        controller={makeController() as never}
        initialWelcomeOpen={false}
      />,
    );

    fixture.api.getAppState.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "? Ask about selected node" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "A trusted click is required",
    );
    expect(fixture.api.getAppState).not.toHaveBeenCalled();
    expect(fixture.updateScene).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/WebMCP (unavailable|count unavailable)/),
    ).toBeTruthy();
  });
});
