import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { randomId } from "@excalidraw/common";
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createToolRegistry, MAX_RESULT_CHARACTERS } from "./tool_registry";

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
  "getAppState" | "getSceneElements" | "updateScene"
>;

export type IdFactory = () => string;
export type HumanGesture = { isTrusted: boolean };

const STUDY_NODE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NODES = 24;
const MAX_EDGES = 24;
const MAX_SELECTED = 12;
const MAX_QUESTIONS = 20;
const MAX_OPEN_PER_NODE = 8;
const MAX_LINE = 120;

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
    kind !== "question" &&
    kind !== "answer"
  );
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

export const createStudyQuestionController = (
  api: SceneApi,
  idFactory: IdFactory = randomId,
) => {
  const liveElements = () => api.getSceneElements();

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
    const nodes = liveStudyNodes(elements);
    const openQuestions = validOpenQuestions(elements);
    const hasAnswers = elements.some(
      (element) =>
        !element.isDeleted &&
        isRecord(element.customData) &&
        element.customData.kind === "answer",
    );
    const state =
      nodes.length === 0
        ? "empty"
        : openQuestions.length > 0
        ? "waiting"
        : hasAnswers
        ? "answered"
        : "chart";
    const guidance = {
      empty: {
        next_step:
          "Ask what the person is learning, then draw a small first map from their topic or source.",
        en: "What are you learning today? Name a topic, paste text, or drop a PDF and I will map it with you.",
        vi: "Hôm nay bạn muốn học gì? Hãy nêu chủ đề, dán văn bản hoặc thả PDF để tôi cùng bạn vẽ sơ đồ.",
      },
      chart: {
        next_step:
          "Invite the person to pin a question mark on the node they want to understand next.",
        en: "Choose any node you want to understand better, then pin a question mark and type your question.",
        vi: "Hãy chọn nút bạn muốn hiểu thêm, cắm dấu hỏi rồi nhập câu hỏi của bạn.",
      },
      waiting: {
        next_step:
          "Read the open questions, research them, then create a connected answer shape under each asked node.",
        en: "I can see an open question. I will research it and create a connected answer shape under the node you asked about.",
        vi: "Tôi thấy câu hỏi đang mở. Tôi sẽ tìm hiểu rồi tạo một hình chứa câu trả lời được nối với nút bạn đã hỏi.",
      },
      answered: {
        next_step:
          "Ask the person to review, drag, edit, delete, or undo the connected answer shape, then continue with another question.",
        en: "The connected answer shape is on the map. Correct it by hand if needed, or pin the next question.",
        vi: "Hình chứa câu trả lời đã nối vào sơ đồ. Bạn có thể sửa trực tiếp hoặc cắm dấu hỏi tiếp theo.",
      },
    }[state];
    checkAbort(context.signal);
    return success({
      what_this_is:
        "Study Map turns learning into a shared diagram where every answered question grows a connected mind map.",
      workflow: [
        "Name a topic, paste text, or drop a PDF.",
        "ChatGPT draws the study map.",
        "Pin a question mark on any node.",
        "ChatGPT creates an answer shape connected to the asked node.",
        "Drag, edit, delete, or undo it; repeat to grow the mind map.",
      ],
      human_only: [
        "Pin or edit a question mark",
        "Drag or delete elements",
        "Undo",
        "Export",
      ],
      next_step: guidance.next_step,
      say_to_user: { en: guidance.en, vi: guidance.vi },
      tools: [
        "how_to_use: call first and after the map changes",
        "get_chart: read the bounded live outline",
        "get_selection: inspect selected study nodes",
        "list_questions: find open question marks",
        "answer_question: create an answer shape connected to its questioned node",
      ],
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
        nodes: nodes.slice(0, MAX_NODES).map((element) => ({
          id: element.id,
          label: textFor(element.id, elements),
          text: textFor(element.id, elements),
        })),
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
      !hasOnlyKeys(args, ["question_id", "answer"]) ||
      typeof args.question_id !== "string" ||
      !SAFE_ID_RE.test(args.question_id) ||
      typeof args.answer !== "string"
    ) {
      return failure("invalid_args", "question_id and answer are required");
    }
    const answer = args.answer.trim();
    if (answer.length < 1 || answer.length > 600) {
      return failure("invalid_args", "answer must contain 1 to 600 characters");
    }

    const elements = liveElements();
    const marker = elements.find(
      (element) => element.id === args.question_id && isQuestionMarker(element),
    );
    if (
      !marker ||
      marker.isDeleted ||
      questionData(marker)?.status !== "open"
    ) {
      return failure("not_found", "Open question does not exist");
    }
    if (marker.locked) {
      return failure("unsafe_retry", "Question marker is locked");
    }
    const data = questionData(marker);
    if (!data || !SAFE_ID_RE.test(data.nodeId)) {
      return failure("unsafe_retry", "Question metadata is malformed");
    }
    const target = elements.find(({ id }) => id === data.nodeId);
    if (!target || !isStudyNode(target) || !textFor(target.id, elements)) {
      return failure("unsafe_retry", "Question target is unavailable");
    }
    const question = questionTextFor(marker, elements);
    if (
      !question ||
      !marker.boundElements?.some(({ id }) => id === question.element.id)
    ) {
      return failure("unsafe_retry", "Question text binding is malformed");
    }

    const unavailable = new Set(elements.map(({ id }) => id));
    const answerNodeId = nextUniqueId(idFactory, unavailable);
    const answerTextId = nextUniqueId(idFactory, unavailable);
    const arrowId = nextUniqueId(idFactory, unavailable);
    if (!answerNodeId || !answerTextId || !arrowId) {
      return failure("unsafe_retry", "Could not allocate collision-free ids");
    }
    checkAbort(context.signal);

    const width = 320;
    const height = 84;
    const x = target.x + 8;
    let y: number | null = null;
    for (let step = 0; step <= 12; step++) {
      const candidate = {
        x,
        y: target.y + target.height + 24 + step * 48,
        width,
        height,
      };
      if (
        !elements.some(
          (element) =>
            !element.isDeleted &&
            element.id !== marker.id &&
            element.id !== question.element.id &&
            boxesOverlap(candidate, element),
        )
      ) {
        y = candidate.y;
        break;
      }
    }
    if (y === null) {
      return failure("unsafe_retry", "No safe answer placement was available");
    }

    const answerData = {
      kind: "answer",
      questionId: marker.id,
      nodeId: target.id,
      createdBy: "ask-the-chart",
    };
    const skeletons: ExcalidrawElementSkeleton[] = [
      structuredClone(target) as ExcalidrawElementSkeleton,
      {
        id: answerNodeId,
        type: "rectangle",
        x,
        y,
        width,
        height,
        backgroundColor: "#fff3bf",
        boundElements: [
          { id: answerTextId, type: "text" },
          { id: arrowId, type: "arrow" },
        ],
        customData: answerData,
      },
      {
        id: answerTextId,
        type: "text",
        x: x + 12,
        y: y + 12,
        text: answer,
        containerId: answerNodeId,
        customData: answerData,
      },
      {
        id: arrowId,
        type: "arrow",
        x: target.x + target.width / 2,
        y: target.y + target.height,
        width: x + width / 2 - (target.x + target.width / 2),
        height: y - (target.y + target.height),
        start: { id: target.id },
        end: { id: answerNodeId },
        customData: answerData,
      },
    ];
    const converted = convertToExcalidrawElements(skeletons, {
      regenerateIds: false,
    });
    const convertedById = new Map(
      converted.map((element) => [element.id, element]),
    );
    const convertedTarget = convertedById.get(target.id);
    const convertedAnswer = convertedById.get(answerNodeId);
    const convertedText = convertedById.get(answerTextId);
    const convertedArrow = convertedById.get(arrowId);
    if (
      !convertedTarget ||
      !convertedAnswer ||
      !convertedText ||
      !convertedArrow ||
      convertedArrow.type !== "arrow" ||
      convertedArrow.startBinding?.elementId !== target.id ||
      convertedArrow.endBinding?.elementId !== answerNodeId ||
      !convertedTarget.boundElements?.some(({ id }) => id === arrowId) ||
      !convertedAnswer.boundElements?.some(({ id }) => id === arrowId)
    ) {
      return failure("unsafe_retry", "Answer bindings could not be verified");
    }
    checkAbort(context.signal);

    const answeredData = {
      ...marker.customData,
      status: "answered",
    };
    const answeredMarker = newElementWith(marker, {
      customData: answeredData,
    });
    const answeredTextValue = `✓ ${question.text}`;
    const answeredQuestionText = newElementWith(question.element, {
      text: answeredTextValue,
      originalText: answeredTextValue,
      customData: {
        ...question.element.customData,
        status: "answered",
      },
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
      elements: [
        updated,
        convertedAnswer,
        convertedText,
        convertedArrow,
      ].flat(),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return success({
      questionId: marker.id,
      nodeId: target.id,
      answerNodeId,
      status: "answered",
      appliedElementCount: 5,
    });
  };

  const descriptors: ToolDescriptor[] = [
    {
      name: "how_to_use",
      description:
        "Start here: how this study map works and what to do next with the person, given the live canvas.",
      inputSchema: toolSchema({}, []),
      annotations: { readOnlyHint: true },
      execute: howToUse,
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
        "Place a researched answer under an open question's live node and mark it answered.",
      inputSchema: toolSchema(
        {
          question_id: { type: "string", minLength: 1, maxLength: 64 },
          answer: { type: "string", minLength: 1, maxLength: 600 },
        },
        ["question_id", "answer"],
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
    const elements = liveElements();
    const target = elements.find(({ id }) => id === input.nodeId);
    if (!target || !isStudyNode(target) || !textFor(target.id, elements)) {
      return failure("not_found", "Study node does not exist or is locked");
    }
    const openForNode = elements.filter((element) => {
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

  return {
    listTools: (): PublicToolDescriptor[] => registry.listTools(),
    executeTool: (
      name: string,
      args: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolResult> => registry.execute(name, args, context),
    pinQuestionFromHuman,
    dispose: () => registry.dispose(),
  };
};
