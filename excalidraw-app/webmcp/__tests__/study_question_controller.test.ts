import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { describe, expect, it, vi } from "vitest";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { createStudyQuestionController } from "../study_question_controller";

const signal = () => new AbortController().signal;

const makeIds = (prefix = "made") => {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
};

const makeElements = (skeletons: ExcalidrawElementSkeleton[]) =>
  convertToExcalidrawElements(skeletons, { regenerateIds: false });

const node = (
  id: string,
  label: string,
  x = 100,
  y = 100,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    type: "rectangle",
    x,
    y,
    width: 180,
    height: 72,
    label: { text: label },
    ...extra,
  } as ExcalidrawElementSkeleton);

const questionElements = (
  questionId: string,
  textId: string,
  nodeId: string,
  text: string,
  status: "open" | "answered" = "open",
) =>
  makeElements([
    {
      id: questionId,
      type: "ellipse",
      x: 250,
      y: 150,
      width: 30,
      height: 30,
      boundElements: [{ id: textId, type: "text" }],
      customData: { kind: "question", status, nodeId },
    },
    {
      id: textId,
      type: "text",
      x: 254,
      y: 154,
      text: `${status === "open" ? "?" : "✓"} ${text}`,
      containerId: questionId,
      customData: { kind: "question", status, nodeId },
    },
  ]);

const makeApi = (initial: ExcalidrawElement[] = []) => {
  let elements = initial;
  let selectedElementIds: Record<string, boolean> = {};
  const updateScene = vi.fn(
    (scene: {
      elements: readonly ExcalidrawElement[];
      captureUpdate: unknown;
    }) => {
      elements = [...scene.elements];
    },
  );

  return {
    api: {
      getSceneElements: () => elements,
      getAppState: () => ({ selectedElementIds }),
      updateScene,
    },
    getElements: () => elements,
    setElements: (next: ExcalidrawElement[]) => {
      elements = next;
    },
    setSelected: (...ids: string[]) => {
      selectedElementIds = Object.fromEntries(ids.map((id) => [id, true]));
    },
    updateScene,
  };
};

describe("Study Map study-question controller", () => {
  it("registers how_to_use first and keeps every schema closed", () => {
    const fixture = makeApi();
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds(),
    );
    const tools = controller.listTools();

    expect(tools.map(({ name }) => name)).toEqual([
      "how_to_use",
      "get_chart",
      "get_selection",
      "list_questions",
      "answer_question",
    ]);
    expect(tools[0]).toMatchObject({
      description: expect.stringMatching(/^Start here:/),
      annotations: { readOnlyHint: true },
    });
    expect(tools.map(({ annotations }) => annotations.readOnlyHint)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(
      tools.every(
        ({ inputSchema }) => inputSchema.additionalProperties === false,
      ),
    ).toBe(true);
    expect(
      tools.every(
        ({ name }) => !/pin|add_question|delete|commit|undo/i.test(name),
      ),
    ).toBe(true);
  });

  it("returns a bounded bilingual how_to_use guide grounded in four live states", async () => {
    const fixture = makeApi();
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds(),
    );
    const run = () =>
      controller.executeTool("how_to_use", {}, { signal: signal() });

    const empty = await run();
    fixture.setElements(makeElements([node("dynasty", "Đinh Bộ Lĩnh")]));
    const chart = await run();
    fixture.setElements([
      ...fixture.getElements(),
      ...questionElements(
        "question-hang-lang",
        "question-text-hang-lang",
        "dynasty",
        "Hạng Lang mất năm nào?",
      ),
    ]);
    const waiting = await run();
    fixture.setElements([
      ...fixture.getElements().map((element) =>
        element.customData?.kind === "question"
          ? ({
              ...element,
              customData: { ...element.customData, status: "answered" },
            } as ExcalidrawElement)
          : element,
      ),
      ...makeElements([
        {
          ...node("answer-one", "Hạng Lang mất năm 979", 100, 240),
          customData: { kind: "answer", questionId: "q", nodeId: "dynasty" },
        } as ExcalidrawElementSkeleton,
      ]),
    ]);
    const answered = await run();

    const steps = [empty, chart, waiting, answered].map(
      (result) => (result as unknown as { next_step: string }).next_step,
    );
    expect(new Set(steps).size).toBe(4);
    for (const result of [empty, chart, waiting, answered]) {
      expect(result).toMatchObject({
        ok: true,
        what_this_is: expect.stringContaining("Study Map"),
        workflow: expect.any(Array),
        human_only: expect.any(Array),
        next_step: expect.any(String),
        say_to_user: {
          en: expect.any(String),
          vi: expect.stringMatching(/[ăâđêôơưạảấầậẩẫ]/i),
        },
        tools: expect.any(Array),
      });
      const encoded = JSON.stringify(result);
      expect(encoded.length).toBeLessThan(1536);
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(2000);
      expect(encoded).not.toContain("Hạng Lang mất năm nào");
      expect(encoded).not.toMatch(/selectedElementIds|customData|"x"|"y"/);
      expect(Object.isFrozen(result)).toBe(true);
      expect(
        Object.isFrozen(
          (result as unknown as { say_to_user: object }).say_to_user,
        ),
      ).toBe(true);
    }
    await expect(
      controller.executeTool(
        "how_to_use",
        { topic: "history" },
        { signal: signal() },
      ),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_args" });
    expect(fixture.updateScene).not.toHaveBeenCalled();
  });

  it("projects a bounded live chart without geometry or private scene data", async () => {
    const skeletons: ExcalidrawElementSkeleton[] = [];
    for (let index = 0; index < 30; index++) {
      skeletons.push(node(`n-${index}`, `Person ${index}`, index * 200, 100));
    }
    for (let index = 0; index < 30; index++) {
      skeletons.push({
        id: `edge-${index}`,
        type: "arrow",
        x: index * 200,
        y: 180,
        width: 100,
        height: 0,
        start: { id: `n-${index}` },
        end: { id: `n-${(index + 1) % 30}` },
      });
    }
    const fixture = makeApi(makeElements(skeletons));
    fixture.setSelected("n-0", "n-29", "missing");
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds(),
    );

    const result = await controller.executeTool(
      "get_chart",
      {},
      {
        signal: signal(),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      nodeCount: 30,
      edgeCount: 30,
      truncated: true,
      selectedIds: ["n-0", "n-29"],
    });
    expect((result as unknown as { nodes: unknown[] }).nodes).toHaveLength(24);
    expect(
      (result as unknown as { edges: unknown[] }).edges.length,
    ).toBeLessThanOrEqual(24);
    const encoded = JSON.stringify(result);
    expect(encoded.length).toBeLessThan(1536);
    expect(encoded).not.toMatch(
      /customData|versionNonce|isDeleted|"x"|"y"|width|height|files|data:image/,
    );

    fixture.setElements(makeElements([node("fresh", "Mới")]));
    const fresh = await controller.executeTool(
      "get_chart",
      {},
      {
        signal: signal(),
      },
    );
    expect(fresh).toMatchObject({ nodeCount: 1, nodes: [{ id: "fresh" }] });
  });

  it("reads current selection and classifies open, answered, and orphan questions", async () => {
    const live = makeElements([
      node("hang-lang", "Hạng Lang"),
      node("locked-node", "Locked", 400, 100, { locked: true }),
    ]);
    const fixture = makeApi([
      ...live,
      ...questionElements("q-open", "qt-open", "hang-lang", "Mẹ là ai?"),
      ...questionElements(
        "q-answered",
        "qt-answered",
        "hang-lang",
        "Năm nào?",
        "answered",
      ),
      ...questionElements("q-orphan", "qt-orphan", "missing", "Ai?"),
      ...questionElements("q-locked", "qt-locked", "locked-node", "Gì?"),
      ...questionElements(
        "q-marker-locked",
        "qt-marker-locked",
        "hang-lang",
        "Khóa?",
      ).map((element) =>
        element.id === "q-marker-locked"
          ? ({ ...element, locked: true } as ExcalidrawElement)
          : element,
      ),
    ]);
    fixture.setSelected("hang-lang");
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds(),
    );

    await expect(
      controller.executeTool("get_selection", {}, { signal: signal() }),
    ).resolves.toMatchObject({
      ok: true,
      selected: [
        {
          id: "hang-lang",
          label: "Hạng Lang",
          questions: [{ id: "q-open", text: "Mẹ là ai?" }],
        },
      ],
    });
    await expect(
      controller.executeTool("list_questions", {}, { signal: signal() }),
    ).resolves.toMatchObject({
      ok: true,
      openQuestionCount: 1,
      orphanedQuestionCount: 3,
      questions: [
        {
          id: "q-open",
          nodeId: "hang-lang",
          nodeLabel: "Hạng Lang",
          text: "Mẹ là ai?",
        },
      ],
    });
    fixture.setSelected();
    await expect(
      controller.executeTool("get_selection", {}, { signal: signal() }),
    ).resolves.toMatchObject({ ok: true, selected: [] });
  });

  it("keeps ordinary study nodes that carry unrelated custom data", async () => {
    const fixture = makeApi(
      makeElements([
        node("topic", "Vietnamese history", 100, 100, {
          customData: { topic: "history" },
        }),
      ]),
    );
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds(),
    );

    await expect(
      controller.executeTool("get_chart", {}, { signal: signal() }),
    ).resolves.toMatchObject({
      ok: true,
      nodeCount: 1,
      nodes: [{ id: "topic", label: "Vietnamese history" }],
    });
  });

  it("pins an ordinary question only from a trusted gesture in one undoable write", async () => {
    const fixture = makeApi(makeElements([node("hang-lang", "Hạng Lang")]));
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds("question"),
    );

    const result = controller.pinQuestionFromHuman(
      { isTrusted: true },
      { nodeId: "hang-lang", text: "  Mẹ là ai?  " },
    );

    expect(result).toEqual({ ok: true, questionId: "question-1" });
    expect(fixture.updateScene).toHaveBeenCalledTimes(1);
    expect(fixture.updateScene.mock.calls[0][0].captureUpdate).toBe(
      CaptureUpdateAction.IMMEDIATELY,
    );
    const marker = fixture.getElements().find(({ id }) => id === "question-1")!;
    const text = fixture
      .getElements()
      .find(
        (element) =>
          element.type === "text" && element.containerId === marker.id,
      )!;
    expect(marker).toMatchObject({
      type: "ellipse",
      customData: {
        kind: "question",
        status: "open",
        nodeId: "hang-lang",
      },
    });
    expect(text).toMatchObject({
      type: "text",
      text: "? Mẹ là ai?",
      customData: marker.customData,
    });
    await expect(
      controller.executeTool("list_questions", {}, { signal: signal() }),
    ).resolves.toMatchObject({ questions: [{ id: "question-1" }] });
  });

  it("refuses unsafe pins, the ninth open question, and generated id collisions", () => {
    const base = makeElements([
      node("target", "Target"),
      node("locked", "Locked", 400, 100, { locked: true }),
    ]);
    const opens = Array.from({ length: 7 }, (_, index) =>
      questionElements(
        `q-${index}`,
        `qt-${index}`,
        "target",
        `Question ${index}`,
      ),
    ).flat();
    const fixture = makeApi([...base, ...opens]);
    const generated = ["target", "q-0", "new-q", "new-text", "overflow"];
    const controller = createStudyQuestionController(
      fixture.api as never,
      () => generated.shift()!,
    );

    expect(
      controller.pinQuestionFromHuman(
        { isTrusted: false },
        { nodeId: "target", text: "No" },
      ),
    ).toMatchObject({ ok: false });
    expect(
      controller.pinQuestionFromHuman(
        { isTrusted: true },
        { nodeId: "target", text: "Eighth" },
      ),
    ).toEqual({ ok: true, questionId: "new-q" });
    expect(
      controller.pinQuestionFromHuman(
        { isTrusted: true },
        { nodeId: "target", text: "Ninth" },
      ),
    ).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(
      controller.pinQuestionFromHuman(
        { isTrusted: true },
        { nodeId: "locked", text: "No" },
      ),
    ).toMatchObject({ ok: false });
    expect(fixture.updateScene).toHaveBeenCalledTimes(1);
  });

  it("answers into ordinary elements immediately and preserves unrelated human work", async () => {
    const original = makeElements([
      node("hang-lang", "Hạng Lang", 120, 140),
      node("human-note", "Human moved this", 700, 500),
      {
        id: "human-arrow",
        type: "arrow",
        x: 10,
        y: 10,
        width: 80,
        height: 20,
      },
    ]);
    const fixture = makeApi([
      ...original,
      ...questionElements(
        "q-hang-lang",
        "qt-hang-lang",
        "hang-lang",
        "Mẹ là ai?",
      ),
    ]);
    const unrelatedBefore = structuredClone(
      fixture.getElements().find(({ id }) => id === "human-note"),
    );
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds("answer"),
    );

    const result = await controller.executeTool(
      "answer_question",
      {
        question_id: "q-hang-lang",
        answer: "Hạng Lang là con của Hoàng hậu Dương Vân Nga.",
      },
      { signal: signal() },
    );

    expect(result).toMatchObject({
      ok: true,
      questionId: "q-hang-lang",
      nodeId: "hang-lang",
      answerNodeId: "answer-1",
      status: "answered",
      appliedElementCount: 5,
    });
    expect(fixture.updateScene).toHaveBeenCalledTimes(1);
    expect(fixture.updateScene.mock.calls[0][0].captureUpdate).toBe(
      CaptureUpdateAction.IMMEDIATELY,
    );
    expect(fixture.getElements().find(({ id }) => id === "human-note")).toEqual(
      unrelatedBefore,
    );
    expect(
      fixture.getElements().find(({ id }) => id === "human-arrow"),
    ).toBeTruthy();
    expect(
      fixture.getElements().find(({ id }) => id === "q-hang-lang")?.customData,
    ).toMatchObject({ status: "answered" });
    expect(
      fixture.getElements().find(({ id }) => id === "qt-hang-lang"),
    ).toMatchObject({ text: "✓ Mẹ là ai?" });
    const answer = fixture.getElements().find(({ id }) => id === "answer-1")!;
    expect(answer).toMatchObject({
      type: "rectangle",
      customData: {
        kind: "answer",
        questionId: "q-hang-lang",
        nodeId: "hang-lang",
        createdBy: "ask-the-chart",
      },
    });
    expect(
      fixture
        .getElements()
        .some(
          (element) =>
            element.type === "arrow" &&
            element.startBinding?.elementId === "hang-lang" &&
            element.endBinding?.elementId === "answer-1",
        ),
    ).toBe(true);
  });

  it("uses moved live geometry, avoids overlap deterministically, and refuses a repeat", async () => {
    const fixture = makeApi([
      ...makeElements([
        node("target", "Target", 10, 10),
        node("blocker", "Blocker", 18, 106),
      ]),
      ...questionElements("q", "qt", "target", "Why?"),
    ]);
    fixture.setElements(
      fixture
        .getElements()
        .map((element) =>
          element.id === "target" ? { ...element, x: 500, y: 400 } : element,
        ) as ExcalidrawElement[],
    );
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds("placed"),
    );

    await controller.executeTool(
      "answer_question",
      { question_id: "q", answer: "Because." },
      { signal: signal() },
    );
    const answer = fixture.getElements().find(({ id }) => id === "placed-1")!;
    expect(answer.x).toBeGreaterThanOrEqual(500);
    expect(answer.y).toBeGreaterThan(400);
    fixture.updateScene.mockClear();
    await expect(
      controller.executeTool(
        "answer_question",
        { question_id: "q", answer: "Again." },
        { signal: signal() },
      ),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
    expect(fixture.updateScene).not.toHaveBeenCalled();
  });

  it("fails closed for unknown, orphaned, locked, deleted, and malformed questions", async () => {
    const nodeElements = makeElements([
      node("live", "Live"),
      node("locked", "Locked", 400, 100, { locked: true }),
      node("deleted", "Deleted", 700, 100),
    ]).map((element) =>
      element.id === "deleted"
        ? ({ ...element, isDeleted: true } as ExcalidrawElement)
        : element,
    );
    const fixture = makeApi([
      ...nodeElements,
      ...questionElements("q-orphan", "qt-orphan", "missing", "Why?"),
      ...questionElements("q-locked", "qt-locked", "locked", "Why?"),
      ...questionElements(
        "q-marker-locked",
        "qt-marker-locked",
        "live",
        "Why?",
      ).map((element) =>
        element.id === "q-marker-locked"
          ? ({ ...element, locked: true } as ExcalidrawElement)
          : element,
      ),
      ...questionElements("q-deleted", "qt-deleted", "deleted", "Why?"),
      ...questionElements("q-malformed", "qt-malformed", "live", "Why?").map(
        (element) =>
          element.id === "qt-malformed"
            ? ({ ...element, text: "Not a question" } as ExcalidrawElement)
            : element,
      ),
    ]);
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds(),
    );

    await expect(
      controller.executeTool(
        "answer_question",
        { question_id: "missing", answer: "No" },
        { signal: signal() },
      ),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
    for (const question_id of [
      "q-orphan",
      "q-locked",
      "q-marker-locked",
      "q-deleted",
      "q-malformed",
    ]) {
      await expect(
        controller.executeTool(
          "answer_question",
          { question_id, answer: "No" },
          { signal: signal() },
        ),
      ).resolves.toMatchObject({ ok: false, reason: "unsafe_retry" });
    }
    expect(fixture.updateScene).not.toHaveBeenCalled();
  });

  it("validates exact answer args and aborts before either write boundary", async () => {
    const makeFixture = () =>
      makeApi([
        ...makeElements([node("target", "Target")]),
        ...questionElements("q", "qt", "target", "Why?"),
      ]);
    const fixture = makeFixture();
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds(),
    );
    for (const args of [
      {},
      { question_id: "q", answer: "" },
      { question_id: "q", answer: "A".repeat(601) },
      { question_id: "q", answer: "A", extra: true },
    ]) {
      await expect(
        controller.executeTool("answer_question", args, { signal: signal() }),
      ).resolves.toMatchObject({ ok: false, reason: "invalid_args" });
    }

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      controller.executeTool(
        "answer_question",
        { question_id: "q", answer: "A" },
        { signal: alreadyAborted.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.updateScene).not.toHaveBeenCalled();

    const lateFixture = makeFixture();
    const lateAbort = new AbortController();
    let generated = 0;
    const lateController = createStudyQuestionController(
      lateFixture.api as never,
      () => {
        generated += 1;
        if (generated === 3) {
          lateAbort.abort();
        }
        return `late-${generated}`;
      },
    );
    await expect(
      lateController.executeTool(
        "answer_question",
        { question_id: "q", answer: "A" },
        { signal: lateAbort.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(lateFixture.updateScene).not.toHaveBeenCalled();
  });

  it("keeps every result deeply frozen, bounded, and live after a write", async () => {
    const fixture = makeApi(makeElements([node("node", "Node")]));
    const controller = createStudyQuestionController(
      fixture.api as never,
      makeIds("flow"),
    );
    const pin = controller.pinQuestionFromHuman(
      { isTrusted: true },
      { nodeId: "node", text: "What?" },
    );
    expect(pin).toMatchObject({ ok: true });
    const before = await controller.executeTool(
      "get_selection",
      {},
      {
        signal: signal(),
      },
    );
    fixture.setSelected("node");
    const selected = await controller.executeTool(
      "get_selection",
      {},
      {
        signal: signal(),
      },
    );
    await controller.executeTool(
      "answer_question",
      { question_id: "flow-1", answer: "This." },
      { signal: signal() },
    );
    const questions = await controller.executeTool(
      "list_questions",
      {},
      {
        signal: signal(),
      },
    );
    const chart = await controller.executeTool(
      "get_chart",
      {},
      {
        signal: signal(),
      },
    );

    expect(before).toMatchObject({ selected: [] });
    expect(selected).toMatchObject({ selected: [{ id: "node" }] });
    expect(questions).toMatchObject({ openQuestionCount: 0 });
    expect(chart).toMatchObject({ openQuestionCount: 0, nodeCount: 1 });
    for (const result of [before, selected, questions, chart]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(1536);
    }
  });
});
