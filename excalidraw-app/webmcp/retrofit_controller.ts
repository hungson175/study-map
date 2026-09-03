import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { randomId } from "@excalidraw/common";
import {
  intersectElementWithLineSegment,
  newElementWith,
} from "@excalidraw/element";
import { lineSegment, pointFrom } from "@excalidraw/math";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawElement,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { GlobalPoint } from "@excalidraw/math";

import {
  buildCreateSkeletons,
  CREATE_SHAPE_TYPES,
  MAX_CREATE_LABEL,
  MAX_CREATE_SHAPES,
  parseCreateShapesArgs,
} from "./create_shapes";
import { computeEvenGaps } from "./distribute_shapes";
import { createToolRegistry } from "./tool_registry";

import type { DistributeAxis, DistributeGeometry } from "./distribute_shapes";

import type {
  PublicToolDescriptor,
  ToolDescriptor,
  ToolExecutionContext,
  ToolFailure,
  ToolResult,
} from "./tool_registry";

const MAX_ELEMENTS = 240;
const MAX_RETURNED_IDS = 40;
const MAX_CONNECTOR_SOURCES = 40;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHAPE_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "text",
  "freedraw",
]);
const ALIGN_EDGES = new Set([
  "left",
  "centerX",
  "right",
  "top",
  "centerY",
  "bottom",
]);
const ALIGN_TARGETS = new Set(["selection", "canvas", "first"]);
const DIMENSIONS = new Set(["width", "height"]);
const SIZE_MODES = new Set(["max", "min", "first", "average"]);
const DISTRIBUTE_AXES = new Set<DistributeAxis>(["horizontal", "vertical"]);
const BINDABLE_TYPES = new Set(["rectangle", "diamond", "ellipse"]);

const connectorBoundaryPoint = (
  element: ExcalidrawElement,
  direction: readonly [number, number],
  elementsMap: ElementsMap,
): GlobalPoint | null => {
  const center = pointFrom<GlobalPoint>(
    element.x + element.width / 2,
    element.y + element.height / 2,
  );
  const directionLength = Math.hypot(direction[0], direction[1]);
  const unitX = directionLength > 1e-6 ? direction[0] / directionLength : 1;
  const unitY = directionLength > 1e-6 ? direction[1] / directionLength : 0;
  const rayLength = Math.hypot(element.width, element.height) + 1;
  const rayEnd = pointFrom<GlobalPoint>(
    center[0] + unitX * rayLength,
    center[1] + unitY * rayLength,
  );
  const intersections = intersectElementWithLineSegment(
    element,
    elementsMap,
    lineSegment(center, rayEnd),
  );

  return (
    intersections.sort(
      (first, second) =>
        Math.hypot(first[0] - center[0], first[1] - center[1]) -
        Math.hypot(second[0] - center[0], second[1] - center[1]),
    )[0] ?? null
  );
};

type SceneApi = Pick<
  ExcalidrawImperativeAPI,
  | "getSceneElements"
  | "getSceneElementsIncludingDeleted"
  | "getAppState"
  | "updateScene"
>;

type Geometry = Pick<
  ExcalidrawElement,
  "id" | "type" | "x" | "y" | "width" | "height" | "angle"
>;

type PendingLayout = {
  baseVersions: Record<string, { version: number; versionNonce: number }>;
  elements: ExcalidrawElement[];
  operations: string[];
};

type LedgerEntry = {
  sequence: number;
  tool: string;
  changedIds: string[];
  outcome:
    | "uncommitted"
    | "applied"
    | "committed"
    | "discarded"
    | "unsafe_retry";
};

export type RetrofitSnapshot = {
  selectedIds: string[];
  pending: PendingLayout | null;
  ledger: LedgerEntry[];
};

type Listener = (snapshot: RetrofitSnapshot) => void;
type HumanGesture = { isTrusted: boolean };

const failure = (
  reason: ToolFailure["reason"],
  message: string,
): ToolFailure => ({ ok: false, reason, message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const parseIds = (value: unknown): string[] | ToolFailure | undefined => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_ELEMENTS) {
    return failure(
      "invalid_args",
      `ids must contain at most ${MAX_ELEMENTS} items`,
    );
  }
  const ids = Array.from(new Set(value));
  if (
    ids.some(
      (id) =>
        typeof id !== "string" ||
        !SAFE_ID_RE.test(id) ||
        id === "__proto__" ||
        id === "constructor" ||
        id === "prototype",
    )
  ) {
    return failure("invalid_args", "ids contain an invalid element id");
  }
  return ids as string[];
};

const isSafeId = (value: unknown): value is string =>
  typeof value === "string" &&
  SAFE_ID_RE.test(value) &&
  value !== "__proto__" &&
  value !== "constructor" &&
  value !== "prototype";

const parseConnectorIds = (value: unknown): string[] | ToolFailure => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CONNECTOR_SOURCES
  ) {
    return failure(
      "invalid_args",
      `sourceIds must contain 1 to ${MAX_CONNECTOR_SOURCES} unique ids`,
    );
  }
  if (!value.every(isSafeId)) {
    return failure("invalid_args", "sourceIds contain an invalid element id");
  }
  if (new Set(value).size !== value.length) {
    return failure("invalid_args", "sourceIds must not contain duplicates");
  }
  return value as string[];
};

const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
};

const summarizeIds = (ids: string[]) => ({
  changedIds: ids.slice(0, MAX_RETURNED_IDS),
  changedCount: ids.length,
  truncated: ids.length > MAX_RETURNED_IDS,
});

const cloneSnapshot = (snapshot: RetrofitSnapshot): RetrofitSnapshot =>
  structuredClone(snapshot);

const toolSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export type WriteMode = "staged" | "immediate";

export const createRetrofitController = (
  api: SceneApi,
  options?: { writeMode?: WriteMode },
) => {
  const writeMode = options?.writeMode ?? "staged";
  let snapshot: RetrofitSnapshot = {
    selectedIds: [],
    pending: null,
    ledger: [],
  };
  let sequence = 0;
  const listeners = new Set<Listener>();

  const emit = () => {
    const next = cloneSnapshot(snapshot);
    listeners.forEach((listener) => listener(next));
  };

  const liveElements = () =>
    api
      .getSceneElements()
      .filter((element) => !element.isDeleted) as readonly ExcalidrawElement[];
  const allElements = () =>
    typeof api.getSceneElementsIncludingDeleted === "function"
      ? api.getSceneElementsIncludingDeleted()
      : api.getSceneElements();

  const workingMap = () => {
    const map = new Map(liveElements().map((element) => [element.id, element]));
    snapshot.pending?.elements.forEach((element) =>
      map.set(element.id, element as ExcalidrawElement),
    );
    return map;
  };

  const resolveTargets = (
    idsValue: unknown,
  ): ExcalidrawElement[] | ToolFailure => {
    const parsed = parseIds(idsValue);
    if (parsed && !Array.isArray(parsed)) {
      return parsed;
    }
    const requested =
      parsed ??
      (snapshot.selectedIds.length
        ? snapshot.selectedIds
        : Object.entries(api.getAppState().selectedElementIds)
            .filter(([, selected]) => selected)
            .map(([id]) => id));
    if (!requested.length) {
      return failure("no_selection", "Select at least two unlocked shapes");
    }
    if (requested.length > MAX_ELEMENTS) {
      return failure(
        "invalid_args",
        `A call may address at most ${MAX_ELEMENTS} shapes`,
      );
    }

    const map = workingMap();
    const targets: ExcalidrawElement[] = [];
    for (const id of requested) {
      const target = map.get(id);
      if (!target) {
        return failure(
          "not_found",
          "One or more requested shapes no longer exist",
        );
      }
      if (target.locked || target.isDeleted) {
        return failure(
          "unsafe_retry",
          "A requested shape is locked or deleted",
        );
      }
      targets.push(target);
    }
    return targets;
  };

  const stage = (
    tool: string,
    stagedElements: ExcalidrawElement[],
    context: ToolExecutionContext,
    options?: { baseIds?: string[]; reportedIds?: string[] },
  ): ToolResult => {
    checkAbort(context.signal);
    const currentById = new Map(
      liveElements().map((element) => [element.id, element]),
    );
    const previous = snapshot.pending;
    const baseVersions = previous ? { ...previous.baseVersions } : {};
    const pendingById = new Map(
      previous?.elements.map((item) => [item.id, item]),
    );
    const baseIds = options?.baseIds ?? stagedElements.map(({ id }) => id);

    for (const id of baseIds) {
      const live = currentById.get(id);
      if (!live) {
        const pendingAddition = pendingById.get(id);
        if (pendingAddition && !baseVersions[id]) {
          continue;
        }
        return failure(
          "unsafe_retry",
          "A target changed before preview could be staged",
        );
      }
      if (live.locked || live.isDeleted) {
        return failure(
          "unsafe_retry",
          "A target became locked or deleted before preview could be staged",
        );
      }
      baseVersions[id] ??= {
        version: live.version,
        versionNonce: live.versionNonce,
      };
    }
    for (const element of stagedElements) {
      const isExistingPendingAddition =
        previous?.elements.some(({ id }) => id === element.id) &&
        !baseVersions[element.id];
      if (
        currentById.has(element.id) &&
        !baseVersions[element.id] &&
        !isExistingPendingAddition
      ) {
        return failure(
          "unsafe_retry",
          "A staged element id collided with the live drawing",
        );
      }
      pendingById.set(element.id, element);
    }
    checkAbort(context.signal);
    const reportedIds =
      options?.reportedIds ?? stagedElements.map(({ id }) => id);

    if (writeMode === "immediate") {
      const current = liveElements();
      const allCurrent = allElements();
      const latestById = new Map(
        current.map((element) => [element.id, element]),
      );
      for (const [id, base] of Object.entries(baseVersions)) {
        const live = latestById.get(id);
        if (
          !live ||
          live.locked ||
          live.isDeleted ||
          live.version !== base.version ||
          live.versionNonce !== base.versionNonce
        ) {
          return failure(
            "unsafe_retry",
            "A target changed before it could be applied",
          );
        }
      }

      const projected = Array.from(pendingById.values());
      const additions = projected.filter(({ id }) => !baseVersions[id]);
      const allIds = new Set(allCurrent.map(({ id }) => id));
      if (additions.some(({ id }) => allIds.has(id))) {
        return failure(
          "unsafe_retry",
          "A generated element id collided with the live drawing",
        );
      }

      checkAbort(context.signal);
      const projectedById = new Map(
        projected.map((element) => [element.id, element]),
      );
      api.updateScene({
        elements: [
          ...allCurrent.map(
            (element) => projectedById.get(element.id) ?? element,
          ),
          ...additions,
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      snapshot = {
        ...snapshot,
        pending: null,
        ledger: [
          ...snapshot.ledger,
          {
            sequence: ++sequence,
            tool,
            changedIds: reportedIds.slice(0, MAX_RETURNED_IDS),
            outcome: "applied",
          },
        ],
      };
      emit();
      return {
        ok: true,
        status: "applied",
        ...summarizeIds(reportedIds),
      };
    }

    snapshot = {
      ...snapshot,
      pending: {
        baseVersions,
        elements: Array.from(pendingById.values()),
        operations: [...(previous?.operations ?? []), tool],
      },
      ledger: [
        ...snapshot.ledger,
        {
          sequence: ++sequence,
          tool,
          changedIds: reportedIds.slice(0, MAX_RETURNED_IDS),
          outcome: "uncommitted",
        },
      ],
    };
    emit();
    return {
      ok: true,
      status: "uncommitted",
      ...summarizeIds(reportedIds),
    };
  };

  const selectShapes: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (
      !isRecord(args) ||
      !hasOnlyKeys(args, ["ids", "type", "labelContains"])
    ) {
      return failure("invalid_args", "Use only ids, type, or labelContains");
    }
    const parsedIds = parseIds(args.ids);
    if (parsedIds && !Array.isArray(parsedIds)) {
      return parsedIds;
    }
    if (
      typeof args.type !== "undefined" &&
      (typeof args.type !== "string" || !SHAPE_TYPES.has(args.type))
    ) {
      return failure("invalid_args", "type is not supported");
    }
    if (
      typeof args.labelContains !== "undefined" &&
      (typeof args.labelContains !== "string" ||
        args.labelContains.length === 0 ||
        args.labelContains.length > 50)
    ) {
      return failure(
        "invalid_args",
        "labelContains must contain 1 to 50 characters",
      );
    }
    if (!parsedIds && !args.type && !args.labelContains) {
      return failure("invalid_args", "Provide ids, type, or labelContains");
    }

    const all = liveElements();
    const requested = parsedIds ? new Set(parsedIds) : null;
    const needle =
      typeof args.labelContains === "string"
        ? args.labelContains.toLocaleLowerCase()
        : null;
    const labels = new Map<string, string>();
    all.forEach((item) => {
      if (item.type === "text" && item.containerId && "text" in item) {
        labels.set(item.containerId, item.text.toLocaleLowerCase());
      }
    });
    const selected = all.filter((item) => {
      if (item.locked) {
        return false;
      }
      if (requested && !requested.has(item.id)) {
        return false;
      }
      if (args.type && item.type !== args.type) {
        return false;
      }
      if (needle) {
        const ownText = item.type === "text" && "text" in item ? item.text : "";
        if (
          !`${ownText} ${labels.get(item.id) ?? ""}`
            .toLocaleLowerCase()
            .includes(needle)
        ) {
          return false;
        }
      }
      return true;
    });
    if (!selected.length) {
      return failure("no_selection", "No unlocked shape matched the criteria");
    }
    if (requested && selected.length !== requested.size) {
      return failure(
        "not_found",
        "One or more requested shapes were not selectable",
      );
    }
    checkAbort(context.signal);
    snapshot = { ...snapshot, selectedIds: selected.map(({ id }) => id) };
    emit();
    return {
      ok: true,
      selectedCount: selected.length,
      selectedIds: selected.map(({ id }) => id).slice(0, MAX_RETURNED_IDS),
      truncated: selected.length > MAX_RETURNED_IDS,
    };
  };

  const alignShapes: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!isRecord(args) || !hasOnlyKeys(args, ["ids", "edge", "to"])) {
      return failure("invalid_args", "Use only ids, edge, or to");
    }
    if (typeof args.edge !== "string" || !ALIGN_EDGES.has(args.edge)) {
      return failure("invalid_args", "edge is not supported");
    }
    const to = args.to ?? "selection";
    if (typeof to !== "string" || !ALIGN_TARGETS.has(to)) {
      return failure("invalid_args", "to is not supported");
    }
    const targets = resolveTargets(args.ids);
    if (!Array.isArray(targets)) {
      return targets;
    }
    if (targets.length < 2 && to === "selection") {
      return failure(
        "unsafe_retry",
        "Selection alignment needs at least two shapes",
      );
    }

    const minX = Math.min(...targets.map(({ x }) => x));
    const maxX = Math.max(...targets.map(({ x, width }) => x + width));
    const minY = Math.min(...targets.map(({ y }) => y));
    const maxY = Math.max(...targets.map(({ y, height }) => y + height));
    const first = targets[0];
    const appState = api.getAppState();
    const zoom = appState.zoom.value || 1;
    const anchors =
      to === "first"
        ? {
            left: first.x,
            centerX: first.x + first.width / 2,
            right: first.x + first.width,
            top: first.y,
            centerY: first.y + first.height / 2,
            bottom: first.y + first.height,
          }
        : to === "canvas"
        ? {
            left: -appState.scrollX,
            centerX: -appState.scrollX + appState.width / zoom / 2,
            right: -appState.scrollX + appState.width / zoom,
            top: -appState.scrollY,
            centerY: -appState.scrollY + appState.height / zoom / 2,
            bottom: -appState.scrollY + appState.height / zoom,
          }
        : {
            left: minX,
            centerX: (minX + maxX) / 2,
            right: maxX,
            top: minY,
            centerY: (minY + maxY) / 2,
            bottom: maxY,
          };
    const edge = args.edge as keyof typeof anchors;
    const geometries = targets.map((item): Geometry => {
      let { x, y } = item;
      if (edge === "left") {
        x = anchors.left;
      }
      if (edge === "centerX") {
        x = anchors.centerX - item.width / 2;
      }
      if (edge === "right") {
        x = anchors.right - item.width;
      }
      if (edge === "top") {
        y = anchors.top;
      }
      if (edge === "centerY") {
        y = anchors.centerY - item.height / 2;
      }
      if (edge === "bottom") {
        y = anchors.bottom - item.height;
      }
      return {
        id: item.id,
        type: item.type,
        x,
        y,
        width: item.width,
        height: item.height,
        angle: item.angle,
      };
    });
    return stage(
      "align_shapes",
      geometries.map((geometry) => {
        const target = targets.find(({ id }) => id === geometry.id)!;
        return newElementWith(target, {
          x: geometry.x,
          y: geometry.y,
          width: geometry.width,
          height: geometry.height,
        });
      }),
      context,
    );
  };

  const equalizeSize: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!isRecord(args) || !hasOnlyKeys(args, ["ids", "dimension", "mode"])) {
      return failure("invalid_args", "Use only ids, dimension, or mode");
    }
    if (typeof args.dimension !== "string" || !DIMENSIONS.has(args.dimension)) {
      return failure("invalid_args", "dimension is not supported");
    }
    const mode = args.mode ?? "max";
    if (typeof mode !== "string" || !SIZE_MODES.has(mode)) {
      return failure("invalid_args", "mode is not supported");
    }
    const targets = resolveTargets(args.ids);
    if (!Array.isArray(targets)) {
      return targets;
    }
    if (targets.length < 2) {
      return failure(
        "unsafe_retry",
        "Size equalization needs at least two shapes",
      );
    }
    const dimension = args.dimension as "width" | "height";
    const values = targets.map((item) => item[dimension]);
    const reference =
      mode === "min"
        ? Math.min(...values)
        : mode === "first"
        ? values[0]
        : mode === "average"
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : Math.max(...values);
    const geometries = targets.map(
      (item): Geometry => ({
        id: item.id,
        type: item.type,
        x: item.x,
        y: item.y,
        width: dimension === "width" ? reference : item.width,
        height: dimension === "height" ? reference : item.height,
        angle: item.angle,
      }),
    );
    return stage(
      "equalize_size",
      geometries.map((geometry) => {
        const target = targets.find(({ id }) => id === geometry.id)!;
        return newElementWith(target, {
          x: geometry.x,
          y: geometry.y,
          width: geometry.width,
          height: geometry.height,
        });
      }),
      context,
    );
  };

  const distributeShapes: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!isRecord(args) || !hasOnlyKeys(args, ["ids", "axis"])) {
      return failure("invalid_args", "Use only ids and axis");
    }
    if (
      typeof args.axis !== "string" ||
      !DISTRIBUTE_AXES.has(args.axis as DistributeAxis)
    ) {
      return failure("invalid_args", "axis must be horizontal or vertical");
    }
    if (Array.isArray(args.ids) && new Set(args.ids).size !== args.ids.length) {
      return failure("invalid_args", "ids must not contain duplicates");
    }

    const targets = resolveTargets(args.ids);
    if (!Array.isArray(targets)) {
      return targets;
    }
    if (targets.length < 3) {
      return failure(
        "unsafe_retry",
        "Distribution needs at least three shapes",
      );
    }

    const axis = args.axis as DistributeAxis;
    const position = axis === "horizontal" ? "x" : "y";
    const geometries = targets
      .map(
        (target): DistributeGeometry => ({
          id: target.id,
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
        }),
      )
      .sort(
        (left, right) =>
          left[position] - right[position] || left.id.localeCompare(right.id),
      );
    const distribution = computeEvenGaps(geometries, axis);
    if ("reason" in distribution) {
      return failure("unsafe_retry", distribution.message);
    }

    const byId = new Map(targets.map((target) => [target.id, target]));
    const changed = distribution.positioned.filter((geometry) => {
      const target = byId.get(geometry.id)!;
      return Math.abs(geometry[position] - target[position]) > 1e-6;
    });
    if (!changed.length) {
      return failure("unsafe_retry", "Gaps are already even");
    }
    checkAbort(context.signal);
    return stage(
      "distribute_shapes",
      changed.map((geometry) => {
        const target = byId.get(geometry.id)!;
        return newElementWith(target, {
          x: geometry.x,
          y: geometry.y,
        });
      }),
      context,
      {
        baseIds: targets.map(({ id }) => id),
        reportedIds: changed.map(({ id }) => id),
      },
    );
  };

  const connectShapes: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!isRecord(args) || !hasOnlyKeys(args, ["sourceIds", "targetId"])) {
      return failure("invalid_args", "Use only sourceIds and targetId");
    }
    const sourceIds = parseConnectorIds(args.sourceIds);
    if (!Array.isArray(sourceIds)) {
      return sourceIds;
    }
    if (!isSafeId(args.targetId)) {
      return failure("invalid_args", "targetId is not a valid element id");
    }
    const targetId = args.targetId;
    if (sourceIds.includes(targetId)) {
      return failure("invalid_args", "A shape cannot connect to itself");
    }

    const map = workingMap();
    const sourceElements: ExcalidrawElement[] = [];
    for (const id of sourceIds) {
      const source = map.get(id);
      if (!source) {
        return failure("not_found", "One or more source shapes do not exist");
      }
      if (source.locked || source.isDeleted) {
        return failure("unsafe_retry", "A source shape is locked or deleted");
      }
      if (!BINDABLE_TYPES.has(source.type)) {
        return failure(
          "unsafe_retry",
          "Only rectangle, diamond, or ellipse sources can be connected",
        );
      }
      sourceElements.push(source);
    }
    const target = map.get(targetId);
    if (!target) {
      return failure("not_found", "The target shape does not exist");
    }
    if (target.locked || target.isDeleted) {
      return failure("unsafe_retry", "The target shape is locked or deleted");
    }
    if (!BINDABLE_TYPES.has(target.type)) {
      return failure(
        "unsafe_retry",
        "Only a rectangle, diamond, or ellipse can be the target",
      );
    }

    const existingPairs = new Set(
      Array.from(map.values())
        .filter(
          (element): element is ExcalidrawArrowElement =>
            element.type === "arrow" &&
            Boolean(element.startBinding) &&
            Boolean(element.endBinding),
        )
        .map(
          (arrow) =>
            `${arrow.startBinding!.elementId}\u0000${
              arrow.endBinding!.elementId
            }`,
        ),
    );
    if (
      sourceIds.some((sourceId) =>
        existingPairs.has(`${sourceId}\u0000${targetId}`),
      )
    ) {
      return failure(
        "unsafe_retry",
        "One or more requested connectors already exist or are pending",
      );
    }

    const arrowIds = new Set<string>();
    const nextArrowId = () => {
      let id = randomId();
      while (map.has(id) || arrowIds.has(id)) {
        id = randomId();
      }
      arrowIds.add(id);
      return id;
    };
    const arrowSkeletons: ExcalidrawElementSkeleton[] = [];
    for (const source of sourceElements) {
      const sourceCenterX = source.x + source.width / 2;
      const sourceCenterY = source.y + source.height / 2;
      const targetCenterX = target.x + target.width / 2;
      const targetCenterY = target.y + target.height / 2;
      const deltaX = targetCenterX - sourceCenterX;
      const deltaY = targetCenterY - sourceCenterY;
      const direction: readonly [number, number] =
        Math.hypot(deltaX, deltaY) > 1e-6 ? [deltaX, deltaY] : [1, 0];
      const startPoint = connectorBoundaryPoint(source, direction, map);
      const endPoint = connectorBoundaryPoint(
        target,
        [-direction[0], -direction[1]],
        map,
      );
      if (!startPoint || !endPoint) {
        return failure(
          "unsafe_retry",
          "A connector boundary could not be calculated safely",
        );
      }
      arrowSkeletons.push({
        id: nextArrowId(),
        type: "arrow",
        x: startPoint[0],
        y: startPoint[1],
        width: endPoint[0] - startPoint[0],
        height: endPoint[1] - startPoint[1],
        strokeColor: "#e8a317",
        endArrowhead: "arrow",
        start: { id: source.id },
        end: { id: target.id },
      });
    }
    const involved = [...sourceElements, target];
    const skeletons: ExcalidrawElementSkeleton[] = [
      ...involved.map(
        (element) => structuredClone(element) as ExcalidrawElementSkeleton,
      ),
      ...arrowSkeletons,
    ];
    const converted = convertToExcalidrawElements(skeletons, {
      regenerateIds: false,
    });
    const convertedById = new Map(
      converted.map((element) => [element.id, element]),
    );
    const convertedArrows = arrowSkeletons.map(({ id }) =>
      id ? convertedById.get(id) : undefined,
    );
    if (
      convertedArrows.some(
        (element) =>
          !element ||
          element.type !== "arrow" ||
          !element.startBinding ||
          !element.endBinding,
      )
    ) {
      return failure(
        "unsafe_retry",
        "The public Excalidraw converter could not bind every connector",
      );
    }

    const arrows = convertedArrows as ExcalidrawArrowElement[];
    const convertedContainers = involved.map((element) =>
      convertedById.get(element.id),
    );
    const bindingsRoundTrip = arrows.every((arrow) => {
      const source = convertedById.get(arrow.startBinding!.elementId);
      const convertedTarget = convertedById.get(arrow.endBinding!.elementId);
      return (
        source?.boundElements?.some(({ id }) => id === arrow.id) &&
        convertedTarget?.boundElements?.some(({ id }) => id === arrow.id)
      );
    });
    if (convertedContainers.some((element) => !element) || !bindingsRoundTrip) {
      return failure(
        "unsafe_retry",
        "The public Excalidraw converter did not preserve mirrored bindings",
      );
    }

    const stagedContainers = involved.map((element) => {
      const convertedElement = convertedById.get(element.id)!;
      return newElementWith(element, {
        boundElements: convertedElement.boundElements,
      });
    });
    checkAbort(context.signal);
    const staged = stage(
      "connect_shapes",
      [...stagedContainers, ...arrows],
      context,
      {
        baseIds: involved.map(({ id }) => id),
        reportedIds: arrows.map(({ id }) => id),
      },
    );
    return staged.ok ? { ...staged, connectorCount: arrows.length } : staged;
  };

  const createShapes: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    const parsed = parseCreateShapesArgs(args);
    if (!parsed.ok) {
      return failure("invalid_args", parsed.message);
    }

    const existing = workingMap();
    const generated = new Set<string>();
    const nextId = () => {
      let id = randomId();
      while (existing.has(id) || generated.has(id)) {
        id = randomId();
      }
      generated.add(id);
      return id;
    };
    const { skeletons, createdIds, idMap } = buildCreateSkeletons(
      parsed.shapes,
      nextId,
    );
    const converted = convertToExcalidrawElements(skeletons, {
      regenerateIds: false,
    });
    const convertedIds = new Set<string>();
    if (
      existing.size + converted.length > MAX_ELEMENTS ||
      converted.some(
        ({ id }) =>
          existing.has(id) || convertedIds.has(id) || !convertedIds.add(id),
      )
    ) {
      return failure(
        "unsafe_retry",
        "The drawing is too large or generated ids collided; retry safely",
      );
    }
    checkAbort(context.signal);
    const staged = stage("create_shapes", converted, context, {
      baseIds: [],
      reportedIds: createdIds,
    });
    return staged.ok
      ? {
          ...staged,
          createdIds,
          ...(Object.keys(idMap).length ? { idMap } : {}),
          createdCount: createdIds.length,
        }
      : staged;
  };

  const descriptors: ToolDescriptor[] = [
    {
      name: "select_shapes",
      description:
        "Select up to 240 unlocked shapes by id, type, or visible label.",
      inputSchema: toolSchema({
        ids: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_ELEMENTS,
        },
        type: { type: "string", enum: Array.from(SHAPE_TYPES) },
        labelContains: { type: "string", maxLength: 50 },
      }),
      annotations: { readOnlyHint: true },
      execute: selectShapes,
    },
    {
      name: "align_shapes",
      description:
        writeMode === "immediate"
          ? "Apply an exact edge or center alignment directly to the drawing."
          : "Stage an exact edge or center alignment without changing the live drawing.",
      inputSchema: toolSchema(
        {
          ids: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_ELEMENTS,
          },
          edge: { type: "string", enum: Array.from(ALIGN_EDGES) },
          to: { type: "string", enum: Array.from(ALIGN_TARGETS) },
        },
        ["edge"],
      ),
      annotations: { readOnlyHint: false },
      execute: alignShapes,
    },
    {
      name: "equalize_size",
      description:
        writeMode === "immediate"
          ? "Apply equal widths or heights directly to the drawing."
          : "Stage equal widths or heights without changing the live drawing.",
      inputSchema: toolSchema(
        {
          ids: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_ELEMENTS,
          },
          dimension: { type: "string", enum: Array.from(DIMENSIONS) },
          mode: { type: "string", enum: Array.from(SIZE_MODES) },
        },
        ["dimension"],
      ),
      annotations: { readOnlyHint: false },
      execute: equalizeSize,
    },
    {
      name: "distribute_shapes",
      description:
        writeMode === "immediate"
          ? "Apply even gaps between shapes along one axis directly to the drawing."
          : "Stage even gaps between shapes along one axis without changing the live drawing.",
      inputSchema: toolSchema(
        {
          ids: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_ELEMENTS,
          },
          axis: { type: "string", enum: Array.from(DISTRIBUTE_AXES) },
        },
        ["axis"],
      ),
      annotations: { readOnlyHint: false },
      execute: distributeShapes,
    },
    {
      name: "connect_shapes",
      description:
        writeMode === "immediate"
          ? "Apply directed connectors from up to 40 explicit shapes to one target."
          : "Stage directed connectors from up to 40 explicit shapes to one target without changing the live drawing.",
      inputSchema: toolSchema(
        {
          sourceIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_CONNECTOR_SOURCES,
            uniqueItems: true,
          },
          targetId: { type: "string" },
        },
        ["sourceIds", "targetId"],
      ),
      annotations: { readOnlyHint: false },
      execute: connectShapes,
    },
    {
      name: "create_shapes",
      description:
        writeMode === "immediate"
          ? "Create labeled rectangle, ellipse, or diamond nodes directly on the drawing."
          : "Stage labeled rectangle, ellipse, or diamond nodes.",
      inputSchema: toolSchema(
        {
          shapes: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CREATE_SHAPES,
            items: {
              type: "object",
              properties: {
                clientId: { type: "string", pattern: SAFE_ID_RE.source },
                type: { type: "string", enum: CREATE_SHAPE_TYPES },
                label: { type: "string", maxLength: MAX_CREATE_LABEL },
                x: { type: "number", minimum: -10000, maximum: 10000 },
                y: { type: "number", minimum: -10000, maximum: 10000 },
                width: { type: "number", minimum: 40, maximum: 800 },
                height: { type: "number", minimum: 30, maximum: 600 },
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
        },
        ["shapes"],
      ),
      annotations: { readOnlyHint: false },
      execute: createShapes,
    },
  ];
  const registry = createToolRegistry(descriptors);

  const commitFromHuman = (gesture: HumanGesture) => {
    if (!gesture.isTrusted) {
      return { ok: false as const, reason: "human_gesture_required" as const };
    }
    if (!snapshot.pending) {
      return { ok: false as const, reason: "no_pending" as const };
    }

    const pending = snapshot.pending;
    const current = liveElements();
    const allCurrent = allElements();
    const currentById = new Map(
      current.map((element) => [element.id, element]),
    );
    const changedIds = pending.elements.map(({ id }) => id);
    for (const [id, base] of Object.entries(pending.baseVersions)) {
      const live = currentById.get(id);
      if (
        !live ||
        live.locked ||
        live.isDeleted ||
        live.version !== base.version ||
        live.versionNonce !== base.versionNonce
      ) {
        snapshot = {
          ...snapshot,
          ledger: [
            ...snapshot.ledger,
            {
              sequence: ++sequence,
              tool: "human_commit",
              changedIds,
              outcome: "unsafe_retry",
            },
          ],
        };
        emit();
        return { ok: false as const, reason: "unsafe_retry" as const };
      }
    }
    const pendingById = new Map(
      pending.elements.map((element) => [element.id, element]),
    );
    const additions = pending.elements.filter(
      ({ id }) => !pending.baseVersions[id],
    );
    const allIds = new Set(allCurrent.map(({ id }) => id));
    if (additions.some(({ id }) => allIds.has(id))) {
      snapshot = {
        ...snapshot,
        ledger: [
          ...snapshot.ledger,
          {
            sequence: ++sequence,
            tool: "human_commit",
            changedIds: changedIds.slice(0, MAX_RETURNED_IDS),
            outcome: "unsafe_retry",
          },
        ],
      };
      emit();
      return { ok: false as const, reason: "unsafe_retry" as const };
    }

    const elements = allCurrent.map((element) => {
      return pendingById.get(element.id) ?? element;
    });
    api.updateScene({
      elements: [...elements, ...additions],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    snapshot = {
      ...snapshot,
      pending: null,
      ledger: [
        ...snapshot.ledger,
        {
          sequence: ++sequence,
          tool: "human_commit",
          changedIds,
          outcome: "committed",
        },
      ],
    };
    emit();
    return {
      ok: true as const,
      appliedIds: changedIds.slice(0, MAX_RETURNED_IDS),
    };
  };

  const discardFromHuman = (gesture: HumanGesture) => {
    if (!gesture.isTrusted) {
      return { ok: false as const, reason: "human_gesture_required" as const };
    }
    if (!snapshot.pending) {
      return { ok: false as const, reason: "no_pending" as const };
    }
    const changedIds = snapshot.pending.elements.map(({ id }) => id);
    snapshot = {
      ...snapshot,
      pending: null,
      ledger: [
        ...snapshot.ledger,
        {
          sequence: ++sequence,
          tool: "human_discard",
          changedIds,
          outcome: "discarded",
        },
      ],
    };
    emit();
    return { ok: true as const, discardedIds: changedIds };
  };

  return {
    listTools: (): PublicToolDescriptor[] => registry.listTools(),
    executeTool: (name: string, args: unknown, context: ToolExecutionContext) =>
      registry.execute(name, args, context),
    getSnapshot: () => cloneSnapshot(snapshot),
    getWriteMode: (): WriteMode => writeMode,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commitFromHuman,
    discardFromHuman,
    dispose: registry.dispose,
  };
};

export type RetrofitController = ReturnType<typeof createRetrofitController>;
