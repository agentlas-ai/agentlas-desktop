#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "output", "playwright", "agentlas-one-live-electron");
const oneBaseUrl = process.env.AGENTLAS_ONE_QA_URL || "http://127.0.0.1:3100";

function productIdentityTokens(value) {
  return [...String(value ?? "").toUpperCase().matchAll(/\b(?=[A-Z0-9-]{4,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g)]
    .map((match) => match[0].replaceAll("-", ""));
}

async function dismissOptionalIntro(page) {
  for (const label of ["나중에", "건너뛰기", "Skip for now", "Skip onboarding"]) {
    const button = page.getByRole("button", { name: label, exact: false }).first();
    if (await button.count()) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(180);
    }
  }
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-live-electron-"));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let desktop;
  try {
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        AGENTLAS_E2E: "1",
        AGENTLAS_E2E_AUTH: "1",
        NODE_ENV: "development",
        ELECTRON_START_URL: "about:blank",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow({ timeout: 30_000 });
    await page.addInitScript(() => window.localStorage.setItem("agentlas.locale", "ko"));
    await page.goto(`${oneBaseUrl}/one`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("button", { name: /Open sidebar|사이드바 열기/ }).waitFor({ timeout: 30_000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "");
      throw new Error(`One shell did not become ready at ${page.url()}: ${body.slice(0, 1_000)}`, { cause: error });
    }
    await dismissOptionalIntro(page);

    const live = await page.evaluate(async () => {
      if (!window.agentlas) return { bridge: false, runtimes: [], oneId: null };
      const [runtimes, profile] = await Promise.all([
        window.agentlas.runtime.detect(true),
        window.agentlas.oneProfile.get(),
      ]);
      return {
        bridge: true,
        runtimes: runtimes.map((runtime) => ({ kind: runtime.kind, backend: runtime.backend, active: runtime.active })),
        oneId: profile.oneId,
      };
    });
    assert.equal(live.bridge, true, "the live Electron preload bridge must initialize");
    assert.ok(typeof live.oneId === "string" && live.oneId.length > 8, "the live Main store must return a real One profile");
    assert.ok(live.runtimes.some((runtime) => runtime.active), "the temporary live profile must detect an active local runtime");

    await page.waitForTimeout(300);
    const railState = await page.locator("[data-rail-collapsed]").first().getAttribute("data-rail-collapsed");
    assert.equal(railState, "true", "the live desktop must start with its menu collapsed");
    await page.screenshot({ path: path.join(outDir, "live-one-empty.png") });

    const textarea = page.locator("textarea").last();
    await textarea.fill("안녕하세요");
    await page.getByRole("button", { name: /Send|보내기/ }).click();
    let targetChatId = null;
    const chatDeadline = Date.now() + 15_000;
    while (!targetChatId && Date.now() < chatDeadline) {
      targetChatId = await page.evaluate(async () => {
        const chats = await window.agentlas.chats.listRecent(20);
        for (const chat of chats) {
          const history = await window.agentlas.invoke.history(chat.id);
          if (history.some((entry) => entry.role === "user" && entry.text.includes("안녕하세요"))) return chat.id;
        }
        return null;
      });
      if (!targetChatId) await page.waitForTimeout(100);
    }
    assert.ok(targetChatId, "the live Main store must expose the exact conversation id");
    let conversationProof = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      conversationProof = await page.evaluate(async (targetChatId) => {
        if (!window.agentlas) return { userTurns: 0, assistantTurns: 0, assistantText: "", receipt: null, activeChats: [] };
        const history = await window.agentlas.invoke.history(targetChatId);
        const assistants = history.filter((entry) => entry.role === "assistant" && entry.text.trim());
        return {
          userTurns: history.filter((entry) => entry.role === "user" && entry.text.trim()).length,
          assistantTurns: assistants.length,
          assistantText: assistants.at(-1)?.text ?? "",
          history: history.map((entry) => ({ role: entry.role, text: entry.text.slice(0, 240) })),
          receipt: await window.agentlas.invoke.latestReceipt(targetChatId),
          canonicalTask: await window.agentlas.tasks.findForChat(targetChatId),
          activeChats: await window.agentlas.invoke.activeChats(),
        };
      }, targetChatId);
      if (
        conversationProof.receipt
        && ["completed", "failed", "cancelled", "interrupted"].includes(conversationProof.receipt.status)
        && conversationProof.assistantTurns >= 1
      ) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(650);
    const pageText = await page.locator("body").innerText();
    assert.match(pageText, /안녕하세요/, "the live One conversation must retain the user turn");
    assert.ok(conversationProof.userTurns >= 1, "the live Main history must retain the user turn");
    assert.ok(conversationProof.assistantTurns >= 1 && conversationProof.assistantText.trim().length > 0, "the live Main history must retain a completed assistant response");
    assert.doesNotMatch(conversationProof.assistantText, /```[A-Za-z0-9_+.-]+\s*$/, "a live reply must not persist an unfinished language-qualified code fence");
    assert.equal(conversationProof.canonicalTask, null, "a greeting must remain a general conversation instead of becoming delegated work");
    assert.doesNotMatch(pageText, /Finish with this result|이 결과로 완료/, "a general conversation must not expose work completion controls");
    const staleStatus = page.getByText(/Calling Claude Code CLI|Claude Code CLI 호출/).first();
    if (await staleStatus.count()) assert.equal(await staleStatus.isVisible(), false, "the live screenshot must not show an in-progress runtime status after completion");
    await page.screenshot({ path: path.join(outDir, "live-one-conversation.png") });

    const taskPrompt = "50만원 이하 공기청정기 중 25평 거실에 맞는 제품을 조사하고 출처를 교차 검증해서 골라줘.";
    await textarea.fill(taskPrompt);
    await page.getByRole("button", { name: /Send|보내기/ }).click();
    let teamProof = null;
    const teamDeadline = Date.now() + 30_000;
    while (!teamProof && Date.now() < teamDeadline) {
      const candidate = await page.evaluate(async (chatId) => {
        const [proposal, task, receipt, activeChats] = await Promise.all([
          window.agentlas.oneTeamPreflight.getForChat(chatId),
          window.agentlas.tasks.findForChat(chatId),
          window.agentlas.invoke.latestReceipt(chatId),
          window.agentlas.invoke.activeChats(),
        ]);
        return {
          proposal,
          task,
          receipt,
          activeChats,
          buttonLabels: [...document.querySelectorAll("button")].map((button) => button.textContent || ""),
        };
      }, targetChatId);
      if (
        candidate.proposal
        && candidate.task
        && candidate.receipt?.runId !== conversationProof.receipt.runId
        && ["team_reserved", "solo_reserved", "team_started", "solo_started"].includes(candidate.proposal.status)
      ) {
        teamProof = candidate;
      } else {
        await page.waitForTimeout(100);
      }
    }
    assert.ok(teamProof, "One must expose one exact, safely reserved execution path before a fast provider run can finish");
    fs.writeFileSync(path.join(outDir, "live-one-adaptive-start-debug.json"), `${JSON.stringify(teamProof, null, 2)}\n`);
    assert.ok(teamProof.task, "the same conversation must become one canonical Task");
    assert.notEqual(teamProof.receipt?.runId, conversationProof.receipt.runId, "adaptive staffing must start a distinct Task run");
    assert.ok(
      ["team_reserved", "solo_reserved", "team_started", "solo_started"].includes(teamProof.proposal?.status),
      `One must reserve or start one safe execution path: ${JSON.stringify(teamProof.proposal)}`,
    );
    assert.notEqual(teamProof.proposal?.reservedRun?.mode, "workforce", "One must never auto-authorize Hub borrowing, payment, or broader access");
    assert.ok(
      !teamProof.buttonLabels.some((label) => /전문가 팀으로 시작|Start with an expert team|One 혼자 진행|Continue solo/.test(label)),
      "One must not make a beginner choose between staffing modes",
    );
    const promotedProjection = await page.evaluate(async (taskId) => (
      window.agentlas.tasks.getProjection(taskId, { surface: "one", mode: "detailed" })
    ), teamProof.task.id);
    assert.equal(
      promotedProjection?.references?.receiptIds?.includes(conversationProof.receipt.runId) ?? false,
      false,
      "a receipt from the earlier general conversation must not be rebound to the promoted Task",
    );
    await page.screenshot({ path: path.join(outDir, "live-one-adaptive-start.png"), fullPage: true });

    let soloProof = null;
    // Real local research frequently crosses five minutes when the provider
    // performs browser/tool verification. Keep this live proof aligned with
    // the product's truthful long-running Task contract instead of turning a
    // still-active run into a false failure at the five-minute boundary.
    const soloDeadline = Date.now() + 600_000;
    while (Date.now() < soloDeadline) {
      soloProof = await page.evaluate(async (chatId) => {
        const [history, receipt, task, activeChats] = await Promise.all([
          window.agentlas.invoke.history(chatId),
          window.agentlas.invoke.latestReceipt(chatId),
          window.agentlas.tasks.findForChat(chatId),
          window.agentlas.invoke.activeChats(),
        ]);
        return {
          receipt,
          task,
          activeChats,
          assistantTurns: history.filter((entry) => entry.role === "assistant" && entry.text.trim()).length,
          latestAssistant: history.filter((entry) => entry.role === "assistant" && entry.text.trim()).at(-1)?.text ?? "",
        };
      }, targetChatId);
      if (
        soloProof.receipt?.runId !== conversationProof.receipt?.runId
        && ["completed", "failed", "cancelled", "interrupted"].includes(soloProof.receipt?.status)
        && soloProof.assistantTurns >= 2
      ) break;
      await page.waitForTimeout(650);
    }
    await page.screenshot({ path: path.join(outDir, "live-one-solo-terminal.png"), fullPage: true });
    assert.ok(soloProof?.receipt, "the automatically selected execution path must produce a new invocation receipt");
    assert.notEqual(soloProof.receipt.runId, conversationProof.receipt.runId, "the Task run must be distinct from the greeting run");
    assert.equal(soloProof.receipt.status, "completed", `the actual Task must complete: ${JSON.stringify(soloProof.receipt)}`);
    assert.equal(soloProof.task?.status, "partial", "a completed run remains partial until the user accepts the result");
    await page.waitForTimeout(1_200);
    const completedProjection = await page.evaluate(async (taskId) => (
      window.agentlas.tasks.getProjection(taskId, { surface: "one", mode: "detailed" })
    ), teamProof.task.id);
    assert.ok(
      completedProjection?.references?.receiptIds?.includes(soloProof.receipt.runId),
      "the new Task receipt must be bound by its Task-scoped run.started evidence",
    );
    const durableResult = await page.evaluate(async ({ runId, chatId, taskId }) => (
      window.agentlas.invoke.latestOneSurface({ runId, chatId, taskId })
    ), { runId: soloProof.receipt.runId, chatId: targetChatId, taskId: teamProof.task.id });
    fs.writeFileSync(path.join(outDir, "live-one-solo-debug.json"), `${JSON.stringify({
      receipt: soloProof.receipt,
      task: soloProof.task,
      latestAssistant: soloProof.latestAssistant,
      durableResult,
    }, null, 2)}\n`);
    assert.ok(durableResult?.manifest, "a confirmed One Task must persist one validated structured result");
    assert.ok(
      durableResult.manifest.blocks.some((block) => ["Table", "Comparison", "SourceList"].includes(block.type)),
      `a research recommendation must include a scannable comparison or source block: ${JSON.stringify(durableResult.manifest.blocks.map((block) => block.type))}`,
    );
    const comparisonTable = durableResult.manifest.blocks.find((block) => block.type === "Table");
    if (comparisonTable) {
      const choiceColumn = comparisonTable.columns.find((column) => /^(?:선택|choice)$/i.test(column.label));
      const productColumn = comparisonTable.columns.find((column) => /^(?:제품|product)$/i.test(column.label));
      const productValues = productColumn
        ? comparisonTable.rows.map((row) => row.cells.find((cell) => cell.columnId === productColumn.columnId)?.value ?? "")
        : [];
      if (productColumn) {
        assert.ok(productValues.length >= 2, `a product comparison must contain at least two real candidates: ${JSON.stringify(productValues)}`);
        assert.ok(
          productValues.every((value) => !/^\d+(?:\.\d+)?평.*(?:거실|방|공간)$/i.test(String(value).trim())),
          `room-size context must never be rendered as a product candidate: ${JSON.stringify(productValues)}`,
        );
        const titleTokens = productIdentityTokens(durableResult.manifest.title);
        if (titleTokens.length > 0) {
          assert.ok(
            productValues.some((value) => productIdentityTokens(value).some((token) => titleTokens.includes(token))),
            `the product recommended in the result title must appear in its comparison table: ${JSON.stringify({ title: durableResult.manifest.title, productValues })}`,
          );
        }
        if (choiceColumn) {
          const recommendedRow = comparisonTable.rows.find((row) => /^(?:추천|recommended)$/i.test(String(
            row.cells.find((cell) => cell.columnId === choiceColumn.columnId)?.value ?? "",
          ).trim()));
          assert.ok(recommendedRow, "a recommendation table must label the chosen product");
          const recommendedProduct = recommendedRow.cells.find((cell) => cell.columnId === productColumn.columnId)?.value ?? "";
          const productTokens = productIdentityTokens(recommendedProduct);
          assert.ok(
            titleTokens.length > 0 && productTokens.some((token) => titleTokens.includes(token)),
            `the result title and the row labelled 추천 must name the same product: ${JSON.stringify({ title: durableResult.manifest.title, recommendedProduct })}`,
          );
        }
      } else {
        assert.ok(comparisonTable.rows.length >= 2, "a product fact table must contain at least two checked facts");
      }
    }
    const resultSection = page.locator('section[aria-label="일의 결과"], section[aria-label="Work result"]').first();
    await resultSection.waitFor({ timeout: 10_000 });
    const resultTitle = (await resultSection.locator("h3").first().innerText()).trim();
    assert.doesNotMatch(
      resultTitle,
      /^(?:전제|요약|핵심 요약|핵심 결론|근거|출처|확인한 출처|assumptions|summary|evidence|sources)$/i,
      `the live result title must describe the answer, not an internal section: ${resultTitle}`,
    );
    assert.doesNotMatch(
      await resultSection.innerText(),
      /조사하겠습니다|찾아보겠습니다|검증하겠습니다|검증할게요|조회하겠습니다|먼저 .*확인하고|검증이 끝났습니다|결론부터 정리드립니다|\bI(?:'ll| will) (?:research|search|verify)/i,
      "the live result must begin with findings instead of future-tense process narration",
    );
    const resultSourceCount = durableResult.manifest.blocks
      .filter((block) => block.type === "SourceList")
      .reduce((count, block) => count + block.sources.length, 0);
    assert.ok(resultSourceCount <= 12, `the live result must keep the source list useful: ${resultSourceCount}`);
    const resultScrollPosition = await resultSection.evaluate((result) => {
      let scroller = result.parentElement;
      while (scroller && getComputedStyle(scroller).overflowY !== "auto" && getComputedStyle(scroller).overflowY !== "scroll") {
        scroller = scroller.parentElement;
      }
      if (!scroller) return null;
      return {
        offset: result.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        scrollTop: scroller.scrollTop,
      };
    });
    assert.ok(
      resultScrollPosition && resultScrollPosition.offset >= 12 && resultScrollPosition.offset <= 64,
      `a completed result must open at its title near the top of the conversation: ${JSON.stringify(resultScrollPosition)}`,
    );
    assert.doesNotMatch(
      await page.locator("main").innerText(),
      /One이 준비한 팀|Team prepared by One/,
      "a consumed team proposal must not remain above the completed result",
    );
    await page.screenshot({ path: path.join(outDir, "live-one-solo-result.png"), fullPage: true });
    const liveTable = page.locator("main table").first();
    if (await liveTable.count()) {
      await liveTable.scrollIntoViewIfNeeded();
      await page.waitForTimeout(220);
      await page.screenshot({ path: path.join(outDir, "live-one-solo-result-detail.png") });
    }

    const finishButton = page.getByRole("button", { name: /이대로 마무리|Finish here/ }).first();
    await finishButton.scrollIntoViewIfNeeded();
    await finishButton.click();
    await page.waitForFunction(async (taskId) => {
      const task = await window.agentlas.tasks.get(taskId);
      return task?.status === "completed";
    }, teamProof.task.id, { timeout: 20_000 });
    await page.waitForTimeout(700);
    const acceptanceProof = await page.evaluate(async (taskId) => {
      const [task, closures, memory, suggestions] = await Promise.all([
        window.agentlas.tasks.get(taskId),
        window.agentlas.oneValueClosure.getState(),
        window.agentlas.oneMemory.getState(),
        window.agentlas.oneSuggestions.getState(),
      ]);
      return {
        task,
        closures: closures.closures.filter((record) => record.closure.taskId === taskId),
        taskMemoryCandidates: memory.candidates.filter((candidate) => candidate.source.sourceTaskId === taskId),
        taskSuggestions: suggestions.suggestions.filter((suggestion) => suggestion.originTaskId === taskId),
      };
    }, teamProof.task.id);
    assert.equal(acceptanceProof.task?.status, "completed", "explicit result acceptance must complete the canonical Task");
    assert.equal(acceptanceProof.closures.length, 1, "result acceptance must create one exact Value Closure");
    assert.equal(acceptanceProof.taskMemoryCandidates.length, 0, "ordinary work must not silently create a Memory candidate");
    assert.equal(acceptanceProof.taskSuggestions.length, 0, "one first completion must not invent a reusable agent or team pattern");
    assert.equal(await finishButton.isVisible().catch(() => false), false, "the result acceptance control must disappear after completion");
    await page.screenshot({ path: path.join(outDir, "live-one-accepted-result.png"), fullPage: true });
    const valueClosureHeading = page.getByText(/이 일로 달라진 점|What changed/).first();
    await valueClosureHeading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(outDir, "live-one-accepted-result-detail.png") });

    const followUpPrompt = "그럼 예산을 30만원으로 낮추면 셋 중 어떤 걸 고르면 돼? 이전 추천과 달라진 이유도 짧게 알려줘.";
    const followUpComposer = page.locator("textarea").last();
    await followUpComposer.fill(followUpPrompt);
    await page.getByRole("button", { name: /Send|보내기/ }).click();
    const followUpChatId = await page.waitForFunction(async ({ priorChatId, prompt }) => {
      const chats = await window.agentlas.chats.listRecent(50);
      const followUp = chats.find((chat) => chat.id !== priorChatId && chat.title.includes("30만원"));
      if (!followUp) return null;
      const history = await window.agentlas.invoke.history(followUp.id);
      return history.some((entry) => entry.role === "system" && /이전 일에서 이어갑니다|Continuing from/.test(entry.text))
        ? followUp.id
        : null;
    }, { priorChatId: targetChatId, prompt: followUpPrompt }, { timeout: 20_000 }).then((handle) => handle.jsonValue());
    assert.ok(followUpChatId && followUpChatId !== targetChatId, "a result follow-up must start a separate bounded conversation");

    const followUpBoundary = await page.evaluate(async ({ chatId, priorChatId }) => {
      const [chat, history, source, task, proposal] = await Promise.all([
        window.agentlas.chats.get(chatId),
        window.agentlas.invoke.history(chatId),
        window.agentlas.chats.get(priorChatId),
        window.agentlas.tasks.findForChat(chatId),
        window.agentlas.oneTeamPreflight.getForChat(chatId),
      ]);
      return { chat, history, source, task, proposal };
    }, { chatId: followUpChatId, priorChatId: targetChatId });
    assert.deepEqual(followUpBoundary.chat?.hiredAgents ?? [], [], "the prior Task team must not silently carry into follow-up work");
    assert.equal(
      followUpBoundary.history.filter((entry) => entry.role === "system" && /이전 일에서 이어갑니다|Continuing from/.test(entry.text)).length,
      1,
      "the follow-up must persist one concise continuity cue",
    );
    assert.doesNotMatch(
      followUpBoundary.history.map((entry) => entry.text).join("\n"),
      /안녕하세요/,
      "the raw transcript from the prior Task must not be copied into follow-up history",
    );

    assert.ok(
      !(await page.locator("button").allTextContents()).some((label) => /전문가 팀으로 시작|Start with an expert team|One 혼자 진행|Continue solo/.test(label)),
      "a follow-up must also keep staffing choices inside One",
    );

    let followUpProof = null;
    const followUpDeadline = Date.now() + 600_000;
    while (Date.now() < followUpDeadline) {
      followUpProof = await page.evaluate(async (chatId) => {
        const [history, receipt, task, activeChats] = await Promise.all([
          window.agentlas.invoke.history(chatId),
          window.agentlas.invoke.latestReceipt(chatId),
          window.agentlas.tasks.findForChat(chatId),
          window.agentlas.invoke.activeChats(),
        ]);
        const assistants = history.filter((entry) => entry.role === "assistant" && entry.text.trim());
        return {
          history,
          receipt,
          task,
          activeChats,
          latestAssistant: assistants.at(-1)?.text ?? "",
        };
      }, followUpChatId);
      if (
        followUpProof.receipt
        && ["completed", "failed", "cancelled", "interrupted"].includes(followUpProof.receipt.status)
        && followUpProof.latestAssistant.trim()
      ) break;
      await page.waitForTimeout(650);
    }
    assert.equal(followUpProof?.receipt?.status, "completed", `the actual follow-up must complete: ${JSON.stringify(followUpProof?.receipt)}`);
    assert.ok(followUpProof.latestAssistant.trim().length > 0, "the actual follow-up must persist an assistant answer");
    assert.ok(
      followUpProof.history.some((entry) => entry.role === "user" && entry.text === followUpPrompt),
      "the follow-up prompt must persist in the new bounded conversation",
    );
    await page.waitForTimeout(900);
    const followUpResult = await page.evaluate(async ({ runId, chatId, taskId }) => (
      window.agentlas.invoke.latestOneSurface({ runId, chatId, taskId })
    ), {
      runId: followUpProof.receipt.runId,
      chatId: followUpChatId,
      taskId: followUpProof.task?.id ?? null,
    });
    fs.writeFileSync(path.join(outDir, "live-one-follow-up-debug.json"), `${JSON.stringify({
      receipt: followUpProof.receipt,
      task: followUpProof.task,
      latestAssistant: followUpProof.latestAssistant,
      history: followUpProof.history,
      durableResult: followUpResult,
    }, null, 2)}\n`);
    assert.ok(followUpResult?.manifest, "the actual follow-up must persist a structured result");
    assert.ok(
      followUpResult.manifest.blocks.some((block) => block.type === "Narrative")
        && followUpResult.manifest.blocks.some((block) => block.type === "Table"),
      `the actual follow-up must keep both its explanation and comparison table: ${JSON.stringify(followUpResult.manifest.blocks.map((block) => block.type))}`,
    );
    assert.doesNotMatch(
      followUpResult.manifest.title,
      /^(?:memory(?: events)?|session memory|research notes|work log)$/i,
      `internal provider headings must not become a user-facing result title: ${followUpResult.manifest.title}`,
    );
    assert.doesNotMatch(
      followUpResult.manifest.blocks.map((block) => block.title).join("\n"),
      /^(?:Summary|Comparison|Sources)$/m,
      "a Korean follow-up must not receive English system section labels",
    );
    await page.screenshot({ path: path.join(outDir, "live-one-follow-up.png"), fullPage: true });
    await page.getByRole("button", { name: /Open sidebar|사이드바 열기/ }).click();
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(outDir, "live-one-follow-up-menu.png"), fullPage: true });

    fs.writeFileSync(path.join(outDir, "proof-summary.json"), `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      bridge: live.bridge,
      runtimes: live.runtimes,
      oneProfileCreated: true,
      conversationCompleted: true,
      assistantResponsePersisted: true,
      assistantPreview: conversationProof.assistantText.slice(0, 600),
      greetingRemainedConversation: true,
      complexRequestBecameTask: true,
      priorConversationReceiptExcludedFromTask: true,
      staffingChoiceStayedInsideOne: true,
      hubBorrowingWasNotSilentlyAuthorized: true,
      actualTaskCompleted: true,
      actualSoloResultAccepted: true,
      exactValueClosureCreated: true,
      firstCompletionStayedQuietWithoutReuseEvidence: true,
      actualFollowUpCompleted: true,
      followUpUsedSeparateChat: true,
      followUpCopiedRawTranscript: false,
      followUpCopiedTeamOrPermissions: false,
      followUpChatId,
      followUpTaskId: followUpProof.task?.id ?? null,
      actualFollowUpPreview: followUpProof.latestAssistant.slice(0, 800),
      structuredResultPersisted: true,
      structuredBlockTypes: durableResult.manifest.blocks.map((block) => block.type),
      actualResultPreview: soloProof.latestAssistant.slice(0, 800),
      userDataWasTemporary: true,
    }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, ...live, conversationCompleted: true })}\n`);
  } finally {
    await desktop?.close().catch(() => undefined);
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
