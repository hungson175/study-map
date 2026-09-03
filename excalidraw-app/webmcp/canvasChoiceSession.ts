import type { ToolFailure } from "./tool_registry";

export const AGENT_TOOL_ONLY_RULE =
  "Use only registered page tools (how_to_use, get_chart, get_selection, list_questions, answer_question, create_shapes, connect_shapes, align_shapes, equalize_size, distribute_shapes, create_canvas, open_saved_canvas) for all map reads/writes. Do not click, drag, type into, or operate Excalidraw UI controls; the page's pointer/keyboard controls remain for the person.";

export type CanvasChoice = "continue_existing" | "create_new";
export type CanvasChoiceState =
  | "pending_choice"
  | "continue"
  | "new_pending_create";

export type CanvasChoiceSession = {
  begin: (hasLiveContent: boolean) => CanvasChoiceState;
  choose: (
    choice: CanvasChoice,
    hasLiveContent: boolean,
  ) => { ok: true; state: CanvasChoiceState } | ToolFailure;
  guard: (tool: string) => ToolFailure | null;
  markCanvasCreated: () => void;
  getState: () => CanvasChoiceState;
};

const sessions = new WeakMap<object, CanvasChoiceSession>();

export const canvasChoiceSessionFor = (api: object): CanvasChoiceSession => {
  const existing = sessions.get(api);
  if (existing) {
    return existing;
  }
  let state: CanvasChoiceState = "pending_choice";
  let began = false;

  const session: CanvasChoiceSession = {
    begin: (hasLiveContent) => {
      if (!began) {
        began = true;
        state = hasLiveContent ? "pending_choice" : "continue";
      }
      return state;
    },
    choose: (choice, hasLiveContent) => {
      if (!began) {
        return {
          ok: false,
          reason: "invalid_args",
          message: "Call how_to_use before choosing a canvas",
        };
      }
      if (choice === "continue_existing" && !hasLiveContent) {
        return {
          ok: false,
          reason: "invalid_args",
          message: "There is no existing canvas to continue",
        };
      }
      state =
        choice === "continue_existing" ? "continue" : "new_pending_create";
      return { ok: true, state };
    },
    guard: (tool) => {
      if (state === "pending_choice") {
        return {
          ok: false,
          reason: "unsafe_retry",
          message: "Choose a canvas first",
        };
      }
      if (state === "new_pending_create" && tool !== "create_canvas") {
        return {
          ok: false,
          reason: "unsafe_retry",
          message: "Create a new canvas first",
        };
      }
      return null;
    },
    markCanvasCreated: () => {
      began = true;
      state = "continue";
    },
    getState: () => state,
  };
  sessions.set(api, session);
  return session;
};
