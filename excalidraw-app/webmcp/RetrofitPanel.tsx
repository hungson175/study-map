import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasChoiceSessionFor } from "./canvasChoiceSession";
import { createRetrofitController } from "./retrofit_controller";
import { createWebMCPRegistration } from "./webmcp_adapter";
import {
  PLAIN_REPLAY_REQUEST_EVENT,
  PLAIN_REPLAY_STATUS_EVENT,
  runPlainReplay,
} from "./plain_replay";
import { RecordingHud } from "./RecordingHud";
import { RegistryPalette } from "./RegistryPalette";
import "./RetrofitPanel.scss";

import type {
  RetrofitController,
  RetrofitSnapshot,
} from "./retrofit_controller";

type RetrofitPanelProps = {
  api: ExcalidrawImperativeAPI;
  controller?: RetrofitController;
};

export const RetrofitPanel = ({
  api,
  controller: supplied,
}: RetrofitPanelProps) => {
  const canvasChoiceSession = useMemo(() => canvasChoiceSessionFor(api), [api]);
  const controller = useMemo(
    () =>
      supplied ??
      createRetrofitController(api, {
        writeMode: "immediate",
        canvasChoiceSession,
      }),
    [api, canvasChoiceSession, supplied],
  );
  const isImmediate = controller.getWriteMode() === "immediate";
  const rootRef = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<RetrofitSnapshot>(
    controller.getSnapshot(),
  );
  const [, refreshViewport] = useState(0);
  const [message, setMessage] = useState(
    isImmediate
      ? "Agent writes land directly and stay undoable. Drag, edit, delete or Undo anytime."
      : "Agent changes stay staged until you commit.",
  );
  const [webmcpStatus, setWebmcpStatus] = useState("WEBMCP …");

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument;
    if (!ownerDocument) {
      setWebmcpStatus("WEBMCP ERROR");
      return;
    }
    const registration = createWebMCPRegistration(controller, ownerDocument);
    let active = true;
    void registration.ready.then((receipt) => {
      if (!active) {
        return;
      }
      setWebmcpStatus(
        receipt.supported
          ? receipt.registered.length === controller.listTools().length
            ? "WEBMCP READY"
            : "WEBMCP ERROR"
          : "WEBMCP UNAVAILABLE",
      );
    });
    return () => {
      active = false;
      registration.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const refresh = () => refreshViewport((value) => value + 1);
    const unsubscribeChange = api.onChange(refresh);
    const unsubscribeScroll = api.onScrollChange(refresh);
    return () => {
      unsubscribeChange();
      unsubscribeScroll();
      if (!supplied) {
        controller.dispose();
      }
    };
  }, [api, controller, supplied]);

  useEffect(() => {
    let active: AbortController | null = null;
    let runSequence = 0;
    const publish = (detail: unknown) =>
      window.dispatchEvent(
        new CustomEvent(PLAIN_REPLAY_STATUS_EVENT, { detail }),
      );
    const startReplay = () => {
      active?.abort();
      const sequence = ++runSequence;
      const abort = new AbortController();
      active = abort;
      setMessage("Explicit local replay running — not a native agent.");
      publish({ state: "running", completedSteps: 0 });
      void runPlainReplay(controller, {
        signal: abort.signal,
        onStep: ({ completedSteps }) => {
          if (sequence === runSequence) {
            setMessage(
              `Explicit local replay ${completedSteps}/5 — not a native agent.`,
            );
          }
        },
      }).then((result) => {
        if (sequence !== runSequence) {
          return;
        }
        active = null;
        setMessage(
          result.ok
            ? isImmediate
              ? "Explicit local replay applied directly — not a native agent. Every write remains undoable."
              : "Explicit local replay staged — not a native agent. Review amber changes, then commit yourself."
            : `Local replay stopped after ${result.completedSteps}/5: ${result.message}`,
        );
        publish(result);
      });
    };
    window.addEventListener(PLAIN_REPLAY_REQUEST_EVENT, startReplay);
    return () => {
      runSequence += 1;
      active?.abort();
      window.removeEventListener(PLAIN_REPLAY_REQUEST_EVENT, startReplay);
    };
  }, [controller, isImmediate]);

  const appState = api.getAppState();
  const zoom = appState.zoom.value;
  const isFilm =
    new URLSearchParams(window.location.search).get("film") === "1";

  const humanAction = (
    event: React.MouseEvent<HTMLButtonElement>,
    action: "commit" | "discard",
  ) => {
    const gesture = { isTrusted: event.nativeEvent.isTrusted };
    const result =
      action === "commit"
        ? controller.commitFromHuman(gesture)
        : controller.discardFromHuman(gesture);
    if (!result.ok) {
      setMessage(
        result.reason === "human_gesture_required"
          ? "Human click required"
          : result.reason === "unsafe_retry"
          ? "Drawing changed. Review and stage again."
          : "Nothing is waiting for review.",
      );
      return;
    }
    setMessage(action === "commit" ? "Layout committed" : "Preview discarded");
  };

  return (
    <>
      {!isImmediate ? (
        <svg
          className="webmcp-retrofit__ghosts"
          data-ghost-overlay="true"
          aria-hidden="true"
          style={{ pointerEvents: "none" }}
        >
          <defs>
            <marker
              id="webmcp-arrowhead"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {snapshot.pending?.elements.map((element) => {
            if (element.type === "arrow" && element.points.length >= 2) {
              const start = element.points[0];
              const end = element.points[element.points.length - 1];
              const startPoint = sceneCoordsToViewportCoords(
                {
                  sceneX: element.x + start[0],
                  sceneY: element.y + start[1],
                },
                appState,
              );
              const endPoint = sceneCoordsToViewportCoords(
                {
                  sceneX: element.x + end[0],
                  sceneY: element.y + end[1],
                },
                appState,
              );
              return (
                <line
                  key={element.id}
                  data-ghost="true"
                  data-ghost-connector="true"
                  x1={startPoint.x}
                  y1={startPoint.y}
                  x2={endPoint.x}
                  y2={endPoint.y}
                  markerEnd="url(#webmcp-arrowhead)"
                />
              );
            }
            const point = sceneCoordsToViewportCoords(
              { sceneX: element.x, sceneY: element.y },
              appState,
            );
            const width = element.width * zoom;
            const height = element.height * zoom;
            const centerX = point.x + width / 2;
            const centerY = point.y + height / 2;
            const transform = element.angle
              ? `rotate(${
                  element.angle * (180 / Math.PI)
                } ${centerX} ${centerY})`
              : undefined;
            if (element.type === "ellipse") {
              return (
                <ellipse
                  key={element.id}
                  data-ghost="true"
                  cx={centerX}
                  cy={centerY}
                  rx={width / 2}
                  ry={height / 2}
                  transform={transform}
                />
              );
            }
            if (element.type === "diamond") {
              return (
                <polygon
                  key={element.id}
                  data-ghost="true"
                  points={`${centerX},${point.y} ${
                    point.x + width
                  },${centerY} ${centerX},${point.y + height} ${
                    point.x
                  },${centerY}`}
                  transform={transform}
                />
              );
            }
            if (element.type === "text") {
              return (
                <text
                  key={element.id}
                  data-ghost="true"
                  x={centerX}
                  y={centerY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={element.fontSize * zoom}
                  transform={transform}
                >
                  {element.originalText}
                </text>
              );
            }
            return (
              <rect
                key={element.id}
                data-ghost="true"
                x={point.x}
                y={point.y}
                width={width}
                height={height}
                rx={8}
                transform={transform}
              />
            );
          })}
        </svg>
      ) : null}

      {isFilm ? (
        <RecordingHud
          api={api}
          controller={controller}
          snapshot={snapshot}
          webmcpLabel={webmcpStatus}
        />
      ) : null}

      <aside
        ref={rootRef}
        className="webmcp-retrofit"
        aria-label={
          isImmediate ? "Agent drawing tools" : "Agent layout preview"
        }
      >
        <header>
          <strong>Agent layout</strong>
          <div className="webmcp-retrofit__status" aria-live="polite">
            <span className="is-idle">{webmcpStatus}</span>
            <span
              className={
                !isImmediate && snapshot.pending ? "is-pending" : "is-idle"
              }
            >
              {!isImmediate && snapshot.pending ? "UNCOMMITTED" : "READY"}
            </span>
          </div>
        </header>
        <p>
          {!isImmediate && snapshot.pending
            ? `${
                snapshot.pending.elements.length
              } shapes · ${snapshot.pending.operations.join(" → ")}`
            : `${snapshot.selectedIds.length} shapes selected`}
        </p>
        <RegistryPalette controller={controller} snapshot={snapshot} />
        {!isImmediate ? (
          <div className="webmcp-retrofit__actions">
            <button
              id="commit-layout"
              type="button"
              disabled={!snapshot.pending}
              onClick={(event) => humanAction(event, "commit")}
            >
              Commit layout
            </button>
            <button
              id="discard-layout"
              type="button"
              disabled={!snapshot.pending}
              onClick={(event) => humanAction(event, "discard")}
            >
              Discard
            </button>
          </div>
        ) : null}
        <small aria-live="polite">{message}</small>
      </aside>
    </>
  );
};
