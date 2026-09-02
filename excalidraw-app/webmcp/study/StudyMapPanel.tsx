import { useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createStudyQuestionController } from "../study_question_controller";
import { createWebMCPRegistration } from "../webmcp_adapter";

import "./StudyMapPanel.scss";

type StudyController = ReturnType<typeof createStudyQuestionController>;
type HumanGesture = { isTrusted: boolean };

type StudyMapPanelProps = {
  api: ExcalidrawImperativeAPI;
  controller?: StudyController;
  initialWelcomeOpen?: boolean;
};

type QuestionTarget =
  | { ok: true; nodeId: string; label: string }
  | {
      ok: false;
      reason: "human_gesture_required" | "single_study_node_required";
      message: string;
    };

type QuestionForm = {
  nodeId: string;
  label: string;
  draft: string;
};

type PdfMetadata = { name: string; size: number };

const MAX_PASTE_LENGTH = 4000;
const MAX_QUESTION_LENGTH = 280;
const MAX_PDF_NAME_LENGTH = 80;
const STUDY_NODE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStudyNode = (element: ExcalidrawElement) => {
  if (
    element.isDeleted ||
    element.locked ||
    !STUDY_NODE_TYPES.has(element.type)
  ) {
    return false;
  }
  const kind = isRecord(element.customData) ? element.customData.kind : null;
  return kind !== "question" && kind !== "answer";
};

const labelFor = (
  node: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
) => {
  const textId = node.boundElements?.find(({ type }) => type === "text")?.id;
  const text = textId
    ? elements.find(
        (element) =>
          element.id === textId &&
          !element.isDeleted &&
          element.type === "text",
      )
    : null;
  return text?.type === "text" && text.text.trim()
    ? text.text.trim().slice(0, 120)
    : "Selected node";
};

export const resolveQuestionTarget = (
  gesture: HumanGesture,
  api: Pick<ExcalidrawImperativeAPI, "getAppState" | "getSceneElements">,
): QuestionTarget => {
  if (!gesture.isTrusted) {
    return {
      ok: false,
      reason: "human_gesture_required",
      message: "A trusted click is required",
    };
  }
  const selectedIds = Object.entries(api.getAppState().selectedElementIds)
    .filter(([, selected]) => selected)
    .map(([id]) => id);
  if (selectedIds.length !== 1) {
    return {
      ok: false,
      reason: "single_study_node_required",
      message: "Select one unlocked study node",
    };
  }
  const elements = api.getSceneElements();
  const target = elements.find(({ id }) => id === selectedIds[0]);
  if (!target || !isStudyNode(target)) {
    return {
      ok: false,
      reason: "single_study_node_required",
      message: "Select one unlocked study node",
    };
  }
  return { ok: true, nodeId: target.id, label: labelFor(target, elements) };
};

export const submitQuestionFromHuman = (
  controller: Pick<StudyController, "pinQuestionFromHuman">,
  gesture: HumanGesture,
  input: { nodeId: string; text: string },
) => controller.pinQuestionFromHuman(gesture, input);

const sanitizePdf = (file: File): PdfMetadata | null => {
  if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) {
    return null;
  }
  const name = file.name
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .slice(0, MAX_PDF_NAME_LENGTH);
  return { name: name || "source.pdf", size: file.size };
};

const observedToolCount = async (documentObject: Document) => {
  const modelContext = (
    documentObject as Document & {
      modelContext?: { getTools?: () => Promise<unknown> | unknown };
    }
  ).modelContext;
  if (typeof modelContext?.getTools !== "function") {
    return null;
  }
  const value = await modelContext.getTools.call(modelContext);
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isRecord(value) && Array.isArray(value.tools)) {
    return value.tools.length;
  }
  return null;
};

export const StudyMapPanel = ({
  api,
  controller: suppliedController,
  initialWelcomeOpen,
}: StudyMapPanelProps) => {
  const controller = useMemo(
    () => suppliedController ?? createStudyQuestionController(api),
    [api, suppliedController],
  );
  const ownsController = !suppliedController;
  const rootRef = useRef<HTMLDivElement>(null);
  const askPointerTargetRef = useRef<Extract<
    QuestionTarget,
    { ok: true }
  > | null>(null);
  const [welcomeOpen, setWelcomeOpen] = useState(
    initialWelcomeOpen ?? api.getSceneElements().length === 0,
  );
  const [paste, setPaste] = useState("");
  const [pdf, setPdf] = useState<PdfMetadata | null>(null);
  const [question, setQuestion] = useState<QuestionForm | null>(null);
  const [status, setStatus] = useState("Ready to study");
  const [webmcpStatus, setWebmcpStatus] = useState("WebMCP checking…");

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument;
    if (!ownerDocument) {
      return;
    }
    const registration = createWebMCPRegistration(controller, ownerDocument);
    const observationController = new AbortController();
    const observationTimeouts: Array<ReturnType<typeof setTimeout>> = [];
    let active = true;

    const refreshObservedCount = async () => {
      try {
        const count = await observedToolCount(ownerDocument);
        if (active && !observationController.signal.aborted) {
          setWebmcpStatus(
            count === null
              ? "WebMCP count unavailable"
              : `${count} tools observed`,
          );
        }
      } catch {
        if (active && !observationController.signal.aborted) {
          setWebmcpStatus("WebMCP count unavailable");
        }
      }
    };

    void registration.ready.then(async (receipt) => {
      if (!active) {
        return;
      }
      if (!receipt.supported) {
        setWebmcpStatus("WebMCP unavailable in this browser");
        return;
      }
      if (receipt.registered.length !== controller.listTools().length) {
        setWebmcpStatus("WebMCP registration failed safely");
        return;
      }
      await refreshObservedCount();
      for (const delay of [250, 750]) {
        observationTimeouts.push(
          setTimeout(() => void refreshObservedCount(), delay),
        );
      }
    });
    return () => {
      active = false;
      observationController.abort();
      observationTimeouts.forEach(clearTimeout);
      registration.dispose();
      if (ownsController) {
        controller.dispose();
      }
    };
  }, [controller, ownsController]);

  const acceptPdf = (file: File | undefined) => {
    if (!file) {
      return;
    }
    const metadata = sanitizePdf(file);
    if (!metadata) {
      setPdf(null);
      setStatus("Choose one PDF file");
      return;
    }
    setPdf(metadata);
    setStatus("PDF noted locally — source reading comes next");
  };

  const copyTalkPrompt = async () => {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    const clipboard = ownerWindow?.navigator.clipboard;
    if (!ownerWindow || !clipboard?.writeText) {
      setStatus("Copy unavailable — use the prompt shown below");
      return;
    }
    const prompt = `Open Study Map at ${ownerWindow.location.href} in your built-in browser. Call how_to_use first, then help me learn by drawing and answering inside the map.`;
    try {
      await clipboard.writeText(prompt);
      setStatus("Study prompt copied");
    } catch {
      setStatus("Copy unavailable — use the prompt shown below");
    }
  };

  const rememberQuestionTarget = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!event.nativeEvent.isTrusted) {
      askPointerTargetRef.current = null;
      return;
    }
    const target = resolveQuestionTarget({ isTrusted: true }, api);
    askPointerTargetRef.current = target.ok ? target : null;
  };

  const openQuestion = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!event.nativeEvent.isTrusted) {
      askPointerTargetRef.current = null;
      setStatus("A trusted click is required");
      return;
    }
    const remembered = askPointerTargetRef.current;
    askPointerTargetRef.current = null;
    const target = remembered
      ? (() => {
          const elements = api.getSceneElements();
          const live = elements.find(({ id }) => id === remembered.nodeId);
          return live && isStudyNode(live)
            ? {
                ok: true as const,
                nodeId: live.id,
                label: labelFor(live, elements),
              }
            : {
                ok: false as const,
                reason: "single_study_node_required" as const,
                message: "Select one unlocked study node",
              };
        })()
      : resolveQuestionTarget({ isTrusted: true }, api);
    if (!target.ok) {
      setStatus(target.message);
      return;
    }
    setQuestion({ nodeId: target.nodeId, label: target.label, draft: "" });
    setStatus(`Question for ${target.label}`);
  };

  const submitQuestion = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!question) {
      return;
    }
    const result = submitQuestionFromHuman(
      controller,
      { isTrusted: event.nativeEvent.isTrusted },
      { nodeId: question.nodeId, text: question.draft },
    );
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setStatus(`Question ${result.questionId} pinned — answer lands directly`);
    setQuestion(null);
  };

  return (
    <div ref={rootRef} className="study-map" data-testid="study-map-panel">
      {welcomeOpen ? (
        <section
          className="study-map__welcome"
          aria-labelledby="study-map-welcome-title"
        >
          <div className="study-map__welcome-card">
            <p className="study-map__wordmark">Study Map</p>
            <h1 id="study-map-welcome-title">What are you learning today?</h1>
            <p className="study-map__tagline">
              Learn anything as a map you and ChatGPT draw together.
            </p>
            <label className="study-map__paste">
              <span>Paste what you are learning</span>
              <textarea
                aria-label="Paste what you are learning"
                maxLength={MAX_PASTE_LENGTH}
                value={paste}
                onChange={(event) =>
                  setPaste(event.currentTarget.value.slice(0, MAX_PASTE_LENGTH))
                }
                placeholder="A paragraph, notes, or a topic…"
              />
              <small>
                {paste.length} / {MAX_PASTE_LENGTH}
              </small>
            </label>
            <div className="study-map__source-actions">
              <label
                className="study-map__pdf"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  acceptPdf(event.dataTransfer.files[0]);
                }}
              >
                <span>Drop a PDF</span>
                <input
                  aria-label="Choose a PDF"
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={(event) =>
                    acceptPdf(event.currentTarget.files?.[0])
                  }
                />
              </label>
              <button type="button" onClick={() => void copyTalkPrompt()}>
                Talk to ChatGPT
              </button>
            </div>
            {pdf ? (
              <p className="study-map__pdf-note">
                {pdf.name} · {pdf.size} bytes — kept local; reading comes next.
              </p>
            ) : null}
            <button
              className="study-map__blank"
              type="button"
              onClick={() => setWelcomeOpen(false)}
            >
              Open a blank study map
            </button>
          </div>
        </section>
      ) : null}

      <aside className="study-map__question-panel" aria-label="Study questions">
        <button
          type="button"
          onPointerDown={rememberQuestionTarget}
          onClick={openQuestion}
        >
          ? Ask about selected node
        </button>
        {question ? (
          <form onSubmit={submitQuestion} aria-label="Ask about node">
            <strong>{question.label}</strong>
            <label>
              <span>Question</span>
              <input
                aria-label="Question"
                autoFocus
                maxLength={MAX_QUESTION_LENGTH}
                value={question.draft}
                onChange={(event) =>
                  setQuestion({
                    ...question,
                    draft: event.currentTarget.value.slice(
                      0,
                      MAX_QUESTION_LENGTH,
                    ),
                  })
                }
              />
            </label>
            <div>
              <button type="submit" disabled={!question.draft.trim()}>
                Ask
              </button>
              <button type="button" onClick={() => setQuestion(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
        <small className="study-map__webmcp">{webmcpStatus}</small>
        <output aria-live="polite">{status}</output>
      </aside>
    </div>
  );
};
