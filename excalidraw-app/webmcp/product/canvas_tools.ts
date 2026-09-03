import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createToolRegistry } from "../tool_registry";

import type {
  PublicToolDescriptor,
  ToolDescriptor,
  ToolExecutionContext,
  ToolFailure,
} from "../tool_registry";

import type { DiagramStore, DiagramSummary } from "./diagram_store";

const MAX_NAME_LENGTH = 80;
const MAX_PAGE_SIZE = 5;
const MAX_SAVED_CANVASES = 50;
const SAFE_CANVAS_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

type CanvasMetadata = { id?: string; name: string };

type CanvasApi = Pick<
  ExcalidrawImperativeAPI,
  | "addFiles"
  | "getFiles"
  | "getSceneElements"
  | "getSceneElementsIncludingDeleted"
  | "updateScene"
>;

type CanvasToolDependencies = {
  api: CanvasApi;
  store: DiagramStore;
  getMetadata: () => CanvasMetadata;
  setMetadata: (metadata: CanvasMetadata) => void;
  setStatus: (status: string) => void;
  showWorkspace: () => void;
};

const failure = (
  reason: ToolFailure["reason"],
  message: string,
): ToolFailure => ({ ok: false, reason, message });

const isToolFailure = (
  value: DiagramSummary | ToolFailure,
): value is ToolFailure => "ok" in value && value.ok === false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCollapsedTombstone = (element: ExcalidrawElement) =>
  element.isDeleted &&
  isRecord(element.customData) &&
  typeof element.customData.studyMapHiddenBy === "string";

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
};

const parseName = (value: unknown, fallback: string): string | ToolFailure => {
  if (typeof value === "undefined") {
    return fallback;
  }
  if (typeof value !== "string") {
    return failure("invalid_args", "name must be a string");
  }
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return failure(
      "invalid_args",
      `name must contain 1 to ${MAX_NAME_LENGTH} characters`,
    );
  }
  return name;
};

const toolSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const toStorageFailure = (error: unknown) => {
  if (error instanceof DOMException && error.name === "AbortError") {
    throw error;
  }
  return failure(
    "unsafe_retry",
    error instanceof Error
      ? error.message
      : "Local canvas storage is unavailable; retry after checking this browser",
  );
};

export const createCanvasToolController = ({
  api,
  store,
  getMetadata,
  setMetadata,
  setStatus,
  showWorkspace,
}: CanvasToolDependencies) => {
  const visibleElements = () =>
    api
      .getSceneElements()
      .filter(({ isDeleted }) => !isDeleted) as readonly ExcalidrawElement[];
  const storableElements = () =>
    api
      .getSceneElementsIncludingDeleted()
      .filter(
        (element) => !element.isDeleted || isCollapsedTombstone(element),
      ) as readonly ExcalidrawElement[];

  const saveCurrent = async (
    requestedName: string | undefined,
    context: ToolExecutionContext,
  ): Promise<DiagramSummary | ToolFailure> => {
    checkAbort(context.signal);
    const metadata = getMetadata();
    const name = parseName(requestedName, metadata.name);
    if (typeof name !== "string") {
      return name;
    }
    try {
      const saved = await store.save({
        ...(metadata.id ? { id: metadata.id } : {}),
        name,
        elements: storableElements() as unknown as Record<string, unknown>[],
        files: api.getFiles() as unknown as Record<string, unknown>,
      });
      checkAbort(context.signal);
      setMetadata({ id: saved.id, name: saved.name });
      return saved;
    } catch (error) {
      return toStorageFailure(error);
    }
  };

  const preserveCurrent = async (
    context: ToolExecutionContext,
  ): Promise<ToolFailure | { ok: true; saved: DiagramSummary | null }> => {
    const metadata = getMetadata();
    if (!metadata.id && visibleElements().length === 0) {
      return { ok: true as const, saved: null };
    }
    const saved = await saveCurrent(undefined, context);
    if (isToolFailure(saved)) {
      return saved;
    }
    return { ok: true as const, saved };
  };

  const getCanvasState: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!isRecord(args) || !hasOnlyKeys(args, [])) {
      return failure("invalid_args", "get_canvas_state accepts no arguments");
    }
    const metadata = getMetadata();
    return {
      ok: true,
      canvasId: metadata.id ?? null,
      name: metadata.name,
      elementCount: visibleElements().length,
      saved: Boolean(metadata.id),
    };
  };

  const listSavedCanvases: ToolDescriptor["execute"] = async (
    args,
    context,
  ) => {
    checkAbort(context.signal);
    if (!isRecord(args) || !hasOnlyKeys(args, ["offset", "limit"])) {
      return failure(
        "invalid_args",
        "Use only offset and limit to list saved canvases",
      );
    }
    const offset = args.offset ?? 0;
    const limit = args.limit ?? MAX_PAGE_SIZE;
    if (
      !Number.isInteger(offset) ||
      typeof offset !== "number" ||
      offset < 0 ||
      offset >= MAX_SAVED_CANVASES ||
      !Number.isInteger(limit) ||
      typeof limit !== "number" ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE
    ) {
      return failure(
        "invalid_args",
        `offset must be 0 to ${
          MAX_SAVED_CANVASES - 1
        }; limit must be 1 to ${MAX_PAGE_SIZE}`,
      );
    }
    try {
      const all = await store.list();
      checkAbort(context.signal);
      const canvases = all.slice(offset, offset + limit);
      const nextOffset = offset + canvases.length;
      return {
        ok: true,
        canvases,
        count: canvases.length,
        totalCount: all.length,
        ...(nextOffset < all.length ? { nextOffset } : {}),
      };
    } catch (error) {
      return toStorageFailure(error);
    }
  };

  const saveCanvas: ToolDescriptor["execute"] = async (args, context) => {
    if (!isRecord(args) || !hasOnlyKeys(args, ["name"])) {
      return failure("invalid_args", "Use only name to save the canvas");
    }
    const saved = await saveCurrent(args.name as string | undefined, context);
    if (isToolFailure(saved)) {
      return saved;
    }
    setStatus(`Saved ${saved.name} locally`);
    return {
      ok: true,
      canvasId: saved.id,
      name: saved.name,
      elementCount: saved.elementCount,
      storage: "local",
    };
  };

  const createCanvas: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!isRecord(args) || !hasOnlyKeys(args, ["name"])) {
      return failure("invalid_args", "Use only name to create a canvas");
    }
    const name = parseName(args.name, "Untitled diagram");
    if (typeof name !== "string") {
      return name;
    }
    const preserved = await preserveCurrent(context);
    if (!preserved.ok) {
      return preserved;
    }
    checkAbort(context.signal);
    const elements = visibleElements().map((element) =>
      newElementWith(element, { isDeleted: true }),
    );
    api.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setMetadata({ id: undefined, name });
    showWorkspace();
    setStatus("New canvas ready");
    return {
      ok: true,
      name,
      elementCount: 0,
      previousCanvasId: preserved.saved?.id ?? null,
      previousCanvasSaved: Boolean(preserved.saved),
    };
  };

  const openSavedCanvas: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (
      !isRecord(args) ||
      !hasOnlyKeys(args, ["id"]) ||
      typeof args.id !== "string" ||
      !SAFE_CANVAS_ID_RE.test(args.id)
    ) {
      return failure(
        "invalid_args",
        "id must be a saved canvas id from list_saved_canvases",
      );
    }
    try {
      const record = await store.load(args.id);
      checkAbort(context.signal);
      if (!record) {
        return failure(
          "not_found",
          "That saved canvas no longer exists; call list_saved_canvases again",
        );
      }
      const preserved = await preserveCurrent(context);
      if (!preserved.ok) {
        return preserved;
      }
      checkAbort(context.signal);
      if (getMetadata().id === record.id) {
        const current = preserved.saved ?? record;
        setStatus(`${current.name} is already open`);
        return {
          ok: true,
          canvasId: current.id,
          name: current.name,
          elementCount: visibleElements().length,
          previousCanvasId: current.id,
          previousCanvasSaved: Boolean(preserved.saved),
          alreadyOpen: true,
        };
      }
      api.addFiles(record.files as never);
      api.updateScene({ elements: record.elements as never });
      setMetadata({ id: record.id, name: record.name });
      showWorkspace();
      setStatus(`Opened ${record.name}`);
      return {
        ok: true,
        canvasId: record.id,
        name: record.name,
        elementCount: record.elements.filter(({ isDeleted }) => !isDeleted)
          .length,
        previousCanvasId: preserved.saved?.id ?? null,
        previousCanvasSaved: Boolean(preserved.saved),
      };
    } catch (error) {
      return toStorageFailure(error);
    }
  };

  const descriptors: ToolDescriptor[] = [
    {
      name: "get_canvas_state",
      description:
        "Read the current canvas name, local save id, and visible element count without changing it.",
      inputSchema: toolSchema({}),
      annotations: { readOnlyHint: true },
      execute: getCanvasState,
    },
    {
      name: "list_saved_canvases",
      description:
        "List locally saved canvases in newest-first pages of up to five.",
      inputSchema: toolSchema({
        offset: { type: "integer", minimum: 0, maximum: 49 },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
      }),
      annotations: { readOnlyHint: true },
      execute: listSavedCanvases,
    },
    {
      name: "save_canvas",
      description:
        "Save or update the current canvas in this browser's local storage, optionally under a new name.",
      inputSchema: toolSchema({
        name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH },
      }),
      annotations: { readOnlyHint: false },
      execute: saveCanvas,
    },
    {
      name: "create_canvas",
      description:
        "Create an undoable blank canvas and preserve the current canvas locally first when it contains work.",
      inputSchema: toolSchema({
        name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH },
      }),
      annotations: { readOnlyHint: false },
      execute: createCanvas,
    },
    {
      name: "open_saved_canvas",
      description:
        "Open one locally saved canvas by id, preserving the current canvas locally before switching.",
      inputSchema: toolSchema(
        {
          id: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            pattern: SAFE_CANVAS_ID_RE.source,
          },
        },
        ["id"],
      ),
      annotations: { readOnlyHint: false },
      execute: openSavedCanvas,
    },
  ];
  const registry = createToolRegistry(descriptors);

  return {
    listTools: (): PublicToolDescriptor[] => registry.listTools(),
    executeTool: (name: string, args: unknown, context: ToolExecutionContext) =>
      registry.execute(name, args, context),
    dispose: registry.dispose,
  };
};

export type CanvasToolController = ReturnType<
  typeof createCanvasToolController
>;
