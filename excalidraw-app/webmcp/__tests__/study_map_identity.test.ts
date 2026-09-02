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

  it("self-hosts every production font below the Study Map Pages base", () => {
    const html = read("excalidraw-app/index.html");
    const fontPlugin = read("scripts/woff2/woff2-vite-plugins.js");
    const assistantFiles = [
      "Assistant-Regular.woff2",
      "Assistant-Medium.woff2",
      "Assistant-SemiBold.woff2",
      "Assistant-Bold.woff2",
    ];

    expect(html).toContain(
      'window.EXCALIDRAW_ASSET_PATH = window.origin + "/study-map/"',
    );
    expect(fontPlugin).toContain(
      'const LOCAL_FONTS_BASE = "/study-map/fonts/"',
    );
    expect(fontPlugin).not.toContain(
      "excalidraw.nyc3.cdn.digitaloceanspaces.com",
    );
    for (const file of assistantFiles) {
      expect(fontPlugin).toContain(`url(./Assistant/${file})`);
    }
  });

  it("documents the exact origin-scoped M2 native proof", () => {
    const readme = read("README.md");

    expect(readme).toContain(
      "Native discovery and invocation are verified on this live origin in Codex Desktop 0.152.0, model Sol, through its built-in `iab` browser: 16 tools were observed (not a cap);",
    );
    expect(readme).toContain("`list_questions` returned `open=1`");
    expect(readme).toContain("`answer_question` returned `applied=5`");
    expect(readme).toContain("the prior human drag survived");
    expect(readme).toContain(
      "project/hackathon-hunter/reports/evidence/study-map-m2/native-drag-question-answer-f2c4cecd.json",
    );
    expect(readme).not.toContain("remain unproven");
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

  it("docks the question panel away from the bottom-right Agent layout", () => {
    const studyStyles = read("excalidraw-app/webmcp/study/StudyMapPanel.scss");
    const agentStyles = read("excalidraw-app/webmcp/RetrofitPanel.scss");
    const desktop = studyStyles.slice(
      studyStyles.indexOf(".study-map__question-panel"),
      studyStyles.indexOf("@media"),
    );
    const narrow = studyStyles.slice(studyStyles.indexOf("@media"));
    const agentRuleStart = agentStyles.indexOf(".webmcp-retrofit {");
    const agentDesktop = agentStyles.slice(
      agentRuleStart,
      agentStyles.indexOf("  header,", agentRuleStart),
    );

    expect(agentStyles).toMatch(
      /\.webmcp-retrofit\s*\{[\s\S]*?right:\s*1rem;[\s\S]*?bottom:\s*1rem;/u,
    );
    expect(agentDesktop).toMatch(/box-sizing:\s*border-box;/u);
    expect(desktop).toMatch(/left:\s*0\.75rem;/u);
    expect(desktop).toMatch(/right:\s*auto;/u);
    expect(desktop).toMatch(/bottom:\s*4\.1rem;/u);
    expect(narrow).toMatch(
      /\.study-map__question-panel\s*\{[\s\S]*?top:\s*8\.5rem;[\s\S]*?right:\s*auto;[\s\S]*?bottom:\s*auto;/u,
    );
  });
});
