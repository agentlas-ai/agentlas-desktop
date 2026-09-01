(() => {
  "use strict";

  const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
  const UI_ATTRIBUTES = ["aria-label", "title", "placeholder"];
  const CONTENT_BOUNDARY_SELECTOR = [
    ".messageBody",
    ".chatMessageContent",
    ".questionBubble > div",
    ".answer > p",
    ".answerBlock > p",
    ".manuscriptEditor",
    ".manuscriptPreview",
    ".projectTitle",
    ".artifactTitle",
    ".sourceTitle",
    "tbody",
    "code",
    "[data-localize='false']",
  ].join(",");

  const ENGLISH_COPY = new Map(Object.entries({
    "연구 공간을 여는 중…": "Opening your research workspace…",
    "현재 프로젝트": "Current project",
    "연구 프로젝트": "Research projects",
    "현재 프로젝트 연구 흐름": "Current project research workflow",
    "사이드바 접기": "Collapse sidebar",
    "사이드바 열기": "Open sidebar",
    "사이드바 닫기": "Close sidebar",
    "Agentlas Work로 돌아가기": "Back to Agentlas Work",
    "새 연구": "New research",
    "새 연구 시작": "Start new research",
    "설정과 세부 정보": "Settings and details",
    "현재 프로젝트에 활성화된 Lab 도구와 아티팩트 보관소": "Active Lab tools and artifact repositories for this project",
    "이 프로젝트에 활성화된 Lab이 없습니다. 검증된 아티팩트가 생성되거나 Lab을 추가하면 여기에 표시됩니다.": "No Labs are active in this project. Verified artifacts and newly added Labs will appear here.",
    "아티팩트 보관소 열기": "Open artifact repository",
    "저장된 출처": "Saved sources",
    "이 응답에서 Lab 도구로 생성된 아티팩트": "Artifacts created by Lab tools in this response",
    "프로젝트 기록을 불러오는 중…": "Loading project history…",
    "프로젝트 기록을 불러오지 못했습니다.": "Could not load project history.",
    "다시 시도": "Try again",
    "연구 계약 초안": "Research contract draft",
    "사람의 승인 대기 · 목표와 중단 기준 확인 →": "Awaiting human approval · Review goals and stop criteria →",
    "아직 대화 기록이 없습니다.": "No conversation history yet.",
    "아직 생성된 연구 응답이 없습니다.": "No research response has been generated yet.",
    "첫 질문은 저장되었습니다. 연구 계약 승인과 Agent runtime 실행이 연결되면 답변 블록, 주장, 정확한 출처 인용이 이 기록에 추가됩니다.": "Your first question is saved. Response blocks, claims, and exact source citations will appear after the research contract is approved and the Agent runtime runs.",
    "고정 답변이나 가짜 인용은 표시하지 않습니다.": "Agentlas does not display canned answers or fabricated citations.",
    "질문에서 검증 가능한 연구까지.": "From a question to verifiable research.",
    "대화, 근거, 실험, 시각 자료와 논문을 하나의 로컬 연구 기록으로 연결합니다. 아직 생성된 연구는 없습니다.": "Connect conversations, evidence, experiments, visuals, and manuscripts in one local research record. No research has been created yet.",
    "근거": "Evidence",
    "세부": "Details",
    "저장 실패": "Save failed",
    "연구, 열린 Lab 아티팩트와 원고": "Research, open Lab artifacts, and manuscripts",
    "이전 열린 탭 보기": "Show previous open tabs",
    "다음 열린 탭 보기": "Show next open tabs",
    "탭 닫기": "Close tab",
    "대화 탭 닫기": "Close conversation tab",
    "Lab 탭 닫기": "Close Lab tab",
    "원고 탭 닫기": "Close manuscript tab",
    "연구 문맥과 세부 정보": "Research context and details",
    "연구 협업 채팅": "Research collaboration chat",
    "이 프로젝트의 대화가 여기에 이어집니다.": "This project's conversation continues here.",
    "프로젝트 문맥": "Project context",
    "현재 연구 채팅 컨텍스트": "Current research chat context",
    "인용 번호나 출처 행을 선택하면 해당 source version, evidence locator, 검증 상태를 여기서 확인할 수 있습니다.": "Select a citation number or source row to inspect its source version, evidence locator, and verification status.",
    "AI 연구 파트너": "AI research partner",
    "온라인": "Online",
    "후속 질문": "Follow-up question",
    "후속 질문, 분석 또는 실험 요청": "Ask a follow-up, analysis, or experiment",
    "첨부는 다음 단계에서 연결됩니다": "Attachments will be connected in the next step",
    "첨부 준비 중": "Preparing attachments",
    "보내기": "Send",
    "중단": "Stop",
    "연구 실행을 중단하는 중…": "Stopping the research run…",
    "Agent runtime 연구 중…": "Agent runtime is researching…",
    "Agent runtime 준비": "Agent runtime ready",
    "첫 질문 실행": "Run first question",
    "저장된 첫 질문을 실행할 수 있습니다": "The saved first question is ready to run",
    "대화": "Conversation",
    "Research와 함께 보는 대화": "Conversation alongside Research",
    "원고를 선택해 주세요.": "Select a manuscript.",
    "저장된 원고는 브라우저형 탭에서 열리고, 우측 연구 채팅과 함께 편집됩니다.": "Saved manuscripts open in browser-style tabs and can be edited alongside the research chat.",
    "새 원고 만들기": "Create manuscript",
    "원고 내용을 입력하면 안전한 서식 미리보기가 여기에 표시됩니다.": "A safe formatted preview will appear here after you enter manuscript content.",
    "검증된 Lab 아티팩트": "Verified Lab artifact",
    "검증 캡처 열기 →": "Open verified capture →",
    "프로젝트 인용 근거": "Project citation evidence",
    "정확한 근거 열기 →": "Open exact evidence →",
    "원본 figure version에 고정됨": "Pinned to the source figure version",
    "원고 Markdown 편집기": "Manuscript Markdown editor",
    "원고의 Markdown 제목이 여기에 표시됩니다.": "Markdown headings will appear here.",
    "연결된 근거가 없습니다.": "No evidence is linked.",
    "AI가 주장·인용·그림을 프로젝트의 정확한 citation 또는 검증 캡처에 연결해야 합니다.": "AI must link claims, citations, and figures to exact project citations or verified captures.",
    "Claim ledger 없음": "No claim ledger",
    "AI가 현재 원고의 각 문장을 분류하고 정확한 근거 snapshot에 연결해야 합니다.": "AI must classify each statement in the current manuscript and link it to an exact evidence snapshot.",
    "저널 변경": "Change journal",
    "제출본 검사·생성": "Validate and generate submission",
    "타깃 저널이 아직 없습니다.": "No target journal yet.",
    "공식 저널 페이지를 먼저 스냅샷으로 고정하고, AI가 인용 가능한 문구만 규칙으로 변환합니다.": "First pin an official journal page snapshot. AI will convert only citable passages into rules.",
    "저널 타깃 설정": "Set target journal",
    "가이드라인 검사:": "Guidelines checked:",
    "단어 수:": "Words:",
    "그림:": "Figures:",
    "참고문헌:": "References:",
    "제출본 검사": "Validate submission",
    "원고 보기": "Manuscript view",
    "제출 준비": "Submission readiness",
    "AI 검토 요청": "Ask AI to review",
    "저장 중…": "Saving…",
    "새 버전 저장": "Save new version",
    "원고 목차": "Manuscript outline",
    "제출 준비 패널 닫기": "Close submission readiness panel",
    "제출 준비와 근거 검사": "Submission readiness and evidence checks",
    "핵심 섹션": "Core sections",
    "공식 스냅샷 고정": "Official snapshot pinned",
    "선택 필요": "Selection required",
    "검사 필요": "Inspection required",
    "검증 중…": "Validating…",
    "먼저 검증된 Data Table을 준비하세요.": "Prepare a verified Data Table first.",
    "입력": "Input",
    "계산": "Computation",
    "보존": "Preservation",
    "Data Table 준비하기": "Prepare Data Table",
    "Exact Data Table로 Kaplan–Meier 생존곡선을 만드세요.": "Create a Kaplan–Meier survival curve from an exact Data Table.",
    "Kaplan–Meier 분석은 임의 배열을 만들지 않습니다. CSV에서 생성된 exact Data Table version과 content hash를 선택한 뒤 해당 행만 결정적으로 투영합니다.": "Kaplan–Meier analysis never fabricates arrays. Select an exact Data Table version and content hash created from CSV, then project only its bound rows deterministically.",
    "요청이 시작된 뒤에도 성공으로 표시하지 않습니다. 검증된 artifact가 도착하면 이 Lab에 별도 탭으로 열립니다.": "A started request is not shown as successful. A verified artifact opens in a separate Lab tab when it arrives.",
    "Exact version 실행 요청 중…": "Requesting exact-version run…",
    "Research Director에게 exact run 요청": "Request exact run from Research Director",
    "분석할 CSV를 검증된 Data Table로 가져오세요.": "Import a CSV as a verified Data Table for analysis.",
    "CSV 데이터셋 가져오기": "Import CSV dataset",
    "검증하며 가져오는 중…": "Validating and importing…",
    "아직 저장된 아티팩트가 없습니다.": "No artifacts have been saved yet.",
    "연구 에이전트에게 이 Lab 사용 요청": "Ask the research agent to use this Lab",
    "아티팩트 보관소 · 작업공간": "Artifact repository · Workspace",
    "버전 비교": "Compare versions",
    "SVG 내보내기": "Export SVG",
    "PNG 600dpi 내보내기": "Export PNG at 600 dpi",
    "Figure Lab에 저장": "Save to Figure Lab",
    "Figure Lab에서 열기": "Open in Figure Lab",
    "Figure 확인 중…": "Checking Figure…",
    "통계 결과 산출물": "Statistical result outputs",
    "진단 기록 없음": "No diagnostic record",
    "이전": "Previous",
    "다음": "Next",
    "비교 종료": "Close comparison",
    "기준 버전": "Base version",
    "비교 버전": "Comparison version",
    "비교 모드": "Comparison mode",
    "저장된 버전만 읽기 전용으로 표시됩니다.": "Only saved versions are shown in read-only mode.",
    "현재": "Current",
    "대화 원본": "Conversation source",
    "읽기 전용 기록": "Read-only history",
    "과거 버전": "Historical version",
    "버전 기록": "Version history",
    "버전 기록을 불러오는 중…": "Loading version history…",
    "검증된 과거 버전을 불러오는 중…": "Loading verified historical version…",
    "저장된 버전만 기록됩니다. 과거 버전은 읽기 전용입니다.": "Only saved versions are recorded. Historical versions are read-only.",
    "다음 실험 제안": "Suggest next experiment",
    "실험 루프": "Experiment loop",
    "연구 생애주기": "Research lifecycle",
    "문맥 패널 닫기": "Close context panel",
    "선택된 근거가 없습니다.": "No evidence selected.",
    "검증된 renderer 상태가 없습니다.": "No verified renderer status is available.",
    "선택된 원고가 없습니다.": "No manuscript selected.",
    "저널 지침 검증 전": "Before journal guideline validation",
    "새 연구": "New research",
    "첫 질문과 프로젝트가 로컬 Science DB에 저장됩니다. 분석·출처·실험 결과는 실제 runtime이 생성한 뒤에만 표시됩니다.": "The first question and project are saved to the local Science database. Analyses, sources, and experiment results appear only after the runtime generates them.",
    "연구 질문": "Research question",
    "무엇을 발견하거나 검증하고 싶나요?": "What would you like to discover or verify?",
    "분야": "Field",
    "프로젝트 이름": "Project name",
    "선택": "Optional",
    "비워두면 질문에서 이름을 만듭니다": "Leave blank to create a name from the question",
    "취소": "Cancel",
    "프로젝트 만들기": "Create project",
    "일반 과학": "General science",
    "생명과학": "Life science",
    "화학": "Chemistry",
    "물리학": "Physics",
    "재료과학": "Materials science",
    "유전체학": "Genomics",
    "천문학": "Astronomy",
    "지구·생태": "Earth & ecology",
    "통계학": "Statistics",
    "경제학": "Economics",
    "금융 연구": "Finance research",
    "새 원고": "New manuscript",
    "원고 제목": "Manuscript title",
    "초기 Markdown": "Initial Markdown",
    "원고 만들기": "Create manuscript",
    "연구 계약 검토": "Review research contract",
    "실험을 시작하기 전에 목표, 성공 조건과 중단 기준을 확인하세요.": "Review the objective, success conditions, and stop criteria before starting experiments.",
    "연구 계약 초안을 승인하지 않고 닫기": "Close without approving the research contract draft",
    "닫기": "Close",
    "연구 목표": "Research objective",
    "성공 기준": "Success criteria",
    "연구를 계속할 수 있는 조건": "Conditions for continuing the research",
    "중단 기준": "Stop criteria",
    "중단하거나 다시 설계할 조건": "Conditions for stopping or redesigning the research",
    "운영 제약": "Operational constraints",
    "승인할 연구 계약 요약": "Summary of the research contract to approve",
    "승인 대상": "Approval target",
    "현재 버전 고정": "Current version pinned",
    "프로젝트": "Project",
    "연구 계약": "Research contract",
    "계약 ID": "Contract ID",
    "최대 에피소드": "Maximum episodes",
    "최대 시간(분)": "Maximum time (minutes)",
    "버전 보호": "Version protection",
    "승인 직전에 두 버전을 다시 확인합니다. 변경되면 자동 승인하지 않습니다.": "Both versions are checked again immediately before approval. Changes are never auto-approved.",
    "이 조합만 승인됩니다.": "Only this version pair will be approved.",
    "수정 요청": "Request changes",
    "최신 버전 확인 중…": "Checking latest versions…",
    "승인 대기": "Awaiting approval",
    "AI 초안": "AI draft",
    "등록된 성공 기준이 없습니다.": "No success criteria registered.",
    "등록된 중단 기준이 없습니다.": "No stop criteria registered.",
    "추가 운영 제약 없음": "No additional operational constraints",
    "연구 방향을 선택하세요": "Choose a research direction",
    "왜 지금 묻나요?": "Why ask now?",
    "답하지 않으면": "If you do not answer",
    "연구에 미치는 영향": "Research impact",
    "AI 추천": "AI recommendation",
    "장점": "Advantages",
    "주의점": "Cautions",
    "선택 이유": "Reason for selection",
    "선택 사항": "Optional",
    "판단 근거, 제약 또는 AI가 다음 단계에서 고려할 내용을 남겨 주세요.": "Add reasoning, constraints, or context for AI to consider in the next step.",
    "나중에": "Later",
    "적용 중…": "Applying…",
    "이 선택으로 계속": "Continue with this choice",
    "Science를 열 수 없습니다.": "Could not open Science.",
    "검증된 시각 캡처가 생성되면 여기에 표시됩니다.": "A verified visual capture will appear here when it is generated.",
    "출판 메타데이터 없음": "No publication metadata",
    "저자 정보 없음": "No author information",
    "OpenAlex 연결": "OpenAlex linked",
    "메타데이터 노드": "Metadata node",
    "논문 노드를 선택하세요": "Select a paper node",
    "천체를 선택하세요": "Select a celestial object",
    "모든 유형": "All types",
    "시야 초기화": "Reset view",
    "천체 유형": "Object type",
    "검증된 Vega 명세 또는 렌더러가 없습니다.": "No verified Vega specification or renderer is available.",
    "렌더러 실행에 실패했습니다.": "Renderer execution failed.",
    "검증된 문헌 네트워크 데이터 또는 Cytoscape 런타임이 없습니다.": "No verified literature network data or Cytoscape runtime is available.",
    "검증된 Statistical Analysis payload가 없습니다.": "No verified Statistical Analysis payload is available.",
    "검증된 Data Table payload가 없습니다.": "No verified Data Table payload is available.",
    "검증된 Physics measurement payload가 없습니다.": "No verified Physics measurement payload is available.",
    "검증된 Materials structure payload가 없습니다.": "No verified Materials structure payload is available.",
    "검증된 Genomics payload가 없습니다.": "No verified Genomics payload is available.",
    "검증된 SIMBAD sky catalog 또는 D3 런타임이 없습니다.": "No verified SIMBAD sky catalog or D3 runtime is available.",
    "Desktop renderer host가 이 확장 버전을 지원하지 않습니다.": "The Desktop renderer host does not support this extension version.",
    "Agentlas Desktop의 검증된 Science 확장에서 열어 주세요.": "Open this view from the verified Science extension in Agentlas Desktop.",
  }));

  const ENGLISH_PATTERNS = [
    [/^연구 컨텍스트: (.*) Lab와 함께 보는 대화$/, "Research context: Conversation alongside $1 Lab"],
    [/^연구 컨텍스트: (.*)와 함께 보는 대화$/, "Research context: Conversation alongside $1"],
    [/^(.*) Lab와 함께 보는 대화$/, "Conversation alongside $1 Lab"],
    [/^(.*)와 함께 보는 대화$/, "Conversation alongside $1"],
    [/^연구 컨텍스트: (.+)$/, "Research context: $1"],
    [/^(.*) Lab 시작 화면$/, "$1 Lab start screen"],
    [/^(.*) Lab 탭 닫기$/, "Close $1 Lab tab"],
    [/^(.*) Lab 그룹$/, "$1 Lab group"],
    [/^(.*) Lab 시작하기$/, "Start $1 Lab"],
    [/^인용 (.*)$/, "Citations $1"],
    [/^아티팩트 v(.*)$/, "Artifact v$1"],
    [/^현재 v(.*)$/, "Current v$1"],
    [/^v(.*) 기반 · 저장되지 않은 변경$/, "Based on v$1 · Unsaved changes"],
    [/^원고가 v(.*)로 변경되었습니다\. 현재 초안은 보존했으며 저장 전에 새 버전을 다시 확인해야 합니다\.$/, "The manuscript changed to v$1. Your draft was preserved; review the new version before saving."],
    [/^연구 실행이 (.*) 상태로 종료되었습니다\.$/, "The research run ended with status: $1."],
    [/^버전 (.*)$/, "Version $1"],
  ];

  const PROMPTS = {
    statisticsRun: {
      ko: ({ title, artifactVersion, contentSha256, timeColumn, eventColumn, request }) => `Research Director가 선택한 Data Table "${title}" exact v${artifactVersion} (${contentSha256})에서 ${timeColumn}/${eventColumn} 열을 직접 투영해 Kaplan–Meier 분석을 실행하도록 요청합니다. 아래 machine-readable 요청을 run_statistical_analysis 도구에 정확히 전달하세요. request.data를 만들거나 전달하지 말고, 도구가 반환한 ResearchRun과 immutable Statistical Analysis artifact가 실제로 저장되기 전에는 성공했다고 보고하지 마세요.\n\n${request}`,
      en: ({ title, artifactVersion, contentSha256, timeColumn, eventColumn, request }) => `Ask Research Director to run a Kaplan–Meier analysis by projecting the ${timeColumn}/${eventColumn} columns directly from the selected Data Table "${title}" exact v${artifactVersion} (${contentSha256}). Pass the machine-readable request below to the run_statistical_analysis tool exactly. Do not create or pass request.data, and do not report success until the tool has actually persisted a ResearchRun and an immutable Statistical Analysis artifact.\n\n${request}`,
    },
    reviseContract: {
      ko: ({ id, version }) => `현재 연구 계약 초안 ${id} v${version}은 승인하지 않고 유지합니다. 목표, 성공 기준, 실패 기준, 운영 제약과 실행 예산을 다시 검토해 필요한 변경을 설명하고, 변경이 필요하면 propose_research_contract로 새 draft 버전을 제안해 주세요. 사람의 승인 없이 다음 연구 단계로 진행하지 마세요.`,
      en: ({ id, version }) => `Keep the current research contract draft ${id} v${version} unapproved. Review its objective, success criteria, failure criteria, operational constraints, and execution budget, explain the changes needed, and use propose_research_contract to propose a new draft version when necessary. Do not proceed to the next research phase without human approval.`,
    },
    reviewManuscript: {
      ko: ({ title }) => `현재 원고 "${title}"의 정확한 현재 버전을 inspect_science_manuscript로 읽고, 프로젝트 근거와 검증된 Lab 아티팩트만 사용해 주장·인용·figure binding을 점검한 뒤 필요한 경우 새 immutable 원고 버전을 작성해 주세요. 근거 없는 주장은 명시적으로 표시하고 제출 준비 완료라고 가정하지 마세요.`,
      en: ({ title }) => `Read the exact current version of the manuscript "${title}" with inspect_science_manuscript. Review its claims, citations, and figure bindings using only project evidence and verified Lab artifacts, then create a new immutable manuscript version if needed. Mark unsupported claims explicitly and do not assume the manuscript is ready for submission.`,
    },
    useLab: {
      ko: ({ lab }) => `현재 연구 질문에 ${lab}을 실제로 사용해야 하는지 판단하고, 필요하면 사용할 정확한 입력·성공 기준·중단 조건을 먼저 제안한 뒤 실행해 주세요. 결과는 출처와 ResearchRun이 연결된 immutable Lab 아티팩트로 저장하세요.`,
      en: ({ lab }) => `Decide whether ${lab} is actually needed for the current research question. If so, first propose the exact inputs, success criteria, and stop conditions, then run it. Save the result as an immutable Lab artifact linked to its sources and ResearchRun.`,
    },
    nextExperiment: {
      ko: ({ title }) => `현재 ${title}의 관찰과 가설을 검토하고, 다음 실험 후보를 근거·성공 기준·중단 조건과 함께 제안해 주세요.`,
      en: ({ title }) => `Review the observations and hypotheses for ${title}, then propose the next experiment with supporting evidence, success criteria, and stop conditions.`,
    },
    inspectJournalGuidelines: {
      ko: ({ receiptId, receiptSha256, journalName, articleType, officialHosts, sourceUrls }) => `사람이 확인한 타깃 저널 identity receipt는 ${receiptId} (SHA-256 ${receiptSha256})입니다. 저널은 ${journalName}, article type은 ${articleType}이며 확인된 공식 host는 ${officialHosts.join(", ")}입니다. 다음 공식 URL을 각각 inspect_official_journal_guidelines 도구로 직접 검사하세요:\n${sourceUrls.map((sourceUrl) => `- ${sourceUrl}`).join("\n")}\n모든 inspection 결과의 normalizedText에 실제로 존재하는 exact evidenceQuote만 사용하세요. create_journal_profile_from_official_guidelines 호출에는 identity_receipt_id=${receiptId}를 정확히 넣고, identity/article-structure/length-limits/manuscript-files/figures-tables/references/supplements/data-code/ethics-conflicts/authorship/peer-review 11개 coverage category를 각각 한 번씩 covered, not-applicable 또는 unresolved로 기록하세요. 확인할 수 없는 항목은 반드시 unresolved이며 제출 준비 상태를 차단해야 합니다. 완료 후 receipt, inspection ID, 공식 host, response hash, profile ID/version/coverage 상태를 보고하세요.`,
      en: ({ receiptId, receiptSha256, journalName, articleType, officialHosts, sourceUrls }) => `The human-confirmed target-journal identity receipt is ${receiptId} (SHA-256 ${receiptSha256}). The journal is ${journalName}, the article type is ${articleType}, and the confirmed official hosts are ${officialHosts.join(", ")}. Inspect each official URL below directly with inspect_official_journal_guidelines:\n${sourceUrls.map((sourceUrl) => `- ${sourceUrl}`).join("\n")}\nUse only exact evidenceQuote text that is actually present in normalizedText from each inspection result. Pass identity_receipt_id=${receiptId} exactly to create_journal_profile_from_official_guidelines, and record each of the 11 coverage categories—identity, article-structure, length-limits, manuscript-files, figures-tables, references, supplements, data-code, ethics-conflicts, authorship, and peer-review—exactly once as covered, not-applicable, or unresolved. Any item that cannot be verified must remain unresolved and block submission readiness. When complete, report the receipt, inspection ID, official host, response hash, profile ID/version, and coverage status.`,
    },
  };

  let locale = "en";
  let observer = null;
  const untranslated = new Set();

  function normalizeLocale(value) {
    return String(value || "en").toLowerCase().startsWith("ko") ? "ko" : "en";
  }

  function translateText(value) {
    const input = String(value ?? "");
    if (locale === "ko" || !HANGUL.test(input)) return input;
    const leading = input.match(/^\s*/)?.[0] || "";
    const trailing = input.match(/\s*$/)?.[0] || "";
    const core = input.slice(leading.length, input.length - trailing.length || undefined);
    let output = ENGLISH_COPY.get(core);
    if (!output) output = core;
    for (const [pattern, replacement] of ENGLISH_PATTERNS) {
      if (pattern.test(output)) output = output.replace(pattern, replacement);
    }
    if (HANGUL.test(output)) {
      for (const [source, target] of [...ENGLISH_COPY.entries()].sort((a, b) => b[0].length - a[0].length)) {
        if (source.length < 4 || !output.includes(source)) continue;
        output = output.split(source).join(target);
      }
    }
    if (HANGUL.test(output)) untranslated.add(core);
    return `${leading}${output}${trailing}`;
  }

  function insideContentBoundary(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest?.(CONTENT_BOUNDARY_SELECTOR));
  }

  function localizeElement(element) {
    if (!(element instanceof Element) || insideContentBoundary(element)) return;
    for (const attribute of UI_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute);
      const next = translateText(current);
      if (next !== current) element.setAttribute(attribute, next);
    }
  }

  function localizeTree(target) {
    if (!target || locale === "ko") return;
    if (target.nodeType === Node.TEXT_NODE) {
      if (!insideContentBoundary(target)) target.nodeValue = translateText(target.nodeValue);
      return;
    }
    if (!(target instanceof Element || target instanceof DocumentFragment)) return;
    if (target instanceof Element) localizeElement(target);
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!insideContentBoundary(node)) node.nodeValue = translateText(node.nodeValue);
      } else localizeElement(node);
    }
  }

  function setLocale(value) {
    locale = normalizeLocale(value);
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
    untranslated.clear();
    if (document.body) localizeTree(document.body);
    return locale;
  }

  function observe(root) {
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") localizeElement(record.target);
        else for (const node of record.addedNodes) localizeTree(node);
      }
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: UI_ATTRIBUTES });
  }

  function prompt(key, variables = {}) {
    const resource = PROMPTS[key];
    if (!resource) throw new Error(`science-i18n-prompt-missing:${key}`);
    return resource[locale](variables);
  }

  window.agentlasScienceI18n = Object.freeze({
    get locale() { return locale; },
    normalizeLocale,
    setLocale,
    translateText,
    localizeTree,
    observe,
    prompt,
    getUntranslated: () => [...untranslated],
    resetUntranslated: () => untranslated.clear(),
  });
})();
