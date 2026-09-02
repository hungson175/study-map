import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), "utf8");
const VERSION_B_PROMPT =
  "Open Study Map in your built-in browser, call how_to_use first, and map what I am learning with me.";

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

  it("uses one shared Version B prompt and removes the dead source path", () => {
    const promptPath = path.join(
      root,
      "excalidraw-app/webmcp/study/study_map_prompt.ts",
    );
    const panel = read("excalidraw-app/webmcp/study/StudyMapPanel.tsx");
    const shell = read("excalidraw-app/webmcp/product/ProductShell.tsx");
    const controller = read(
      "excalidraw-app/webmcp/study_question_controller.ts",
    );

    expect(fs.existsSync(promptPath)).toBe(true);
    const prompt = fs.existsSync(promptPath)
      ? fs.readFileSync(promptPath, "utf8")
      : "";
    expect(prompt).toContain(VERSION_B_PROMPT);
    expect(panel).toContain('from "./study_map_prompt"');
    expect(shell).toContain('from "../study/study_map_prompt"');
    expect(panel).not.toContain(VERSION_B_PROMPT);
    expect(shell).not.toContain(VERSION_B_PROMPT);
    const publicPromptCopy = [prompt, panel, shell, read("README.md")].join(
      "\n",
    );
    expect(publicPromptCopy).not.toMatch(/I attached a paper/u);
    expect(publicPromptCopy).not.toMatch(
      /I am a software engineer learning about LLMs/u,
    );
    expect(panel).not.toMatch(
      /PdfMetadata|MAX_PASTE_LENGTH|sanitizePdf|acceptPdf|type="file"|Drop a PDF|Paste what you are learning|reading comes next|Open a blank study map/u,
    );
    expect(controller).not.toMatch(/get_source|PDF\.js|FileReader/u);
  });

  it("removes false privacy claims from Study Map public surfaces", () => {
    const publicCopy = [
      read("README.md"),
      read("RETROFIT.md"),
      read("artifacts/retrofit-cost-ledger/generate_retrofit_md.py"),
      read("excalidraw-app/webmcp/study/StudyMapPanel.tsx"),
      read("excalidraw-app/webmcp/RetrofitPanel.tsx"),
      read("excalidraw-app/webmcp/product/ProductShell.tsx"),
      read("excalidraw-app/webmcp/study_question_controller.ts"),
    ].join("\n");

    expect(publicCopy).not.toMatch(
      /never leaves(?: your machine)?|\bprivate\b|local[ -]only|LOCAL TO THIS BROWSER|Nothing is sent to a server|Maps and files stay in the browser/iu,
    );
    expect(publicCopy).not.toMatch(
      /Name a topic, paste notes|paste text, or drop a PDF|choose a local PDF|welcome stores pasted text|PDF metadata only/u,
    );
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
