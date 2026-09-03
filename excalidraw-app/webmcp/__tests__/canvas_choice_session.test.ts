import { describe, expect, it, vi } from "vitest";

import {
  AGENT_TOOL_ONLY_RULE,
  canvasChoiceSessionFor,
} from "../canvasChoiceSession";
import { createCanvasToolController } from "../product/canvas_tools";
import { createRetrofitController } from "../retrofit_controller";
import { createStudyQuestionController } from "../study_question_controller";

const abortSignal = () => new AbortController().signal;

const legacyRectangle = {
  id: "legacy-node",
  type: "rectangle",
  x: 40,
  y: 40,
  width: 160,
  height: 80,
  angle: 0,
  version: 1,
  versionNonce: 2,
  isDeleted: false,
  locked: false,
  boundElements: null,
};

const makeFixture = () => {
  let elements = [structuredClone(legacyRectangle)];
  let metadata: { id?: string; name: string } = {
    id: "old-canvas",
    name: "Existing study",
  };
  const updateScene = vi.fn(
    (update: { elements: typeof elements; captureUpdate?: unknown }) => {
      elements = structuredClone(update.elements);
    },
  );
  const api = {
    addFiles: vi.fn(),
    getFiles: vi.fn(() => ({})),
    getSceneElements: () => elements.filter(({ isDeleted }) => !isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({ selectedElementIds: {} }),
    updateScene,
  };
  const session = canvasChoiceSessionFor(api);
  const study = createStudyQuestionController(api as never, {
    canvasChoiceSession: session,
    idFactory: (() => {
      let id = 0;
      return () => `choice-${++id}`;
    })(),
  });
  const retrofit = createRetrofitController(api as never, {
    writeMode: "immediate",
    canvasChoiceSession: session,
  });
  const store = {
    save: vi.fn(async ({ name }: { name: string }) => ({
      id: "saved-old",
      name,
      updatedAt: "2026-09-03T01:00:00.000Z",
      elementCount: elements.filter(({ isDeleted }) => !isDeleted).length,
    })),
    load: vi.fn(async () => ({
      id: "saved-target",
      name: "Saved target",
      elements: [legacyRectangle],
      files: {},
      updatedAt: "2026-09-03T01:00:00.000Z",
      elementCount: 1,
    })),
    list: vi.fn(async () => []),
    rename: vi.fn(),
    delete: vi.fn(),
  };
  const canvas = createCanvasToolController({
    api: api as never,
    store: store as never,
    getMetadata: () => metadata,
    setMetadata: (next) => {
      metadata = next;
    },
    setStatus: vi.fn(),
    showWorkspace: vi.fn(),
    canvasChoiceSession: session,
  });
  const runStudy = (name: string, args: unknown = {}) =>
    study.executeTool(name, args, { signal: abortSignal() });
  const runRetrofit = (name: string, args: unknown = {}) =>
    retrofit.executeTool(name, args, { signal: abortSignal() });
  const runCanvas = (name: string, args: unknown = {}) =>
    canvas.executeTool(name, args, { signal: abortSignal() });

  return {
    api,
    canvas,
    getElements: () => elements,
    retrofit,
    runCanvas,
    runRetrofit,
    runStudy,
    session,
    store,
    study,
    updateScene,
  };
};

describe("Study Map canvas choice session", () => {
  it("refuses a canvas choice before how_to_use starts the session", () => {
    const fixture = makeFixture();

    expect(fixture.session.choose("continue_existing", true)).toEqual({
      ok: false,
      reason: "invalid_args",
      message: "Call how_to_use before choosing a canvas",
    });
    expect(fixture.session.getState()).toBe("pending_choice");
    expect(fixture.updateScene).not.toHaveBeenCalled();
  });

  it("refuses continue_existing when the live canvas is empty", async () => {
    const api = {
      getSceneElements: () => [],
      getSceneElementsIncludingDeleted: () => [],
      getAppState: () => ({ selectedElementIds: {} }),
      updateScene: vi.fn(),
    };
    const session = canvasChoiceSessionFor(api);
    const controller = createStudyQuestionController(api as never, {
      canvasChoiceSession: session,
    });

    await controller.executeTool("how_to_use", {}, { signal: abortSignal() });
    expect(session.choose("continue_existing", false)).toEqual({
      ok: false,
      reason: "invalid_args",
      message: "There is no existing canvas to continue",
    });
    expect(session.getState()).toBe("continue");
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("is API-keyed and gates any live legacy shape with exact bounded guidance", async () => {
    const fixture = makeFixture();

    expect(canvasChoiceSessionFor(fixture.api)).toBe(fixture.session);
    const guide = await fixture.runStudy("how_to_use");

    expect(guide).toMatchObject({
      ok: true,
      state: "canvas_choice_required",
      canvas_choice_required: true,
      choices: ["continue_existing", "create_new"],
      say_to_user:
        "I found a map already here. Do you want to continue with it, or start a new Study Map? I won't change it until you choose.",
    });
    expect((guide as unknown as { next_step: string }).next_step).toContain(
      AGENT_TOOL_ONLY_RULE,
    );
    expect(Object.isFrozen(guide)).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(guide)).byteLength,
    ).toBeLessThan(2000);
    expect(fixture.updateScene).not.toHaveBeenCalled();
  });

  it("ignores deleted collapse tombstones when deciding whether a canvas exists", async () => {
    const tombstoneApi = {
      getSceneElements: () => [],
      getSceneElementsIncludingDeleted: () => [
        {
          ...legacyRectangle,
          id: "hidden",
          isDeleted: true,
          customData: { studyMapHiddenBy: "root" },
        },
      ],
      getAppState: () => ({ selectedElementIds: {} }),
      updateScene: vi.fn(),
    };
    const session = canvasChoiceSessionFor(tombstoneApi);
    const controller = createStudyQuestionController(tombstoneApi as never, {
      canvasChoiceSession: session,
    });

    await expect(
      controller.executeTool("how_to_use", {}, { signal: abortSignal() }),
    ).resolves.toMatchObject({ ok: true, state: "empty" });
  });

  it("blocks all registered writes until an explicit continue choice", async () => {
    const fixture = makeFixture();
    await fixture.runStudy("how_to_use");

    const before = structuredClone(fixture.getElements());
    const blocked: Array<[string, () => Promise<unknown>]> = [
      [
        "create_shapes",
        () =>
          fixture.runRetrofit("create_shapes", {
            shapes: [
              { clientId: "blocked", type: "rectangle", label: "Blocked" },
            ],
          }),
      ],
      [
        "connect_shapes",
        () =>
          fixture.runRetrofit("connect_shapes", {
            sourceIds: ["legacy-node"],
            targetId: "legacy-node",
          }),
      ],
      [
        "align_shapes",
        () => fixture.runRetrofit("align_shapes", { edge: "left" }),
      ],
      [
        "equalize_size",
        () => fixture.runRetrofit("equalize_size", { dimension: "width" }),
      ],
      [
        "distribute_shapes",
        () => fixture.runRetrofit("distribute_shapes", { axis: "horizontal" }),
      ],
      [
        "answer_question",
        () =>
          fixture.runStudy("answer_question", {
            question_id: "missing",
            answer_summary: "Blocked",
            key_points: ["Blocked"],
          }),
      ],
      [
        "create_canvas",
        () => fixture.runCanvas("create_canvas", { name: "Not chosen" }),
      ],
      [
        "open_saved_canvas",
        () => fixture.runCanvas("open_saved_canvas", { id: "saved-target" }),
      ],
    ];
    for (const [name, invoke] of blocked) {
      await expect(invoke(), name).resolves.toEqual({
        ok: false,
        reason: "unsafe_retry",
        message: "Choose a canvas first",
      });
    }
    expect(fixture.getElements()).toEqual(before);
    expect(fixture.updateScene).not.toHaveBeenCalled();

    await expect(
      fixture.runStudy("choose_canvas", { choice: "continue_existing" }),
    ).resolves.toMatchObject({ ok: true, state: "continue" });
    await expect(
      fixture.runRetrofit("create_shapes", {
        shapes: [{ clientId: "allowed", type: "rectangle", label: "Allowed" }],
      }),
    ).resolves.toMatchObject({ ok: true, status: "applied", createdCount: 1 });
    expect(fixture.getElements()).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Allowed" })]),
    );
  });

  it("requires create_canvas after create_new and blocks every alternate writer", async () => {
    const fixture = makeFixture();
    await fixture.runStudy("how_to_use");
    await expect(
      fixture.runStudy("choose_canvas", { choice: "create_new" }),
    ).resolves.toMatchObject({ ok: true, state: "new_pending_create" });

    const blocked: Array<[string, () => Promise<unknown>]> = [
      [
        "create_shapes",
        () =>
          fixture.runRetrofit("create_shapes", {
            shapes: [{ type: "rectangle", label: "No" }],
          }),
      ],
      [
        "connect_shapes",
        () =>
          fixture.runRetrofit("connect_shapes", {
            sourceIds: ["legacy-node"],
            targetId: "legacy-node",
          }),
      ],
      [
        "align_shapes",
        () => fixture.runRetrofit("align_shapes", { edge: "left" }),
      ],
      [
        "equalize_size",
        () => fixture.runRetrofit("equalize_size", { dimension: "width" }),
      ],
      [
        "distribute_shapes",
        () => fixture.runRetrofit("distribute_shapes", { axis: "horizontal" }),
      ],
      [
        "answer_question",
        () =>
          fixture.runStudy("answer_question", {
            question_id: "missing",
            answer_summary: "No",
            key_points: ["No"],
          }),
      ],
      [
        "open_saved_canvas",
        () => fixture.runCanvas("open_saved_canvas", { id: "saved-target" }),
      ],
    ];
    for (const [name, invoke] of blocked) {
      await expect(invoke(), name).resolves.toEqual({
        ok: false,
        reason: "unsafe_retry",
        message: "Create a new canvas first",
      });
    }
    expect(fixture.updateScene).not.toHaveBeenCalled();

    await expect(
      fixture.runCanvas("create_canvas", { name: "Fresh study" }),
    ).resolves.toMatchObject({
      ok: true,
      name: "Fresh study",
      elementCount: 0,
      previousCanvasSaved: true,
    });
    expect(fixture.store.save).toHaveBeenCalledOnce();
    expect(fixture.getElements().filter(({ isDeleted }) => !isDeleted)).toEqual(
      [],
    );
    await expect(
      fixture.runRetrofit("create_shapes", {
        shapes: [{ clientId: "fresh", type: "rectangle", label: "Fresh" }],
      }),
    ).resolves.toMatchObject({ ok: true, status: "applied", createdCount: 1 });
  });

  it("rejects an inferred or malformed choice without changing session or scene", async () => {
    const fixture = makeFixture();
    await fixture.runStudy("how_to_use");

    for (const args of [
      {},
      { choice: "continue" },
      { choice: "continue_existing", extra: true },
    ]) {
      await expect(
        fixture.runStudy("choose_canvas", args),
      ).resolves.toMatchObject({
        ok: false,
        reason: "invalid_args",
      });
    }
    expect(fixture.session.getState()).toBe("pending_choice");
    expect(fixture.updateScene).not.toHaveBeenCalled();
  });
});
