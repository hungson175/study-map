import {
  CaptureUpdateAction,
  exportToBlob,
  MIME_TYPES,
} from "@excalidraw/excalidraw";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  WEBMCP_TOOL_ACTIVITY_EVENT,
  type WebMCPToolActivity,
} from "../tool_activity";
import { createWebMCPRegistration } from "../webmcp_adapter";
import { STUDY_MAP_START_PROMPT } from "../study/study_map_prompt";

import { createCanvasToolController } from "./canvas_tools";
import {
  getLocalDiagramStore,
  type DiagramStore,
  type DiagramSummary,
  type StoredElement,
  type StoredFiles,
} from "./diagram_store";
import {
  decodeSharedScene,
  encodeSharedScene,
  shareFragment,
} from "./share_scene";
import "./ProductShell.scss";

type ProductShellProps = {
  api: ExcalidrawImperativeAPI;
  store?: DiagramStore;
};

type ProductView = "workspace" | "library";

const readRoute = () => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const requested = params.get("view");
  const view: ProductView =
    requested === "library" && !params.has("share") ? "library" : "workspace";
  return { view, share: params.get("share") };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sceneElements = (api: ExcalidrawImperativeAPI) =>
  (typeof api.getSceneElementsIncludingDeleted === "function"
    ? api.getSceneElementsIncludingDeleted()
    : api.getSceneElements()
  ).filter(
    (element) =>
      !element.isDeleted ||
      (isRecord(element.customData) &&
        typeof element.customData.studyMapHiddenBy === "string"),
  ) as unknown as StoredElement[];

const sceneFiles = (api: ExcalidrawImperativeAPI) =>
  api.getFiles() as unknown as StoredFiles;

const safeFilename = (name: string) =>
  `${
    name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 60) || "study-map"
  }.png`;

export const ProductShell = ({
  api,
  store: suppliedStore,
}: ProductShellProps) => {
  const store = useMemo(
    () => suppliedStore ?? getLocalDiagramStore(),
    [suppliedStore],
  );
  const initialRoute = useMemo(readRoute, []);
  const [view, setView] = useState<ProductView>(initialRoute.view);
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("Untitled study map");
  const [currentId, setCurrentId] = useState<string | undefined>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");
  const [shareUrl, setShareUrl] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const importedShare = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const metadataRef = useRef<{ id?: string; name: string }>({ name });
  metadataRef.current = { id: currentId, name };

  const go = useCallback((next: ProductView) => {
    const params = new URLSearchParams();
    if (next === "library") {
      params.set("view", "library");
    }
    const fragment = params.toString();
    window.history.pushState(
      {},
      "",
      `${window.location.pathname}${window.location.search}${
        fragment ? `#${fragment}` : ""
      }`,
    );
    setView(next);
    setStatus("Ready");
  }, []);

  const canvasToolController = useMemo(
    () =>
      createCanvasToolController({
        api,
        store,
        getMetadata: () => metadataRef.current,
        setMetadata: (metadata) => {
          setCurrentId(metadata.id);
          setName(metadata.name);
        },
        setStatus,
        showWorkspace: () => go("workspace"),
      }),
    [api, go, store],
  );

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument;
    if (!ownerDocument) {
      return;
    }
    const registration = createWebMCPRegistration(
      canvasToolController,
      ownerDocument,
    );
    return () => {
      registration.dispose();
      canvasToolController.dispose();
    };
  }, [canvasToolController]);

  useEffect(() => {
    const routeChanged = () => setView(readRoute().view);
    window.addEventListener("hashchange", routeChanged);
    window.addEventListener("popstate", routeChanged);
    return () => {
      window.removeEventListener("hashchange", routeChanged);
      window.removeEventListener("popstate", routeChanged);
    };
  }, []);

  useLayoutEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerDocument || !ownerWindow) {
      return;
    }
    const revealAgentWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<WebMCPToolActivity>).detail;
      if (
        detail?.state !== "running" ||
        typeof detail.tool !== "string" ||
        !detail.tool
      ) {
        return;
      }
      ownerWindow.history.replaceState(
        {},
        "",
        `${ownerWindow.location.pathname}${ownerWindow.location.search}`,
      );
      setView("workspace");
      setStatus(`Agent is staging ${detail.tool}…`);
    };
    ownerDocument.addEventListener(
      WEBMCP_TOOL_ACTIVITY_EVENT,
      revealAgentWorkspace,
    );
    return () =>
      ownerDocument.removeEventListener(
        WEBMCP_TOOL_ACTIVITY_EVENT,
        revealAgentWorkspace,
      );
  }, []);

  useEffect(() => {
    const { share } = readRoute();
    if (!share || importedShare.current === share) {
      return;
    }
    const decoded = decodeSharedScene(share);
    if (!decoded.ok) {
      importedShare.current = share;
      setStatus(decoded.message);
      return;
    }
    const applySharedScene = () => {
      if (api.getAppState().isLoading) {
        return false;
      }
      api.addFiles(decoded.scene.files as never);
      api.updateScene({
        elements: decoded.scene.elements as never,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      importedShare.current = share;
      setName(decoded.scene.name ?? "Shared study map");
      setCurrentId(undefined);
      setStatus("Shared study map opened locally");
      return true;
    };
    if (applySharedScene()) {
      return;
    }
    setStatus("Opening shared study map…");
    let unsubscribe: () => void = () => undefined;
    unsubscribe = api.onChange(() => {
      if (applySharedScene()) {
        unsubscribe();
      }
    });
    return unsubscribe;
  }, [api, view]);

  const refreshDiagrams = useCallback(async () => {
    setDiagrams(await store.list());
  }, [store]);

  useEffect(() => {
    if (view === "library") {
      void refreshDiagrams();
    }
  }, [refreshDiagrams, view]);

  const saveDiagram = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const saved = await store.save({
        ...(currentId ? { id: currentId } : {}),
        name,
        elements: sceneElements(api),
        files: sceneFiles(api),
      });
      setCurrentId(saved.id);
      setName(saved.name);
      setStatus("Saved to this browser");
      setSaveOpen(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed safely");
    }
  };

  const openDiagram = async (id: string) => {
    const record = await store.load(id);
    if (!record) {
      setStatus("That saved study map is no longer available");
      await refreshDiagrams();
      return;
    }
    api.addFiles(record.files as never);
    api.updateScene({ elements: record.elements as never });
    setCurrentId(record.id);
    setName(record.name);
    go("workspace");
    setStatus(`Opened ${record.name}`);
  };

  const renameDiagram = async (id: string) => {
    try {
      const renamed = await store.rename(id, editingName);
      if (!renamed) {
        setStatus("That saved study map is no longer available");
      } else {
        setStatus("Study map renamed");
      }
      setEditingId(null);
      await refreshDiagrams();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Rename failed safely",
      );
    }
  };

  const deleteDiagram = async (id: string) => {
    const deleted = await store.delete(id);
    setDeleteId(null);
    setStatus(
      deleted ? "Study map deleted" : "Study map was already unavailable",
    );
    await refreshDiagrams();
  };

  const createShareLink = async () => {
    try {
      const token = encodeSharedScene({
        name,
        elements: sceneElements(api),
        files: sceneFiles(api),
      });
      const url = `${window.location.href.split("#")[0]}${shareFragment(
        token,
      )}`;
      setShareUrl(url);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setStatus("Share link copied — the study map is inside the URL");
      } else {
        setStatus("Share link ready — copy it below");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Share failed safely");
    }
  };

  const exportPng = async () => {
    const elements = api
      .getSceneElements()
      .filter(({ isDeleted }) => !isDeleted);
    if (!elements.length) {
      setStatus("Draw something before exporting");
      return;
    }
    try {
      const blob = await exportToBlob({
        elements: elements as never,
        appState: {
          ...api.getAppState(),
          exportBackground: true,
        } as never,
        files: api.getFiles(),
        mimeType: MIME_TYPES.png,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = safeFilename(name);
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("Study map exported as PNG");
    } catch {
      setStatus("Image export failed safely");
    }
  };

  const copyDemoPrompt = async () => {
    const clipboard =
      rootRef.current?.ownerDocument.defaultView?.navigator.clipboard;
    if (!clipboard?.writeText) {
      setPromptCopied(false);
      setStatus("Copy unavailable — select the prompt manually");
      return;
    }
    try {
      await clipboard.writeText(STUDY_MAP_START_PROMPT);
      setPromptCopied(true);
      setStatus("Prompt copied");
    } catch {
      setPromptCopied(false);
      setStatus("Copy unavailable — select the prompt manually");
    }
  };

  return (
    <div ref={rootRef} className="product-shell" data-product-view={view}>
      <nav
        className="product-shell__workspace-nav"
        aria-label="Study map workspace"
      >
        <span className="product-shell__wordmark">Study Map</span>
        <div>
          <button
            type="button"
            className="product-shell__copy-prompt"
            onClick={() => void copyDemoPrompt()}
            aria-label={
              promptCopied ? "Prompt copied" : "Copy Study Map prompt"
            }
            title={promptCopied ? "Prompt copied" : "Copy Study Map prompt"}
          >
            {promptCopied ? (
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="m3 8.5 3 3 7-7" />
              </svg>
            ) : (
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                <path d="M10.5 5.5v-2h-7v7h2" />
              </svg>
            )}
            <span>{promptCopied ? "Copied" : "Copy prompt"}</span>
          </button>
          <button type="button" onClick={() => go("library")}>
            Your study maps
          </button>
          <button type="button" onClick={() => setSaveOpen(true)}>
            Save study map
          </button>
          <button type="button" onClick={() => void createShareLink()}>
            Share study map
          </button>
          <button type="button" onClick={() => void exportPng()}>
            Export study map
          </button>
        </div>
      </nav>

      {view === "library" ? (
        <main
          className="product-shell__page"
          aria-labelledby="diagram-library-title"
        >
          <header>
            <p className="product-shell__eyebrow">NO STUDY MAP BACKEND</p>
            <h1 id="diagram-library-title">Your study maps</h1>
            <p>
              Open, rename, or delete maps saved in this browser. Agent tool
              results go to the model provider when invoked.
            </p>
          </header>
          {diagrams.length ? (
            <ul className="product-shell__diagram-grid">
              {diagrams.map((diagram) => (
                <li key={diagram.id}>
                  {editingId === diagram.id ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void renameDiagram(diagram.id);
                      }}
                    >
                      <label>
                        <span>New study map name</span>
                        <input
                          value={editingName}
                          onChange={(event) =>
                            setEditingName(event.target.value)
                          }
                          maxLength={80}
                          autoFocus
                        />
                      </label>
                      <button type="submit">Save name</button>
                      <button type="button" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <strong>{diagram.name}</strong>
                      <span>{diagram.elementCount} visible objects</span>
                      <time dateTime={diagram.updatedAt}>
                        {new Date(diagram.updatedAt).toLocaleString()}
                      </time>
                      <div>
                        <button
                          type="button"
                          onClick={() => void openDiagram(diagram.id)}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(diagram.id);
                            setEditingName(diagram.name);
                          }}
                        >
                          Rename
                        </button>
                        {deleteId === diagram.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void deleteDiagram(diagram.id)}
                            >
                              Confirm delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteId(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeleteId(diagram.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <section className="product-shell__empty">
              <span aria-hidden="true">◇</span>
              <h2>Your first study map starts here.</h2>
              <p>Learn visually, then save a named copy to this browser.</p>
              <button
                className="is-primary"
                type="button"
                onClick={() => go("workspace")}
              >
                Open the study map
              </button>
            </section>
          )}
        </main>
      ) : null}

      {saveOpen ? (
        <div className="product-shell__modal-backdrop">
          <form
            className="product-shell__modal"
            onSubmit={saveDiagram}
            aria-labelledby="save-title"
          >
            <h2 id="save-title">Save this study map</h2>
            <p>Saved in this browser until you share or export it.</p>
            <label>
              <span>Study map name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                autoFocus
              />
            </label>
            <div>
              <button className="is-primary" type="submit">
                Save now
              </button>
              <button type="button" onClick={() => setSaveOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {shareUrl ? (
        <section className="product-shell__share" aria-label="Share link ready">
          <label>
            <span>Share URL</span>
            <input
              readOnly
              value={shareUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <a href={shareUrl} target="_blank" rel="noreferrer">
            Test link
          </a>
          <button
            type="button"
            aria-label="Close share link"
            onClick={() => setShareUrl("")}
          >
            ×
          </button>
        </section>
      ) : null}

      <output className="product-shell__status" aria-live="polite">
        {status}
      </output>
    </div>
  );
};
