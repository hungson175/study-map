import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { describe, expect, it, vi } from "vitest";

import { createCanvasToolController } from "../product/canvas_tools";

const rectangle = {
  id: "node-a",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 60,
  isDeleted: false,
  version: 1,
  versionNonce: 2,
};

const deleted = { ...rectangle, id: "deleted", isDeleted: true };
const collapsed = {
  ...rectangle,
  id: "collapsed-child",
  isDeleted: true,
  customData: { studyMapHiddenBy: "node-a" },
};

const makeHarness = () => {
  let metadata: { id?: string; name: string } = {
    id: "canvas-current",
    name: "Current canvas",
  };
  const api = {
    getSceneElements: vi.fn(() => [rectangle]),
    getSceneElementsIncludingDeleted: vi.fn(() => [
      rectangle,
      collapsed,
      deleted,
    ]),
    getFiles: vi.fn(() => ({ "file-1": { id: "file-1" } })),
    updateScene: vi.fn(),
    addFiles: vi.fn(),
  };
  const summaries = Array.from({ length: 6 }, (_, index) => ({
    id: `canvas-${index}`,
    name: `Canvas ${index}`,
    updatedAt: `2026-09-0${index + 1}T10:00:00.000Z`,
    elementCount: index,
  }));
  const store = {
    load: vi.fn(async (id: string) =>
      id === "canvas-target"
        ? {
            id,
            name: "Target canvas",
            updatedAt: "2026-09-02T10:00:00.000Z",
            elements: [{ ...rectangle, id: "target-node" }],
            files: { target: { id: "target" } },
          }
        : null,
    ),
    save: vi.fn(async ({ id, name }: { id?: string; name: string }) => ({
      id: id ?? "canvas-created",
      name,
      updatedAt: "2026-09-02T10:00:00.000Z",
      elementCount: 1,
    })),
    list: vi.fn(async () => summaries),
    rename: vi.fn(),
    delete: vi.fn(),
  };
  const setMetadata = vi.fn((next: { id?: string; name: string }) => {
    metadata = next;
  });
  const setStatus = vi.fn();
  const showWorkspace = vi.fn();
  const controller = createCanvasToolController({
    api: api as never,
    store,
    getMetadata: () => metadata,
    setMetadata,
    setStatus,
    showWorkspace,
  });
  const execute = (name: string, args: unknown = {}) =>
    controller.executeTool(name, args, {
      signal: new AbortController().signal,
    });

  return {
    api,
    controller,
    execute,
    setMetadata,
    setStatus,
    showWorkspace,
    store,
  };
};

describe("canvas lifecycle WebMCP tools", () => {
  it("publishes a small, strict, atomic tool surface", () => {
    const { controller } = makeHarness();

    expect(controller.listTools().map(({ name }) => name)).toEqual([
      "get_canvas_state",
      "list_saved_canvases",
      "save_canvas",
      "create_canvas",
      "open_saved_canvas",
    ]);
    expect(
      controller.listTools().map(({ annotations }) => annotations.readOnlyHint),
    ).toEqual([true, true, false, false, false]);
    expect(
      controller
        .listTools()
        .every(({ inputSchema }) => inputSchema.additionalProperties === false),
    ).toBe(true);
  });

  it("reads current state and paginates saved canvases without mutation", async () => {
    const { api, execute, store } = makeHarness();

    await expect(execute("get_canvas_state")).resolves.toEqual({
      ok: true,
      canvasId: "canvas-current",
      name: "Current canvas",
      elementCount: 1,
      saved: true,
    });
    await expect(
      execute("list_saved_canvases", { offset: 1, limit: 2 }),
    ).resolves.toEqual({
      ok: true,
      canvases: expect.arrayContaining([
        expect.objectContaining({ id: "canvas-1" }),
        expect.objectContaining({ id: "canvas-2" }),
      ]),
      count: 2,
      totalCount: 6,
      nextOffset: 3,
    });
    expect(store.list).toHaveBeenCalledOnce();
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("saves the live scene plus collapsed branches but excludes manual tombstones", async () => {
    const { execute, setMetadata, setStatus, store } = makeHarness();

    await expect(
      execute("save_canvas", { name: "Architecture v2" }),
    ).resolves.toEqual({
      ok: true,
      canvasId: "canvas-current",
      name: "Architecture v2",
      elementCount: 1,
      storage: "local",
    });
    expect(store.save).toHaveBeenCalledWith({
      id: "canvas-current",
      name: "Architecture v2",
      elements: [rectangle, collapsed],
      files: { "file-1": { id: "file-1" } },
    });
    expect(setMetadata).toHaveBeenCalledWith({
      id: "canvas-current",
      name: "Architecture v2",
    });
    expect(setStatus).toHaveBeenCalledWith("Saved Architecture v2 locally");
  });

  it("preserves the current canvas before creating an undoable blank canvas", async () => {
    const { api, execute, setMetadata, setStatus, showWorkspace, store } =
      makeHarness();

    await expect(
      execute("create_canvas", { name: "New architecture" }),
    ).resolves.toEqual({
      ok: true,
      name: "New architecture",
      elementCount: 0,
      previousCanvasId: "canvas-current",
      previousCanvasSaved: true,
    });
    expect(store.save).toHaveBeenCalledOnce();
    expect(api.updateScene).toHaveBeenCalledWith({
      elements: [expect.objectContaining({ id: "node-a", isDeleted: true })],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    expect(setMetadata).toHaveBeenLastCalledWith({
      id: undefined,
      name: "New architecture",
    });
    expect(showWorkspace).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith("New canvas ready");
  });

  it("preserves the current canvas before opening a saved canvas by id", async () => {
    const { api, execute, setMetadata, setStatus, showWorkspace, store } =
      makeHarness();

    await expect(
      execute("open_saved_canvas", { id: "canvas-target" }),
    ).resolves.toEqual({
      ok: true,
      canvasId: "canvas-target",
      name: "Target canvas",
      elementCount: 1,
      previousCanvasId: "canvas-current",
      previousCanvasSaved: true,
    });
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.load).toHaveBeenCalledWith("canvas-target");
    expect(api.addFiles).toHaveBeenCalledWith({ target: { id: "target" } });
    expect(api.updateScene).toHaveBeenCalledWith({
      elements: [{ ...rectangle, id: "target-node" }],
    });
    expect(setMetadata).toHaveBeenLastCalledWith({
      id: "canvas-target",
      name: "Target canvas",
    });
    expect(showWorkspace).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith("Opened Target canvas");
  });

  it("rejects invalid names, unknown ids, and aborted execution safely", async () => {
    const { api, controller, execute, store } = makeHarness();

    await expect(execute("create_canvas", { name: " " })).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: "invalid_args" }),
    );
    await expect(execute("save_canvas", { name: 42 })).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: "invalid_args" }),
    );
    await expect(
      execute("open_saved_canvas", { id: "missing" }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: "not_found" }),
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      controller.executeTool("get_canvas_state", {}, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.updateScene).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});
