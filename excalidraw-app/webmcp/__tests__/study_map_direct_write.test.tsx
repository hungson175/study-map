import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import * as ExcalidrawCommon from "@excalidraw/common";

import { RetrofitPanel } from "../RetrofitPanel";
import { createRetrofitController } from "../retrofit_controller";

type TestElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  locked: boolean;
  boundElements?: Array<{ id: string; type: string }> | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
};

const element = (
  id: string,
  x = 0,
  y = 0,
  patch: Partial<TestElement> = {},
): TestElement => ({
  id,
  type: "rectangle",
  x,
  y,
  width: 120,
  height: 60,
  angle: 0,
  version: 1,
  versionNonce: 10,
  isDeleted: false,
  locked: false,
  boundElements: null,
  ...patch,
});

const appState = {
  selectedElementIds: {},
  width: 1200,
  height: 800,
  offsetLeft: 0,
  offsetTop: 0,
  scrollX: 0,
  scrollY: 0,
  zoom: { value: 1 },
};

const mutableApi = (initial: TestElement[] = []) => {
  let elements: TestElement[] = structuredClone(initial);
  const updateScene = vi.fn(
    (update: { elements: TestElement[]; captureUpdate: unknown }) => {
      elements = update.elements as TestElement[];
    },
  );
  return {
    api: {
      getSceneElements: () => elements,
      getAppState: () => appState,
      updateScene,
      onChange: vi.fn(() => () => {}),
      onScrollChange: vi.fn(() => () => {}),
    },
    getElements: () => elements,
    updateScene,
  };
};

const invoke = (
  controller: ReturnType<typeof createRetrofitController>,
  name: string,
  args: unknown,
  signal = new AbortController().signal,
) => controller.executeTool(name, args, { signal });

describe("Study Map direct-write scene tools", () => {
  it("keeps staged as the default and applies immediate writes once without a commit", async () => {
    const stagedApi = mutableApi();
    const staged = createRetrofitController(stagedApi.api as never);
    const explicitStaged = createRetrofitController(stagedApi.api as never, {
      writeMode: "staged",
    });

    expect(staged.getWriteMode()).toBe("staged");
    expect(explicitStaged.getWriteMode()).toBe("staged");
    await expect(
      invoke(staged, "create_shapes", {
        shapes: [{ clientId: "topic", type: "rectangle" }],
      }),
    ).resolves.toMatchObject({ ok: true, status: "uncommitted" });
    expect(stagedApi.updateScene).not.toHaveBeenCalled();
    expect(staged.getSnapshot().pending).not.toBeNull();

    const immediateApi = mutableApi();
    const immediate = createRetrofitController(immediateApi.api as never, {
      writeMode: "immediate",
    });
    const result = await invoke(immediate, "create_shapes", {
      shapes: [{ clientId: "topic", type: "rectangle", label: "Topic" }],
    });

    expect(immediate.getWriteMode()).toBe("immediate");
    expect(result).toMatchObject({
      ok: true,
      status: "applied",
      changedCount: 1,
      createdCount: 1,
    });
    expect(immediateApi.updateScene).toHaveBeenCalledTimes(1);
    expect(immediateApi.updateScene.mock.calls[0][0].captureUpdate).toBe(
      CaptureUpdateAction.IMMEDIATELY,
    );
    expect(immediate.getSnapshot().pending).toBeNull();
    expect(immediate.getSnapshot().ledger).toMatchObject([
      { tool: "create_shapes", outcome: "applied" },
    ]);
    expect(immediate.commitFromHuman({ isTrusted: true })).toEqual({
      ok: false,
      reason: "no_pending",
    });
    expect(immediate.discardFromHuman({ isTrusted: true })).toEqual({
      ok: false,
      reason: "no_pending",
    });
    expect(
      immediate
        .listTools()
        .filter(({ annotations }) => !annotations.readOnlyHint)
        .every(({ description }) => !/\bstage(?:d)?\b/i.test(description)),
    ).toBe(true);
  });

  it("composes immediate create then connect through returned live IDs", async () => {
    const fixture = mutableApi();
    const controller = createRetrofitController(fixture.api as never, {
      writeMode: "immediate",
    });
    const created = (await invoke(controller, "create_shapes", {
      shapes: [
        { clientId: "source", type: "rectangle", label: "Source" },
        {
          clientId: "target",
          type: "ellipse",
          label: "Target",
          x: 400,
          y: 200,
        },
      ],
    })) as {
      ok: true;
      status: string;
      idMap: Record<string, string>;
    };

    const connected = await invoke(controller, "connect_shapes", {
      sourceIds: [created.idMap.source],
      targetId: created.idMap.target,
    });

    expect(created.status).toBe("applied");
    expect(connected).toMatchObject({
      ok: true,
      status: "applied",
      connectorCount: 1,
    });
    expect(fixture.updateScene).toHaveBeenCalledTimes(2);
    expect(
      fixture.updateScene.mock.calls.every(
        ([update]) => update.captureUpdate === CaptureUpdateAction.IMMEDIATELY,
      ),
    ).toBe(true);
    expect(controller.getSnapshot().pending).toBeNull();
    const arrow = fixture
      .getElements()
      .find((candidate) => candidate.type === "arrow");
    expect(arrow?.startBinding?.elementId).toBe(created.idMap.source);
    expect(arrow?.endBinding?.elementId).toBe(created.idMap.target);
    expect(
      fixture
        .getElements()
        .find(({ id }) => id === created.idMap.source)
        ?.boundElements?.some(({ id }) => id === arrow?.id),
    ).toBe(true);
    expect(
      fixture
        .getElements()
        .find(({ id }) => id === created.idMap.target)
        ?.boundElements?.some(({ id }) => id === arrow?.id),
    ).toBe(true);
  });

  it("fails closed on abort, stale bases, locks, and late ID collision", async () => {
    const abortedFixture = mutableApi([element("a"), element("b", 200)]);
    const aborted = createRetrofitController(abortedFixture.api as never, {
      writeMode: "immediate",
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      invoke(
        aborted,
        "align_shapes",
        { ids: ["a", "b"], edge: "top", to: "first" },
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedFixture.updateScene).not.toHaveBeenCalled();

    const lockedFixture = mutableApi([
      element("a", 0, 0, { locked: true }),
      element("b", 200),
    ]);
    const locked = createRetrofitController(lockedFixture.api as never, {
      writeMode: "immediate",
    });
    await expect(
      invoke(locked, "align_shapes", {
        ids: ["a", "b"],
        edge: "top",
        to: "first",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unsafe_retry" });
    expect(lockedFixture.updateScene).not.toHaveBeenCalled();

    let reads = 0;
    const staleV1 = [element("a"), element("b", 200)];
    const staleV2 = [element("a", 0, 0, { version: 2 }), element("b", 200)];
    const staleUpdate = vi.fn();
    const stale = createRetrofitController(
      {
        getSceneElements: () => (++reads >= 3 ? staleV2 : staleV1),
        getAppState: () => appState,
        updateScene: staleUpdate,
      } as never,
      { writeMode: "immediate" },
    );
    await expect(
      invoke(stale, "align_shapes", {
        ids: ["a", "b"],
        edge: "top",
        to: "first",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unsafe_retry" });
    expect(staleUpdate).not.toHaveBeenCalled();
    expect(stale.getSnapshot().pending).toBeNull();

    const random = vi
      .spyOn(ExcalidrawCommon, "randomId")
      .mockReturnValue("late-collision");
    try {
      let collisionReads = 0;
      const collisionUpdate = vi.fn();
      const collision = createRetrofitController(
        {
          getSceneElements: () =>
            ++collisionReads >= 3 ? [element("late-collision")] : [],
          getAppState: () => appState,
          updateScene: collisionUpdate,
        } as never,
        { writeMode: "immediate" },
      );
      await expect(
        invoke(collision, "create_shapes", {
          shapes: [{ type: "rectangle" }],
        }),
      ).resolves.toMatchObject({ ok: false, reason: "unsafe_retry" });
      expect(collisionUpdate).not.toHaveBeenCalled();
      expect(collision.getSnapshot().pending).toBeNull();
    } finally {
      random.mockRestore();
    }
  });

  it("mounts the page controller in immediate mode through its own document", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const mountedDocument = iframe.contentDocument!;
    const registerTool = vi.fn(
      async (
        _definition: { description: string },
        _options: { signal: AbortSignal },
      ) => {},
    );
    Object.defineProperty(mountedDocument, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    const fixture = mutableApi();

    const view = render(<RetrofitPanel api={fixture.api as never} />, {
      container: mountedDocument.body,
    });
    try {
      await waitFor(() => expect(registerTool).toHaveBeenCalledTimes(6));
      expect(view.queryByText("UNCOMMITTED")).toBeNull();
      expect(view.queryByRole("button", { name: "Commit layout" })).toBeNull();
      expect(view.queryByRole("button", { name: "Discard" })).toBeNull();
      expect(
        view.getByText(
          "Agent writes land directly and stay undoable. Drag, edit, delete or Undo anytime.",
        ),
      ).toBeTruthy();
      expect(
        view.container.querySelector("[data-ghost-overlay='true']"),
      ).toBeNull();
      expect(
        registerTool.mock.calls
          .map(([definition]) => definition.description as string)
          .filter((_, index) => index > 0)
          .every((description) => !/\bstage(?:d)?\b/i.test(description)),
      ).toBe(true);
    } finally {
      act(() => view.unmount());
      iframe.remove();
    }
  });
});
