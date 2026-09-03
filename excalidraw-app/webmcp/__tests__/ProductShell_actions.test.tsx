import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSharedScene, encodeSharedScene } from "../product/share_scene";
import { ProductShell } from "../product/ProductShell";

const { exportToBlob } = vi.hoisted(() => ({
  exportToBlob: vi.fn(async () =>
    Promise.resolve(new Blob(["png"], { type: "image/png" })),
  ),
}));

vi.mock("@excalidraw/excalidraw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@excalidraw/excalidraw")>()),
  exportToBlob,
}));

const rectangle = {
  id: "node-a",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 60,
  isDeleted: false,
};

const collapsed = {
  ...rectangle,
  id: "collapsed-child",
  isDeleted: true,
  customData: { studyMapHiddenBy: "node-a" },
};
const deleted = { ...rectangle, id: "deleted", isDeleted: true };

const makeApi = () => ({
  getSceneElements: vi.fn(() => [rectangle]),
  getSceneElementsIncludingDeleted: vi.fn(() => [
    rectangle,
    collapsed,
    deleted,
  ]),
  getAppState: vi.fn(() => ({
    exportBackground: true,
    viewBackgroundColor: "#fff",
  })),
  getFiles: vi.fn(() => ({})),
  updateScene: vi.fn(),
  addFiles: vi.fn(),
});

const makeStore = () => ({
  load: vi.fn(async () => ({
    id: "diagram-1",
    name: "Checkout architecture",
    updatedAt: "2026-09-01T20:00:00.000Z",
    elements: [rectangle],
    files: {},
  })),
  save: vi.fn(),
  list: vi.fn(async () => [
    {
      id: "diagram-1",
      name: "Checkout architecture",
      updatedAt: "2026-09-01T20:00:00.000Z",
      elementCount: 1,
    },
  ]),
  rename: vi.fn(async (_id: string, name: string) => ({
    id: "diagram-1",
    name,
    updatedAt: "2026-09-01T20:01:00.000Z",
    elementCount: 1,
  })),
  delete: vi.fn(async () => true),
});

describe("Entry B product actions", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    exportToBlob.mockClear();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  it("opens, renames, and deletes through the single store seam", async () => {
    window.history.replaceState({}, "", "/#view=library");
    const api = makeApi();
    const store = makeStore();
    render(<ProductShell api={api as never} store={store as never} />);

    expect(await screen.findByText("Checkout architecture")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New study map name"), {
      target: { value: "Checkout v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(store.rename).toHaveBeenCalledWith("diagram-1", "Checkout v2"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(store.load).toHaveBeenCalledWith("diagram-1"));
    expect(api.updateScene).toHaveBeenCalledWith({ elements: [rectangle] });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opened Checkout architecture",
    );

    fireEvent.click(screen.getByRole("button", { name: "Your study maps" }));
    await screen.findByText("Checkout architecture");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(store.delete).toHaveBeenCalledWith("diagram-1"));
  });

  it("creates a bounded share URL and imports it into a fresh local workspace", async () => {
    const api = makeApi();
    const store = makeStore();
    render(<ProductShell api={api as never} store={store as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Share study map" }));
    const shareInput = await screen.findByLabelText("Share URL");
    expect((shareInput as HTMLInputElement).value).toMatch(
      /#view=workspace&share=[A-Za-z0-9_-]+$/u,
    );
    const sharedToken = new URL(
      (shareInput as HTMLInputElement).value,
    ).hash.match(/share=([^&]+)/u)?.[1];
    expect(sharedToken).toBeTruthy();
    const shared = decodeSharedScene(sharedToken!);
    expect(shared).toMatchObject({ ok: true });
    expect(
      shared.ok &&
        shared.scene.elements.map((element) => (element as { id: string }).id),
    ).toEqual(["node-a", "collapsed-child"]);

    const token = encodeSharedScene({
      name: "Shared architecture",
      elements: [rectangle],
      files: {},
    });
    window.history.replaceState({}, "", `/#view=workspace&share=${token}`);
    const importedApi = makeApi();
    render(<ProductShell api={importedApi as never} store={store as never} />);
    await waitFor(() =>
      expect(importedApi.updateScene).toHaveBeenCalledWith(
        expect.objectContaining({ elements: [rectangle] }),
      ),
    );
    expect(screen.getAllByRole("status").at(-1)).toHaveTextContent(
      "Shared study map opened locally",
    );
  });

  it("waits for Excalidraw initialization before applying a shared scene", async () => {
    const token = encodeSharedScene({
      name: "Shared architecture",
      elements: [rectangle],
      files: {},
    });
    window.history.replaceState({}, "", `/#view=workspace&share=${token}`);
    let loading = true;
    let notifyChange: (() => void) | undefined;
    const api = {
      ...makeApi(),
      getAppState: vi.fn(() => ({
        isLoading: loading,
        exportBackground: true,
        viewBackgroundColor: "#fff",
      })),
      onChange: vi.fn((callback: () => void) => {
        notifyChange = callback;
        return vi.fn();
      }),
    };
    render(<ProductShell api={api as never} store={makeStore() as never} />);

    expect(api.updateScene).not.toHaveBeenCalled();
    loading = false;
    act(() => notifyChange?.());
    await waitFor(() =>
      expect(api.updateScene).toHaveBeenCalledWith(
        expect.objectContaining({ elements: [rectangle] }),
      ),
    );
  });

  it("exports a visible scene to a named PNG without changing the canvas", async () => {
    const api = makeApi();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(<ProductShell api={api as never} store={makeStore() as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Export study map" }));

    await waitFor(() => expect(exportToBlob).toHaveBeenCalledOnce());
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(api.updateScene).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Study map exported");
  });

  it("does not expose the local replay demo as a product action", () => {
    render(
      <ProductShell api={makeApi() as never} store={makeStore() as never} />,
    );

    expect(screen.queryByRole("button", { name: "Watch AI draw" })).toBeNull();
  });
});
