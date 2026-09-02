import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Excalidraw host integration", () => {
  it("mounts the retrofit beside the upstream editor through the public API", () => {
    const appSource = readFileSync(
      join(process.cwd(), "excalidraw-app", "App.tsx"),
      "utf8",
    );

    expect(appSource).toContain(
      'import { RetrofitPanel } from "./webmcp/RetrofitPanel";',
    );
    expect(appSource).toContain(
      'import { StudyMapPanel } from "./webmcp/study/StudyMapPanel";',
    );
    expect(appSource).toContain("<RetrofitPanel api={excalidrawAPI}");
    expect(
      appSource.indexOf("<StudyMapPanel api={excalidrawAPI}"),
    ).toBeLessThan(appSource.indexOf("<RetrofitPanel api={excalidrawAPI}"));
    expect(appSource).not.toContain("<AppWelcomeScreen");
    expect(appSource).not.toContain(
      ["document", ["model", "Context"].join("")].join("."),
    );
  });
});
