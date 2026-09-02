import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), "utf8");

describe("Study Map public identity", () => {
  it("mounts the study registration before the two retained seed surfaces", () => {
    const app = read("excalidraw-app/App.tsx");
    const study = app.indexOf("<StudyMapPanel");
    const scene = app.indexOf("<RetrofitPanel");
    const lifecycle = app.indexOf("<ProductShell");

    expect(study).toBeGreaterThan(0);
    expect(study).toBeLessThan(scene);
    expect(scene).toBeLessThan(lifecycle);
  });

  it("uses the exact Pages base and preserves origin-trial before scripts", () => {
    const vite = read("excalidraw-app/vite.config.mts");
    const html = read("excalidraw-app/index.html");

    expect(vite).toContain('base: "/study-map/"');
    expect(html).toMatch(
      /<title>\s*Study Map — Learn anything as a map you and ChatGPT draw together\s*<\/title>/u,
    );
    expect(html.indexOf('http-equiv="origin-trial"')).toBeGreaterThan(0);
    expect(html.indexOf('http-equiv="origin-trial"')).toBeLessThan(
      html.indexOf("<script"),
    );
    expect(html).toContain('content="Study Map"');
    expect(html).toContain("https://hungson175.github.io/study-map/");
  });

  it("removes the old judge-visible product identity while retaining attribution", () => {
    const shell = read("excalidraw-app/webmcp/product/ProductShell.tsx");
    const readme = read("README.md");
    const retrofit = read("RETROFIT.md");

    expect(shell).toContain("Study Map");
    expect(shell).not.toMatch(/Canvas Agent|excalidraw-webmcp|ask-the-chart/);
    expect(readme.slice(0, 2400)).toContain("# Study Map");
    expect(readme.slice(0, 2400)).toContain(
      "https://hungson175.github.io/study-map/",
    );
    expect(retrofit.slice(0, 1200)).toContain("Study Map");
    expect(readme).toContain("fork of [Excalidraw]");
  });
});
