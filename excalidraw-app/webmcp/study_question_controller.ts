import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import {
  BOUND_TEXT_PADDING,
  FONT_FAMILY,
  getFontString,
  getLineHeight,
  randomId,
} from "@excalidraw/common";
import { measureText, newElementWith, wrapText } from "@excalidraw/element";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { AGENT_TOOL_ONLY_RULE } from "./canvasChoiceSession";
import { createToolRegistry, MAX_RESULT_CHARACTERS } from "./tool_registry";

import type { CanvasChoiceSession } from "./canvasChoiceSession";
import type {
  PublicToolDescriptor,
  ToolDescriptor,
  ToolExecutionContext,
  ToolFailure,
  ToolFailureReason,
  ToolResult,
} from "./tool_registry";

type SceneApi = Pick<
  ExcalidrawImperativeAPI,
  | "getAppState"
  | "getSceneElements"
  | "getSceneElementsIncludingDeleted"
  | "updateScene"
>;

export type IdFactory = () => string;
export type HumanGesture = { isTrusted: boolean };
type StudyQuestionControllerOptions = {
  canvasChoiceSession?: CanvasChoiceSession;
  idFactory?: IdFactory;
};

const STUDY_NODE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NODES = 24;
const MAX_EDGES = 24;
const MAX_SELECTED = 12;
const MAX_QUESTIONS = 20;
const MAX_OPEN_PER_NODE = 8;
const MAX_LINE = 120;
const MAX_ANSWER_SUMMARY = 160;
const MAX_KEY_POINT = 72;
const MAX_KEY_POINTS = 5;
const MAX_SOURCE_TITLE = 64;
const MAX_SOURCES = 2;
const ANSWER_FONT_FAMILY = FONT_FAMILY.Assistant;
const ANSWER_FONT_SIZE = 16;
const ANSWER_LINE_HEIGHT = getLineHeight(ANSWER_FONT_FAMILY);
const ANSWER_FONT = getFontString({
  fontFamily: ANSWER_FONT_FAMILY,
  fontSize: ANSWER_FONT_SIZE,
});
const ANSWER_HORIZONTAL_PADDING = 12;
const SUMMARY_MIN_WIDTH = 240;
const SUMMARY_MAX_WIDTH = 380;
const SUMMARY_MIN_HEIGHT = 60;
const CHILD_MIN_WIDTH = 160;
const CHILD_MAX_WIDTH = 260;
const CHILD_MIN_HEIGHT = 48;
const CHILD_HORIZONTAL_GAP = 40;
const CHILD_VERTICAL_GAP = 32;
const PLACEMENT_STEP = 64;
const MAX_PLACEMENT_STEP = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const failure = (reason: ToolFailureReason, message: string): ToolFailure =>
  deepFreeze({ ok: false, reason, message });

const success = <T extends Record<string, unknown>>(value: T) =>
  deepFreeze({ ok: true as const, ...value });

const normalizeLine = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_LINE);

const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const emptyArgs = (args: unknown) =>
  isRecord(args) && Object.keys(args).length === 0;

const questionData = (element: ExcalidrawElement) => {
  const data = element.customData;
  if (
    !isRecord(data) ||
    data.kind !== "question" ||
    (data.status !== "open" && data.status !== "answered") ||
    typeof data.nodeId !== "string"
  ) {
    return null;
  }
  return {
    status: data.status as "open" | "answered",
    nodeId: data.nodeId,
  };
};

const isQuestionMarker = (element: ExcalidrawElement) =>
  element.type === "ellipse" && questionData(element) !== null;

const isStudyNode = (element: ExcalidrawElement) => {
  const kind = isRecord(element.customData)
    ? element.customData.kind
    : undefined;
  return (
    !element.isDeleted &&
    !element.locked &&
    STUDY_NODE_TYPES.has(element.type) &&
    kind !== "question"
  );
};

const collapsedData = (element: ExcalidrawElement) => {
  const data = element.customData;
  return isRecord(data)
    ? {
        collapsed: data.studyMapCollapsed === true,
        hiddenDirectBranchCount:
          typeof data.hiddenDirectBranchCount === "number"
            ? data.hiddenDirectBranchCount
            : 0,
        hiddenBy:
          typeof data.studyMapHiddenBy === "string"
            ? data.studyMapHiddenBy
            : null,
      }
    : { collapsed: false, hiddenDirectBranchCount: 0, hiddenBy: null };
};

const withCustomData = (
  element: ExcalidrawElement,
  patch: Record<string, unknown>,
) => ({
  ...(isRecord(element.customData) ? element.customData : {}),
  ...patch,
});

const withoutCustomDataKeys = (element: ExcalidrawElement, keys: string[]) => {
  const data = { ...(isRecord(element.customData) ? element.customData : {}) };
  keys.forEach((key) => delete data[key]);
  return data;
};

const textFor = (
  containerId: string,
  elements: readonly ExcalidrawElement[],
) => {
  const text = elements.find(
    (element): element is ExcalidrawTextElement =>
      element.type === "text" &&
      !element.isDeleted &&
      element.containerId === containerId,
  );
  return text ? normalizeLine(text.text) : "";
};

const questionTextFor = (
  marker: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
) => {
  const text = elements.find(
    (element): element is ExcalidrawTextElement =>
      element.type === "text" &&
      !element.isDeleted &&
      element.containerId === marker.id &&
      questionData(element)?.nodeId === questionData(marker)?.nodeId,
  );
  if (!text || !/^\?\s+\S/.test(text.text.trim())) {
    return null;
  }
  return {
    element: text,
    text: normalizeLine(text.text.trim().replace(/^\?\s+/, "")),
  };
};

const nextUniqueId = (
  ids: IdFactory,
  unavailable: Set<string>,
): string | null => {
  for (let attempt = 0; attempt < 128; attempt++) {
    const id = ids();
    if (SAFE_ID_RE.test(id) && !unavailable.has(id)) {
      unavailable.add(id);
      return id;
    }
  }
  return null;
};

const toolSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const shrinkArraysToFit = <T extends Record<string, unknown>>(
  value: T,
  arrays: string[],
) => {
  for (let guard = 0; guard < 256; guard++) {
    if (JSON.stringify({ ok: true, ...value }).length < MAX_RESULT_CHARACTERS) {
      return value;
    }
    const candidate = arrays
      .map((key) => [key, value[key]] as const)
      .filter((entry): entry is readonly [string, unknown[]] =>
        Array.isArray(entry[1]),
      )
      .find(([, items]) => items.length > 0);
    if (!candidate) {
      break;
    }
    candidate[1].pop();
    (value as Record<string, unknown>).truncated = true;
  }
  return value;
};

const boxesOverlap = (
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) =>
  left.x < right.x + right.width &&
  left.x + left.width > right.x &&
  left.y < right.y + right.height &&
  left.y + left.height > right.y;

type AnswerRole = "answer_summary" | "key_point" | "source";
type AnswerBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type AnswerTextLayout = {
  text: string;
  width: number;
  height: number;
  textWidth: number;
  textHeight: number;
};
type Segment = readonly [readonly [number, number], readonly [number, number]];

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const measureAnswerText = (
  role: AnswerRole,
  label: string,
): AnswerTextLayout => {
  const minimumWidth =
    role === "answer_summary" ? SUMMARY_MIN_WIDTH : CHILD_MIN_WIDTH;
  const maximumWidth =
    role === "answer_summary" ? SUMMARY_MAX_WIDTH : CHILD_MAX_WIDTH;
  const minimumHeight =
    role === "answer_summary" ? SUMMARY_MIN_HEIGHT : CHILD_MIN_HEIGHT;
  const unwrapped = measureText(label, ANSWER_FONT, ANSWER_LINE_HEIGHT);
  const width = Math.ceil(
    clamp(
      unwrapped.width + ANSWER_HORIZONTAL_PADDING * 2,
      minimumWidth,
      maximumWidth,
    ),
  );
  const text = wrapText(
    label,
    ANSWER_FONT,
    width - ANSWER_HORIZONTAL_PADDING * 2,
  );
  const measured = measureText(text, ANSWER_FONT, ANSWER_LINE_HEIGHT);
  return {
    text,
    width,
    height: Math.max(
      minimumHeight,
      Math.ceil(measured.height + BOUND_TEXT_PADDING * 2),
    ),
    textWidth: measured.width,
    textHeight: measured.height,
  };
};

const normalizedBox = (element: AnswerBox): AnswerBox => ({
  x: Math.min(element.x, element.x + element.width),
  y: Math.min(element.y, element.y + element.height),
  width: Math.abs(element.width),
  height: Math.abs(element.height),
});

const segmentIntersectsBoxInterior = (
  [start, end]: Segment,
  rawBox: AnswerBox,
) => {
  const box = normalizedBox(rawBox);
  const epsilon = 1e-6;
  const minX = box.x + epsilon;
  const maxX = box.x + box.width - epsilon;
  const minY = box.y + epsilon;
  const maxY = box.y + box.height - epsilon;
  if (minX >= maxX || minY >= maxY) {
    return false;
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let low = 0;
  let high = 1;
  for (const [p, q] of [
    [-dx, start[0] - minX],
    [dx, maxX - start[0]],
    [-dy, start[1] - minY],
    [dy, maxY - start[1]],
  ] as const) {
    if (Math.abs(p) <= epsilon) {
      if (q < 0) {
        return false;
      }
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      low = Math.max(low, ratio);
    } else {
      high = Math.min(high, ratio);
    }
    if (low > high) {
      return false;
    }
  }
  return high >= 0 && low <= 1;
};

const arrowSegments = (arrow: ExcalidrawArrowElement): Segment[] => {
  const points = arrow.points.map(
    (point) => [arrow.x + point[0], arrow.y + point[1]] as const,
  );
  return points
    .slice(0, -1)
    .map((point, index) => [point, points[index + 1]!] as const);
};

export const createStudyQuestionController = (
  api: SceneApi,
  idFactoryOrOptions: IdFactory | StudyQuestionControllerOptions = randomId,
) => {
  const options =
    typeof idFactoryOrOptions === "function" ? {} : idFactoryOrOptions;
  const idFactory =
    typeof idFactoryOrOptions === "function"
      ? idFactoryOrOptions
      : idFactoryOrOptions.idFactory ?? randomId;
  const canvasChoiceSession = options.canvasChoiceSession;
  const liveElements = () => api.getSceneElements();
  const allElements = () => api.getSceneElementsIncludingDeleted();

  const liveStudyNodes = (elements: readonly ExcalidrawElement[]) =>
    elements.filter(isStudyNode).filter((node) => textFor(node.id, elements));

  const validOpenQuestions = (elements: readonly ExcalidrawElement[]) => {
    const nodes = new Map(
      liveStudyNodes(elements).map((element) => [element.id, element]),
    );
    return elements.filter((element) => {
      if (element.isDeleted || element.locked || !isQuestionMarker(element)) {
        return false;
      }
      const data = questionData(element)!;
      return data.status === "open" && nodes.has(data.nodeId);
    });
  };

  const howToUse: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!emptyArgs(args)) {
      return failure("invalid_args", "how_to_use accepts an empty object");
    }
    const elements = liveElements();
    const hasLiveContent = elements.some(
      (element) =>
        !element.isDeleted && collapsedData(element).hiddenBy === null,
    );
    const canvasChoiceState = canvasChoiceSession?.begin(hasLiveContent);
    if (canvasChoiceState === "pending_choice") {
      return success({
        state: "canvas_choice_required",
        canvas_choice_required: true,
        choices: ["continue_existing", "create_new"],
        what_this_is:
          "A shared study canvas that already contains a map. Preserve it until the person chooses what to do.",
        workflow: [
          "Read the live map without changing it.",
          "Ask whether to continue it or create a new Study Map.",
          "Wait for the explicit answer before any map write.",
        ],
        human_only: ["Pointer and keyboard editing", "Pin questions"],
        next_step: `${AGENT_TOOL_ONLY_RULE} Call get_chart for a short orientation, then ask the person whether to continue_existing or create_new. After their explicit answer, call choose_canvas with that exact choice. Do not infer or change the map first.`,
        say_to_user:
          "I found a map already here. Do you want to continue with it, or start a new Study Map? I won't change it until you choose.",
        tools: [
          "how_to_use",
          "choose_canvas",
          "get_chart",
          "get_selection",
          "list_questions",
          "answer_question",
        ],
      });
    }
    if (canvasChoiceState === "new_pending_create") {
      return success({
        state: "new_canvas_required",
        canvas_choice_required: false,
        what_this_is:
          "A shared study canvas waiting for the chosen new map to be opened.",
        workflow: ["Preserve the current map, then open a blank one."],
        human_only: ["Pointer and keyboard editing", "Pin questions"],
        next_step: `${AGENT_TOOL_ONLY_RULE} The person chose create_new. Call create_canvas now. Do not call any other mutating page tool until it succeeds.`,
        say_to_user: "I'll preserve this map and open a new Study Map now.",
        tools: ["how_to_use", "choose_canvas", "create_canvas"],
      });
    }
    const nodes = liveStudyNodes(elements);
    const openQuestions = validOpenQuestions(elements);
    const labelsById = new Map(
      nodes.map((node) => [node.id, textFor(node.id, elements)]),
    );
    const openTargetLabel = openQuestions.length
      ? labelsById.get(questionData(openQuestions[0])!.nodeId)
      : undefined;
    let answeredTargetLabel: string | undefined;
    for (let index = elements.length - 1; index >= 0; index--) {
      const element = elements[index];
      const data = questionData(element);
      if (
        !element.isDeleted &&
        isQuestionMarker(element) &&
        data?.status === "answered"
      ) {
        answeredTargetLabel = labelsById.get(data.nodeId);
        if (answeredTargetLabel) {
          break;
        }
      }
    }
    const state =
      nodes.length === 0
        ? "empty"
        : openQuestions.length > 0
        ? "waiting"
        : "map";
    const guidance = {
      empty: {
        next_step: `${AGENT_TOOL_ONLY_RULE} Explain Study Map briefly, then ask what the person is learning. If they attached a paper, article or notes to the conversation, read that material yourself. Use create_shapes and connect_shapes to draw a small first map, five nodes at most, with short labels, and stop so they can react.`,
        say_to_user:
          "This is Study Map: tell me what you're learning or attach your material here, and I'll draw a small mind map that you can move, edit, undo, and question by hand.",
      },
      map: {
        next_step: `${AGENT_TOOL_ONLY_RULE} Call get_chart, give the person a short orientation to the map that is already here, explain that they can change it by hand, and ask what they want to understand or question next.`,
        say_to_user: answeredTargetLabel
          ? `I found an existing Study Map with an answer under “${answeredTargetLabel}”; I'll orient you to what's here, then ask what you want to understand, change, or question next.`
          : "I found an existing Study Map; I'll read it first and give you a quick orientation, then ask what you want to understand, change, or question next.",
      },
      waiting: {
        next_step: `${AGENT_TOOL_ONLY_RULE} Call get_chart and list_questions, orient the person to the existing map and its open question, then ask whether they want you to research it. If they do, answer in chat first, then call answer_question with one summary, key points, and sources. Do not paste full prose into one node.`,
        say_to_user: openTargetLabel
          ? `I found your existing map and an open question on “${openTargetLabel}”; I'll orient you to the map first, then we can research it and place the answer under that node.`
          : "I found an existing map with an open question; I'll orient you to what's here first, then we can research it and place the answer on the map.",
      },
    }[state];
    checkAbort(context.signal);
    return success({
      state,
      what_this_is:
        "A canvas where you and the person build a map of whatever they are learning. You draw it, they correct it by hand, and their questions live on the map.",
      workflow: [
        "Read material from the conversation.",
        "Use page tools to draw and read the map.",
        "Answer in chat, then distill a sourced branch.",
      ],
      human_only: ["Pointer and keyboard editing", "Pin questions", "Export"],
      next_step: guidance.next_step,
      say_to_user: guidance.say_to_user,
      tools: [
        "how_to_use",
        "choose_canvas",
        "get_chart",
        "get_selection",
        "list_questions",
        "answer_question",
      ],
    });
  };

  const chooseCanvas: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (
      !canvasChoiceSession ||
      !isRecord(args) ||
      !hasOnlyKeys(args, ["choice"]) ||
      (args.choice !== "continue_existing" && args.choice !== "create_new")
    ) {
      return failure(
        "invalid_args",
        "choice must be continue_existing or create_new after the person's explicit answer",
      );
    }
    const hasLiveContent = liveElements().some(
      (element) =>
        !element.isDeleted && collapsedData(element).hiddenBy === null,
    );
    const chosen = canvasChoiceSession.choose(args.choice, hasLiveContent);
    if (!chosen.ok) {
      return chosen;
    }
    return success({
      choice: args.choice,
      state: chosen.state,
      next_step:
        args.choice === "continue_existing"
          ? "Continue only through registered page tools; do not operate Excalidraw UI controls."
          : "Call create_canvas next; all other map writes remain blocked until it succeeds.",
    });
  };

  const getChart: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!emptyArgs(args)) {
      return failure("invalid_args", "get_chart accepts an empty object");
    }
    const elements = liveElements();
    const nodes = liveStudyNodes(elements);
    const nodeIds = new Set(nodes.map(({ id }) => id));
    const edges = elements.filter(
      (element) =>
        !element.isDeleted &&
        element.type === "arrow" &&
        element.startBinding &&
        element.endBinding &&
        nodeIds.has(element.startBinding.elementId) &&
        nodeIds.has(element.endBinding.elementId),
    );
    const selected = api.getAppState().selectedElementIds;
    const result = shrinkArraysToFit(
      {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes: nodes.slice(0, MAX_NODES).map((element) => {
          const collapsed = collapsedData(element);
          return {
            id: element.id,
            label: textFor(element.id, elements),
            text: textFor(element.id, elements),
            ...(collapsed.collapsed
              ? {
                  collapsed: true,
                  hiddenDirectBranchCount: collapsed.hiddenDirectBranchCount,
                }
              : {}),
          };
        }),
        edges: edges.slice(0, MAX_EDGES).map((element) => ({
          id: element.id,
          from: element.type === "arrow" ? element.startBinding!.elementId : "",
          to: element.type === "arrow" ? element.endBinding!.elementId : "",
        })),
        selectedIds: nodes
          .filter(({ id }) => selected[id])
          .slice(0, MAX_SELECTED)
          .map(({ id }) => id),
        openQuestionCount: validOpenQuestions(elements).length,
        collapsedNodeCount: nodes.filter(
          (element) => collapsedData(element).collapsed,
        ).length,
        truncated:
          nodes.length > MAX_NODES ||
          edges.length > MAX_EDGES ||
          nodes.filter(({ id }) => selected[id]).length > MAX_SELECTED,
      },
      ["edges", "nodes", "selectedIds"],
    );
    checkAbort(context.signal);
    return success(result);
  };

  const getSelection: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!emptyArgs(args)) {
      return failure("invalid_args", "get_selection accepts an empty object");
    }
    const elements = liveElements();
    const selectedIds = api.getAppState().selectedElementIds;
    const nodes = liveStudyNodes(elements).filter(({ id }) => selectedIds[id]);
    const openQuestions = validOpenQuestions(elements);
    const result = shrinkArraysToFit(
      {
        selected: nodes.slice(0, MAX_SELECTED).map((element) => ({
          id: element.id,
          label: textFor(element.id, elements),
          text: textFor(element.id, elements),
          questions: openQuestions
            .filter((question) => questionData(question)?.nodeId === element.id)
            .slice(0, MAX_OPEN_PER_NODE)
            .map((question) => ({
              id: question.id,
              text: questionTextFor(question, elements)?.text ?? "",
            })),
        })),
        selectedCount: nodes.length,
        truncated: nodes.length > MAX_SELECTED,
      },
      ["selected"],
    );
    checkAbort(context.signal);
    return success(result);
  };

  const listQuestions: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (!emptyArgs(args)) {
      return failure("invalid_args", "list_questions accepts an empty object");
    }
    const elements = liveElements();
    const nodes = new Map(
      liveStudyNodes(elements).map((element) => [element.id, element]),
    );
    const openMarkers = elements.filter(
      (element) =>
        !element.isDeleted &&
        isQuestionMarker(element) &&
        questionData(element)?.status === "open",
    );
    const valid = openMarkers.filter((marker) => {
      const data = questionData(marker)!;
      return (
        !marker.locked &&
        nodes.has(data.nodeId) &&
        questionTextFor(marker, elements)
      );
    });
    const orphanedQuestionCount = openMarkers.length - valid.length;
    const result = shrinkArraysToFit(
      {
        questions: valid.slice(0, MAX_QUESTIONS).map((marker) => {
          const data = questionData(marker)!;
          return {
            id: marker.id,
            nodeId: data.nodeId,
            nodeLabel: textFor(data.nodeId, elements),
            text: questionTextFor(marker, elements)!.text,
          };
        }),
        openQuestionCount: valid.length,
        orphanedQuestionCount,
        truncated: valid.length > MAX_QUESTIONS,
      },
      ["questions"],
    );
    checkAbort(context.signal);
    return success(result);
  };

  const answerQuestion: ToolDescriptor["execute"] = async (args, context) => {
    checkAbort(context.signal);
    if (
      !isRecord(args) ||
      !hasOnlyKeys(args, [
        "question_id",
        "answer_summary",
        "key_points",
        "sources",
      ]) ||
      typeof args.question_id !== "string" ||
      !SAFE_ID_RE.test(args.question_id) ||
      typeof args.answer_summary !== "string" ||
      !Array.isArray(args.key_points) ||
      (typeof args.sources !== "undefined" && !Array.isArray(args.sources))
    ) {
      return failure(
        "invalid_args",
        "question_id, answer_summary, and key_points are required",
      );
    }

    const answerSummary = normalizeWhitespace(args.answer_summary);
    const keyPoints = args.key_points.map((point) =>
      typeof point === "string" ? normalizeWhitespace(point) : null,
    );
    if (
      answerSummary.length < 1 ||
      answerSummary.length > MAX_ANSWER_SUMMARY ||
      keyPoints.length < 1 ||
      keyPoints.length > MAX_KEY_POINTS ||
      keyPoints.some(
        (point) => !point || point.length < 1 || point.length > MAX_KEY_POINT,
      ) ||
      new Set(keyPoints.map((point) => point!.toLocaleLowerCase())).size !==
        keyPoints.length
    ) {
      return failure(
        "invalid_args",
        "Answer summary or key points are invalid",
      );
    }

    const sourceValues = args.sources ?? [];
    if (sourceValues.length > MAX_SOURCES) {
      return failure("invalid_args", "At most two sources are allowed");
    }
    const sources: Array<{ title: string; url: string }> = [];
    for (const source of sourceValues) {
      if (
        !isRecord(source) ||
        !hasOnlyKeys(source, ["title", "url"]) ||
        typeof source.title !== "string" ||
        typeof source.url !== "string"
      ) {
        return failure(
          "invalid_args",
          "Each source needs a title and HTTPS URL",
        );
      }
      const title = normalizeWhitespace(source.title);
      let parsed: URL;
      try {
        parsed = new URL(source.url);
      } catch {
        return failure(
          "invalid_args",
          "Each source URL must be absolute HTTPS",
        );
      }
      if (
        title.length < 1 ||
        title.length > MAX_SOURCE_TITLE ||
        source.url.length > 2048 ||
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password
      ) {
        return failure(
          "invalid_args",
          "Each source needs a valid title and HTTPS URL",
        );
      }
      sources.push({ title, url: parsed.href });
    }
    if (
      new Set(sources.map(({ url }) => url.toLocaleLowerCase())).size !==
      sources.length
    ) {
      return failure("invalid_args", "Source URLs must be unique");
    }

    const live = liveElements();
    const elements = allElements();
    const marker = live.find(
      (element) => element.id === args.question_id && isQuestionMarker(element),
    );
    if (!marker || questionData(marker)?.status !== "open") {
      return failure("not_found", "Open question does not exist");
    }
    if (marker.locked) {
      return failure("unsafe_retry", "Question marker is locked");
    }
    const data = questionData(marker);
    if (!data || !SAFE_ID_RE.test(data.nodeId)) {
      return failure("unsafe_retry", "Question metadata is malformed");
    }
    const target = live.find(({ id }) => id === data.nodeId);
    if (!target || !isStudyNode(target) || !textFor(target.id, live)) {
      return failure("unsafe_retry", "Question target is unavailable");
    }
    const question = questionTextFor(marker, live);
    if (
      !question ||
      !marker.boundElements?.some(({ id }) => id === question.element.id)
    ) {
      return failure("unsafe_retry", "Question text binding is malformed");
    }

    const nodeInputs = [
      { role: "answer_summary", label: answerSummary, parent: target.id },
      ...keyPoints.map((label) => ({
        role: "key_point",
        label: label!,
        parent: "summary",
      })),
      ...sources.map(({ title, url }) => ({
        role: "source",
        label: title,
        parent: "summary",
        url,
      })),
    ] as const;
    const unavailable = new Set(elements.map(({ id }) => id));
    const allocated = nodeInputs.map((input) => ({
      ...input,
      layout: measureAnswerText(input.role as AnswerRole, input.label),
      nodeId: nextUniqueId(idFactory, unavailable),
      textId: nextUniqueId(idFactory, unavailable),
      arrowId: nextUniqueId(idFactory, unavailable),
    }));
    if (
      allocated.some(
        ({ nodeId, textId, arrowId }) => !nodeId || !textId || !arrowId,
      )
    ) {
      return failure("unsafe_retry", "Could not allocate collision-free ids");
    }
    checkAbort(context.signal);

    const summary = allocated[0] as typeof allocated[number] & {
      nodeId: string;
      textId: string;
      arrowId: string;
    };
    const summaryX = target.x + 8;
    const children = allocated.slice(1);
    const childrenWidth =
      children.reduce((total, item) => total + item.layout.width, 0) +
      Math.max(0, children.length - 1) * CHILD_HORIZONTAL_GAP;
    const childrenX = summaryX + summary.layout.width / 2 - childrenWidth / 2;
    const ignoredIds = new Set([
      target.id,
      ...(target.boundElements
        ?.filter(({ type }) => type === "text")
        .map(({ id }) => id) ?? []),
    ]);
    const visible = live.filter(
      (element) => collapsedData(element).hiddenBy === null,
    );
    const existingBoxes = visible
      .filter(
        (element) => !ignoredIds.has(element.id) && element.type !== "arrow",
      )
      .map(normalizedBox);
    const existingConnectorSegments = visible
      .filter(
        (element) => !ignoredIds.has(element.id) && element.type === "arrow",
      )
      .flatMap((element) =>
        arrowSegments(element as unknown as ExcalidrawArrowElement),
      );

    const positionLayout = (candidateY: number) => {
      let nextChildX = childrenX;
      return allocated.map((item, index) => {
        const positioned = {
          ...item,
          x: index === 0 ? summaryX : nextChildX,
          y:
            index === 0
              ? candidateY
              : candidateY + summary.layout.height + CHILD_VERTICAL_GAP,
          width: item.layout.width,
          height: item.layout.height,
        };
        if (index > 0) {
          nextChildX += item.layout.width + CHILD_HORIZONTAL_GAP;
        }
        return positioned;
      });
    };
    const connectorSegmentsFor = (
      positioned: ReturnType<typeof positionLayout>,
    ): Segment[] => {
      const positionedSummary = positioned[0]!;
      return positioned.map((item, index) => {
        const start =
          index === 0
            ? ([target.x + target.width / 2, target.y + target.height] as const)
            : ([
                positionedSummary.x + positionedSummary.width / 2,
                positionedSummary.y + positionedSummary.height,
              ] as const);
        const end = [item.x + item.width / 2, item.y] as const;
        return [start, end] as const;
      });
    };
    const positionIsSafe = (positioned: ReturnType<typeof positionLayout>) => {
      const boxes = positioned.map(normalizedBox);
      if (
        boxes.some((box) =>
          existingBoxes.some((existing) => boxesOverlap(box, existing)),
        ) ||
        boxes.some((box) =>
          existingConnectorSegments.some((segment) =>
            segmentIntersectsBoxInterior(segment, box),
          ),
        )
      ) {
        return false;
      }
      const plannedConnectors = connectorSegmentsFor(positioned);
      if (
        plannedConnectors.some((segment) =>
          existingBoxes.some((box) =>
            segmentIntersectsBoxInterior(segment, box),
          ),
        )
      ) {
        return false;
      }
      return plannedConnectors.every((segment, connectorIndex) =>
        boxes.every(
          (box, boxIndex) =>
            boxIndex === connectorIndex ||
            (connectorIndex > 0 && boxIndex === 0) ||
            !segmentIntersectsBoxInterior(segment, box),
        ),
      );
    };

    let summaryY: number | null = null;
    for (let step = 0; step <= MAX_PLACEMENT_STEP; step++) {
      const candidateY =
        target.y + target.height + CHILD_VERTICAL_GAP + step * PLACEMENT_STEP;
      if (positionIsSafe(positionLayout(candidateY))) {
        summaryY = candidateY;
        break;
      }
    }
    if (summaryY === null) {
      return failure("unsafe_retry", "No safe answer placement was available");
    }
    const positioned = positionLayout(summaryY);

    const skeletons: ExcalidrawElementSkeleton[] = [
      structuredClone(target) as ExcalidrawElementSkeleton,
    ];
    positioned.forEach((item, index) => {
      const nodeId = item.nodeId!;
      const textId = item.textId!;
      const arrowId = item.arrowId!;
      const isSummary = index === 0;
      const nodeX = item.x;
      const nodeY = item.y;
      const width = item.width;
      const height = item.height;
      const parentId = isSummary ? target.id : summary.nodeId;
      const customData = {
        kind: "answer",
        role: item.role,
        questionId: marker.id,
        nodeId: target.id,
        parentId,
        createdBy: "ask-the-chart",
      };
      skeletons.push(
        {
          id: nodeId,
          type: "rectangle",
          x: nodeX,
          y: nodeY,
          width,
          height,
          backgroundColor: item.role === "source" ? "#d0ebff" : "#fff3bf",
          boundElements: [{ id: arrowId, type: "arrow" }],
          label: {
            id: textId,
            text: item.layout.text,
            fontFamily: ANSWER_FONT_FAMILY,
            fontSize: ANSWER_FONT_SIZE,
            lineHeight: ANSWER_LINE_HEIGHT,
            customData,
          },
          ...(item.role === "source" && "url" in item
            ? { link: item.url }
            : {}),
          customData,
        } as ExcalidrawElementSkeleton,
        {
          id: arrowId,
          type: "arrow",
          x: isSummary
            ? target.x + target.width / 2
            : positioned[0]!.x + positioned[0]!.width / 2,
          y: isSummary
            ? target.y + target.height
            : positioned[0]!.y + positioned[0]!.height,
          width:
            nodeX +
            width / 2 -
            (isSummary
              ? target.x + target.width / 2
              : positioned[0]!.x + positioned[0]!.width / 2),
          height:
            nodeY -
            (isSummary
              ? target.y + target.height
              : positioned[0]!.y + positioned[0]!.height),
          start: { id: parentId },
          end: { id: nodeId },
          customData,
        },
      );
    });

    const converted = convertToExcalidrawElements(skeletons, {
      regenerateIds: false,
    });
    const convertedById = new Map(
      converted.map((element) => [element.id, element]),
    );
    const convertedTarget = convertedById.get(target.id);
    const created = allocated.flatMap(({ nodeId, textId, arrowId }) => [
      convertedById.get(nodeId!),
      convertedById.get(textId!),
      convertedById.get(arrowId!),
    ]);
    const validBindings = allocated.every(({ nodeId, arrowId }, index) => {
      const arrow = convertedById.get(arrowId!);
      return (
        arrow?.type === "arrow" &&
        arrow.startBinding?.elementId ===
          (index === 0 ? target.id : summary.nodeId) &&
        arrow.endBinding?.elementId === nodeId
      );
    });
    const validTextLayout = positioned.every((item) => {
      const node = convertedById.get(item.nodeId!);
      const text = convertedById.get(item.textId!);
      return (
        node?.type === "rectangle" &&
        text?.type === "text" &&
        text.containerId === node.id &&
        node.width === item.width &&
        node.height === item.height &&
        Number.isFinite(text.x) &&
        Number.isFinite(text.y) &&
        Number.isFinite(text.width) &&
        Number.isFinite(text.height) &&
        text.width + BOUND_TEXT_PADDING * 2 <= node.width + 1e-6 &&
        text.height + BOUND_TEXT_PADDING * 2 <= node.height + 1e-6 &&
        text.x >= node.x + BOUND_TEXT_PADDING - 1e-6 &&
        text.y >= node.y + BOUND_TEXT_PADDING - 1e-6 &&
        text.x + text.width <=
          node.x + node.width - BOUND_TEXT_PADDING + 1e-6 &&
        text.y + text.height <= node.y + node.height - BOUND_TEXT_PADDING + 1e-6
      );
    });
    if (
      !convertedTarget ||
      created.some((element) => !element) ||
      !validBindings ||
      !validTextLayout
    ) {
      return failure(
        "unsafe_retry",
        "Answer bindings and text layout could not be verified",
      );
    }
    checkAbort(context.signal);

    const answeredMarker = newElementWith(marker, {
      customData: withCustomData(marker, { status: "answered" }),
    });
    const answeredQuestionTextValue = `✓ ${question.text}`;
    const answeredQuestionText = newElementWith(question.element, {
      text: answeredQuestionTextValue,
      originalText: answeredQuestionTextValue,
      customData: withCustomData(question.element, { status: "answered" }),
    });
    const targetWithBinding = newElementWith(target, {
      boundElements: convertedTarget.boundElements,
    });
    const updated = elements.map((element) => {
      if (element.id === marker.id) {
        return answeredMarker;
      }
      if (element.id === question.element.id) {
        return answeredQuestionText;
      }
      if (element.id === target.id) {
        return targetWithBinding;
      }
      return element;
    });
    checkAbort(context.signal);
    api.updateScene({
      elements: [...updated, ...(created as ExcalidrawElement[])],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return success({
      questionId: marker.id,
      anchorNodeId: target.id,
      answerSummaryNodeId: summary.nodeId,
      status: "answered",
      createdNodeCount: allocated.length,
      createdConnectorCount: allocated.length,
      appliedElementCount: allocated.length * 3,
    });
  };

  const descriptors: ToolDescriptor[] = [
    {
      name: "how_to_use",
      description: `READ ME FIRST. Call this before any other tool every time the page opens. ${AGENT_TOOL_ONLY_RULE}`,
      inputSchema: toolSchema({}, []),
      annotations: { readOnlyHint: true },
      execute: howToUse,
    },
    {
      name: "choose_canvas",
      description:
        "Record the person's explicit answer to continue the existing canvas or create a new one. Ask first and never infer their choice.",
      inputSchema: toolSchema(
        {
          choice: {
            type: "string",
            enum: ["continue_existing", "create_new"],
          },
        },
        ["choice"],
      ),
      annotations: { readOnlyHint: false },
      execute: chooseCanvas,
    },
    {
      name: "get_chart",
      description:
        "Read a bounded outline of the live study map without exposing geometry or files.",
      inputSchema: toolSchema({}, []),
      annotations: { readOnlyHint: true },
      execute: getChart,
    },
    {
      name: "get_selection",
      description:
        "Read the currently selected study nodes and their open questions.",
      inputSchema: toolSchema({}, []),
      annotations: { readOnlyHint: true },
      execute: getSelection,
    },
    {
      name: "list_questions",
      description:
        "List bounded open question marks with their live study-node context.",
      inputSchema: toolSchema({}, []),
      annotations: { readOnlyHint: true },
      execute: listQuestions,
    },
    {
      name: "answer_question",
      description:
        "Answer the person fully in chat, then distill the answer into a compact branch from the questioned node — do not paste full prose into the map.",
      inputSchema: toolSchema(
        {
          question_id: { type: "string", minLength: 1, maxLength: 64 },
          answer_summary: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ANSWER_SUMMARY,
          },
          key_points: {
            type: "array",
            minItems: 1,
            maxItems: MAX_KEY_POINTS,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: MAX_KEY_POINT },
          },
          sources: {
            type: "array",
            maxItems: MAX_SOURCES,
            uniqueItems: true,
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_SOURCE_TITLE,
                },
                url: {
                  type: "string",
                  minLength: 1,
                  maxLength: 2048,
                  pattern: "^https://",
                },
              },
              required: ["title", "url"],
              additionalProperties: false,
            },
          },
        },
        ["question_id", "answer_summary", "key_points"],
      ),
      annotations: { readOnlyHint: false },
      execute: answerQuestion,
    },
  ];
  const registry = createToolRegistry(descriptors);

  const pinQuestionFromHuman = (
    gesture: HumanGesture,
    input: { nodeId: string; text: string },
  ): { ok: true; questionId: string } | ToolFailure => {
    if (!gesture.isTrusted) {
      return failure("invalid_args", "A trusted human gesture is required");
    }
    if (
      !isRecord(input) ||
      !hasOnlyKeys(input, ["nodeId", "text"]) ||
      typeof input.nodeId !== "string" ||
      !SAFE_ID_RE.test(input.nodeId) ||
      typeof input.text !== "string"
    ) {
      return failure("invalid_args", "nodeId and text are required");
    }
    const text = input.text.trim();
    if (text.length < 1 || text.length > 280) {
      return failure("invalid_args", "text must contain 1 to 280 characters");
    }
    const live = liveElements();
    const elements = allElements();
    const target = live.find(({ id }) => id === input.nodeId);
    if (!target || !isStudyNode(target) || !textFor(target.id, live)) {
      return failure("not_found", "Study node does not exist or is locked");
    }
    const openForNode = live.filter((element) => {
      const data = questionData(element);
      return (
        !element.isDeleted &&
        isQuestionMarker(element) &&
        data?.status === "open" &&
        data.nodeId === target.id
      );
    }).length;
    if (openForNode >= MAX_OPEN_PER_NODE) {
      return failure(
        "invalid_args",
        `A node may have at most ${MAX_OPEN_PER_NODE} open questions`,
      );
    }
    const unavailable = new Set(elements.map(({ id }) => id));
    const markerId = nextUniqueId(idFactory, unavailable);
    const textId = nextUniqueId(idFactory, unavailable);
    if (!markerId || !textId) {
      return failure("unsafe_retry", "Could not allocate collision-free ids");
    }
    const customData = {
      kind: "question",
      status: "open",
      nodeId: target.id,
    };
    const markerX = target.x + target.width - 8;
    const markerY = target.y + target.height + 8;
    const converted = convertToExcalidrawElements(
      [
        {
          id: markerId,
          type: "ellipse",
          x: markerX,
          y: markerY,
          width: 30,
          height: 30,
          backgroundColor: "#fff3bf",
          boundElements: [{ id: textId, type: "text" }],
          customData,
        },
        {
          id: textId,
          type: "text",
          x: markerX + 4,
          y: markerY + 4,
          text: `? ${text}`,
          containerId: markerId,
          customData,
        },
      ],
      { regenerateIds: false },
    );
    const marker = converted.find(({ id }) => id === markerId);
    const questionText = converted.find(({ id }) => id === textId);
    if (
      !marker ||
      !questionText ||
      questionText.type !== "text" ||
      questionText.containerId !== markerId ||
      !marker.boundElements?.some(({ id }) => id === textId)
    ) {
      return failure("unsafe_retry", "Question binding could not be verified");
    }
    api.updateScene({
      elements: [...elements, marker, questionText],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return deepFreeze({ ok: true as const, questionId: markerId });
  };

  const getBranchState = (rootId: string) => {
    if (typeof rootId !== "string" || !SAFE_ID_RE.test(rootId)) {
      return failure("invalid_args", "rootId is required");
    }
    const root = liveElements().find(({ id }) => id === rootId);
    if (!root || !isStudyNode(root)) {
      return failure("not_found", "Study node does not exist or is locked");
    }
    const data = collapsedData(root);
    return success({
      rootId: root.id,
      collapsed: data.collapsed,
      hiddenDirectBranchCount: data.hiddenDirectBranchCount,
    });
  };

  const collapseBranchFromHuman = (
    gesture: HumanGesture,
    input: { rootId: string },
  ) => {
    if (!gesture.isTrusted) {
      return failure("invalid_args", "A trusted human gesture is required");
    }
    const state = getBranchState(input.rootId);
    if (!state.ok) {
      return state;
    }
    if (state.collapsed) {
      return failure("unsafe_retry", "That branch is already collapsed");
    }

    const live = liveElements();
    const elements = allElements();
    const root = live.find(({ id }) => id === input.rootId)!;
    const nodeIds = new Set(live.filter(isStudyNode).map(({ id }) => id));
    const arrows = live.filter(
      (element) =>
        element.type === "arrow" &&
        Boolean(element.startBinding) &&
        Boolean(element.endBinding) &&
        nodeIds.has(element.startBinding!.elementId) &&
        nodeIds.has(element.endBinding!.elementId),
    ) as unknown as readonly ExcalidrawArrowElement[];
    const direct = arrows.filter(
      (arrow) => arrow.startBinding?.elementId === root.id,
    );
    if (direct.length === 0) {
      return failure(
        "not_found",
        "Selected node has no visible outgoing branch",
      );
    }

    const hiddenIds = new Set<string>();
    const visited = new Set<string>([root.id]);
    const queue = [root.id];
    while (queue.length) {
      const currentId = queue.shift()!;
      for (const arrow of arrows.filter(
        (candidate) => candidate.startBinding?.elementId === currentId,
      )) {
        hiddenIds.add(arrow.id);
        const childId = arrow.endBinding!.elementId;
        if (childId === root.id || visited.has(childId)) {
          continue;
        }
        const closesCycle = arrows.some(
          (candidate) =>
            candidate.startBinding?.elementId === childId &&
            visited.has(candidate.endBinding?.elementId ?? ""),
        );
        if (closesCycle) {
          continue;
        }
        const hasOtherVisibleParent = arrows.some(
          (candidate) =>
            candidate.id !== arrow.id &&
            candidate.endBinding?.elementId === childId &&
            candidate.startBinding?.elementId !== childId &&
            !hiddenIds.has(candidate.id) &&
            !visited.has(candidate.startBinding!.elementId),
        );
        if (hasOtherVisibleParent) {
          continue;
        }
        visited.add(childId);
        hiddenIds.add(childId);
        const child = live.find(({ id }) => id === childId);
        child?.boundElements
          ?.filter(({ type }) => type === "text")
          .forEach(({ id }) => hiddenIds.add(id));
        for (const question of live.filter(
          (element) =>
            isQuestionMarker(element) &&
            questionData(element)?.nodeId === childId,
        )) {
          hiddenIds.add(question.id);
          question.boundElements?.forEach(({ id }) => hiddenIds.add(id));
        }
        if (!child || !collapsedData(child).collapsed) {
          queue.push(childId);
        }
      }
    }

    const updated = elements.map((element) => {
      if (element.id === root.id) {
        return newElementWith(element, {
          customData: withCustomData(element, {
            studyMapCollapsed: true,
            hiddenDirectBranchCount: direct.length,
          }),
        });
      }
      if (!hiddenIds.has(element.id)) {
        return element;
      }
      return newElementWith(element, {
        isDeleted: true,
        customData: withCustomData(element, {
          studyMapHiddenBy: root.id,
        }),
      });
    });
    api.updateScene({
      elements: updated,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return success({
      action: "collapsed",
      rootId: root.id,
      hiddenDirectBranchCount: direct.length,
      hiddenElementCount: hiddenIds.size,
    });
  };

  const expandBranchFromHuman = (
    gesture: HumanGesture,
    input: { rootId: string },
  ) => {
    if (!gesture.isTrusted) {
      return failure("invalid_args", "A trusted human gesture is required");
    }
    const state = getBranchState(input.rootId);
    if (!state.ok) {
      return state;
    }
    if (!state.collapsed) {
      return failure("unsafe_retry", "That branch is not collapsed");
    }
    const elements = allElements();
    const restored = elements.filter(
      (element) =>
        element.isDeleted && collapsedData(element).hiddenBy === input.rootId,
    );
    const updated = elements.map((element) => {
      if (element.id === input.rootId) {
        return newElementWith(element, {
          customData: withoutCustomDataKeys(element, [
            "studyMapCollapsed",
            "hiddenDirectBranchCount",
          ]),
        });
      }
      if (
        !element.isDeleted ||
        collapsedData(element).hiddenBy !== input.rootId
      ) {
        return element;
      }
      return newElementWith(element, {
        isDeleted: false,
        customData: withoutCustomDataKeys(element, ["studyMapHiddenBy"]),
      });
    });
    api.updateScene({
      elements: updated,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return success({
      action: "expanded",
      rootId: input.rootId,
      hiddenDirectBranchCount: state.hiddenDirectBranchCount,
      restoredElementCount: restored.length,
    });
  };
  return {
    listTools: (): PublicToolDescriptor[] => registry.listTools(),
    executeTool: (
      name: string,
      args: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolResult> => {
      if (name === "answer_question") {
        const blocked = canvasChoiceSession?.guard(name);
        if (blocked) {
          return Promise.resolve(blocked);
        }
      }
      return registry.execute(name, args, context);
    },
    pinQuestionFromHuman,
    getBranchState,
    collapseBranchFromHuman,
    expandBranchFromHuman,
    dispose: () => registry.dispose(),
  };
};
