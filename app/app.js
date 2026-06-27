const app = document.querySelector("#app");

const PART_NAMES = {
  1: "Part 1 - Photographs",
  2: "Part 2 - Question-Response",
  3: "Part 3 - Conversations",
  4: "Part 4 - Talks",
  5: "Part 5 - Incomplete Sentences",
  6: "Part 6 - Text Completion",
  7: "Part 7 - Reading Comprehension",
};

const SECTION_TIME = {
  listening: 45 * 60,
  reading: 75 * 60,
};

const LISTENING_DELAY_KEY = "toeic-listening-delay-seconds";

function loadListeningDelay() {
  const value = Number(localStorage.getItem(LISTENING_DELAY_KEY));
  return Number.isFinite(value) ? Math.max(0, Math.min(20, Math.round(value))) : 5;
}

const state = {
  screen: "home",
  tests: [],
  lcQuestions: {},
  attempts: [],
  answerKeys: {},
  selectedTestId: "",
  mode: "strict",
  examScope: "full",
  drillQuestions: [],
  drillSourceAttemptId: null,
  drillTitle: "",
  section: "listening",
  test: null,
  listeningIndex: 0,
  readingIndex: 0,
  answers: {},
  marked: {},
  elapsedByQuestion: {},
  questionStartedAt: Date.now(),
  startedAt: null,
  submittedAttempt: null,
  timerRemaining: { listening: SECTION_TIME.listening, reading: SECTION_TIME.reading },
  tickId: null,
  transitionId: null,
  transitionRemaining: 0,
  listeningDelaySeconds: loadListeningDelay(),
  pageOffsets: { listening: 0, reading: 0 },
  audio: null,
  audioStarted: false,
  audioError: "",
  audioReady: false,
  allowAudioStop: false,
  reviewAudio: null,
  dialog: null,
  answerKey: {},
  prepStep: 0,
  pendingInitialSection: "listening",
  reviewFilter: "all",
  reviewSourceQuestion: null,
  questionListOpen: false,
  readingReviewUnlocked: false,
  strictSourceVisible: false,
  dev: false,
};

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

let lastPushedScreen = null;

function syncHistory() {
  if (state.screen === lastPushedScreen) return;
  if (lastPushedScreen === null) {
    history.replaceState({ screen: state.screen }, "");
  } else {
    history.pushState({ screen: state.screen }, "");
  }
  lastPushedScreen = state.screen;
  if (state.screen === "exam") {
    window.addEventListener("beforeunload", onBeforeUnload);
  } else {
    window.removeEventListener("beforeunload", onBeforeUnload);
  }
}

function onBeforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";
}

function encodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(seconds) {
  const clamped = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(clamped / 60)).padStart(2, "0");
  const ss = String(clamped % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function qRange(item) {
  return item.start === item.end ? `${item.start}` : `${item.start}-${item.end}`;
}

function questionsFor(item) {
  return Array.from({ length: item.end - item.start + 1 }, (_, index) => item.start + index);
}

function currentItem() {
  if (state.examScope === "drill") {
    const question = state.drillQuestions[state.readingIndex] || state.drillQuestions[0] || 101;
    return { start: question, end: question, part: partOfQuestion(question) };
  }
  return state.section === "listening"
    ? state.test.listening[state.listeningIndex]
    : state.test.reading[state.readingIndex];
}

function currentQuestionNumber() {
  const item = currentItem();
  return state.section === "listening" ? item.start : item.start;
}

function examQuestionTitle() {
  const item = currentItem();
  if (state.section === "listening") {
    return item.start === item.end
      ? `Listening: Questions ${item.start} of 200`
      : `Listening: Questions ${item.start} - ${item.end} of 200`;
  }
  const questions = state.examScope === "drill" ? state.drillQuestions : scopeQuestions();
  const position = Math.max(1, state.readingIndex + 1);
  if (state.examScope === "drill") return `Drill: Question ${position} of ${questions.length}`;
  return `Reading: Questions ${currentItem().start} of 200`;
}

function examAnsweredTitle() {
  const all = state.examScope === "full"
    ? Array.from({ length: 200 }, (_, index) => index + 1)
    : scopeQuestions();
  return `${all.filter((question) => state.answers[question]).length}/${all.length}`;
}

function saveQuestionTime() {
  const number = currentQuestionNumber();
  if (!number || !state.questionStartedAt) return;
  const elapsed = Math.round((Date.now() - state.questionStartedAt) / 1000);
  state.elapsedByQuestion[number] = (state.elapsedByQuestion[number] || 0) + Math.max(0, elapsed);
  state.questionStartedAt = Date.now();
}

function cachedAnswerKey(testId) {
  return state.answerKeys[testId] || {};
}

async function fetchAnswerKey(testId) {
  if (state.answerKeys[testId]) return state.answerKeys[testId];
  const response = await fetch(`/api/answer-keys/${encodeURIComponent(testId)}`);
  const payload = await response.json();
  const serverKey = payload.key || {};
  state.answerKeys[testId] = serverKey;
  return state.answerKeys[testId];
}

async function saveAnswerKey(testId, key) {
  const response = await fetch(`/api/answer-keys/${encodeURIComponent(testId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const payload = await response.json();
  state.answerKeys[testId] = payload.key || {};
  return state.answerKeys[testId];
}

function answerCount(rangeStart, rangeEnd) {
  let count = 0;
  for (let q = rangeStart; q <= rangeEnd; q += 1) {
    if (state.answers[q]) count += 1;
  }
  return count;
}

function unansweredCount(rangeStart, rangeEnd) {
  return rangeEnd - rangeStart + 1 - answerCount(rangeStart, rangeEnd);
}

function scopeQuestions(scope = state.examScope) {
  if (scope === "drill") return [...state.drillQuestions].sort((a, b) => a - b);
  const range = scopeRange(scope);
  return Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);
}

function attemptQuestions(attempt) {
  if ((attempt.scope || "full") === "drill") return [...(attempt.drillQuestions || [])].sort((a, b) => a - b);
  const range = scopeRange(attempt.scope || "full");
  return Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);
}

function scopeAnsweredCount(scope = state.examScope, answers = state.answers) {
  return scopeQuestions(scope).filter((question) => answers[question]).length;
}

function scopeUnansweredCount(scope = state.examScope, answers = state.answers) {
  return scopeQuestions(scope).filter((question) => !answers[question]).length;
}

function partOfQuestion(question) {
  if (question <= 6) return 1;
  if (question <= 31) return 2;
  if (question <= 70) return 3;
  if (question <= 100) return 4;
  if (question <= 130) return 5;
  if (question <= 146) return 6;
  return 7;
}

function partRanges() {
  return [
    { part: 1, label: "Part 1", start: 1, end: 6 },
    { part: 2, label: "Part 2", start: 7, end: 31 },
    { part: 3, label: "Part 3", start: 32, end: 70 },
    { part: 4, label: "Part 4", start: 71, end: 100 },
    { part: 5, label: "Part 5", start: 101, end: 130 },
    { part: 6, label: "Part 6", start: 131, end: 146 },
    { part: 7, label: "Part 7", start: 147, end: 200 },
  ];
}

function scopeRange(scope = state.examScope) {
  if (scope === "drill") {
    const questions = state.drillQuestions.length ? state.drillQuestions : [101];
    const start = Math.min(...questions);
    const end = Math.max(...questions);
    return { start, end, total: questions.length, label: state.drillTitle || "Drill" };
  }
  return scope === "reading"
    ? { start: 101, end: 200, total: 100, label: "Reading practice" }
    : { start: 1, end: 200, total: 200, label: "Full test" };
}

function isInScope(question, scope = state.examScope) {
  if (scope === "drill") return state.drillQuestions.includes(question);
  const range = scopeRange(scope);
  return question >= range.start && question <= range.end;
}

function pageFor(testNumber, section, question) {
  if (section === "listening") {
    const base = 1 + (testNumber - 1) * 14;
    if (question <= 6) return base + Math.floor((question - 1) / 2);
    if (question <= 31) return base + 4 + Math.floor((question - 7) / 8);
    if (question <= 70) return base + 7 + Math.floor((question - 32) / 9);
    return base + 11 + Math.floor((question - 71) / 12);
  }
  const base = 1 + (testNumber - 1) * 30;
  if (question <= 130) return base + Math.floor((question - 101) / 8);
  if (question <= 146) return base + 5 + Math.floor((question - 131) / 4);
  return base + 10 + Math.floor((question - 147) / 4);
}

function listeningItemForQuestion(test, question) {
  return test.listening.find((item) => question >= item.start && question <= item.end);
}

function pdfPageImage(kind, page) {
  return `/api/pdf-page?kind=${encodeURIComponent(kind)}&page=${encodeURIComponent(page)}`;
}

function dataAssetUrl(path) {
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function lcQuestionData(question) {
  return state.lcQuestions[state.test?.id]?.questions?.[question] || null;
}

function previewPage(section, basePage) {
  return Math.max(1, basePage + (state.pageOffsets[section] || 0));
}

function pageControls(section, page) {
  return `
    <div class="page-controls">
      <button class="page-btn" data-page-section="${section}" data-page-delta="-1" aria-label="Previous source page">‹</button>
      <span>Page ${page}</span>
      <button class="page-btn" data-page-section="${section}" data-page-delta="1" aria-label="Next source page">›</button>
    </div>
  `;
}

async function bootstrap() {
  const [configResponse, testsResponse, attemptsResponse] = await Promise.all([
    fetch("/api/config"),
    fetch("/api/tests"),
    fetch("/api/attempts"),
  ]);
  state.dev = (await configResponse.json()).dev === true;
  state.tests = (await testsResponse.json()).tests;
  state.attempts = (await attemptsResponse.json()).attempts;
  const lcQuestionEntries = await Promise.all(state.tests.map(async (test) => {
    const response = await fetch(`/data/questions-lc-test${test.testNumber}.json`);
    if (!response.ok) return [test.id, { questions: {} }];
    return [test.id, await response.json()];
  }));
  state.lcQuestions = Object.fromEntries(lcQuestionEntries);
  state.selectedTestId = qs("test") || state.tests[0]?.id || "";
  const uniqueTestIds = [...new Set(state.attempts.slice(0, 6).map((a) => a.testId))];
  await Promise.all(uniqueTestIds.map((id) => fetchAnswerKey(id)));
  window.addEventListener("keydown", handleKeyboard, true);
  installMediaKeyBlockers();
  window.addEventListener("popstate", (event) => {
    const target = event.state?.screen;
    if (!target) return;
    if (state.screen === "exam") {
      if (!confirm("Rời khỏi bài thi sẽ mất tiến độ. Bạn có chắc không?")) {
        history.pushState({ screen: state.screen }, "");
        return;
      }
      pauseAudioForAppFlow();
      if (state.tickId) { clearInterval(state.tickId); state.tickId = null; }
      if (state.transitionId) { clearInterval(state.transitionId); state.transitionId = null; }
      state.audio = null;
    }
    lastPushedScreen = target;
    state.screen = target;
    render();
  });
  render();
}

function handleKeyboard(event) {
  if (state.screen !== "exam" || state.dialog) return;
  if (shouldBlockExamKey(event)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const key = event.key.toUpperCase();
  if (["A", "B", "C", "D"].includes(key)) {
    const item = currentItem();
    const target = questionsFor(item).find((question) => !state.answers[question]) || item.start;
    const maxChoice = partOfQuestion(target) === 2 ? 3 : 4;
    if (["A", "B", "C", "D"].slice(0, maxChoice).includes(key)) {
      state.answers[target] = key;
      renderExam();
    }
    return;
  }

  if (state.section !== "reading") return;
  if (key === "M") {
    const q = currentItem().start;
    state.marked[q] = !state.marked[q];
    renderExam();
  }
  if (event.key === "ArrowRight") {
    moveReading(1);
  }
  if (event.key === "ArrowLeft") {
    moveReading(-1);
  }
}

function shouldBlockExamKey(event) {
  const blockedMediaKeys = new Set([
    "MediaPlayPause",
    "MediaTrackNext",
    "MediaTrackPrevious",
    "MediaStop",
    "LaunchMediaPlayer",
  ]);
  if (blockedMediaKeys.has(event.key)) return true;
  return state.section === "listening" && (event.key === " " || event.code === "Space");
}

function installMediaKeyBlockers() {
  if (!("mediaSession" in navigator)) return;
  for (const action of ["play", "pause", "stop", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"]) {
    try {
      navigator.mediaSession.setActionHandler(action, () => {
        if (state.screen === "exam" && state.section === "listening") resumeLockedListeningAudio();
      });
    } catch {
      // Browser does not support every media session action.
    }
  }
}

function pauseAudioForAppFlow() {
  if (!state.audio) return;
  state.allowAudioStop = true;
  state.audio.pause();
  state.allowAudioStop = false;
}

function resumeLockedListeningAudio() {
  if (state.allowAudioStop || state.screen !== "exam" || state.section !== "listening") return;
  if (!state.audio || !state.audioStarted || state.audio.ended) return;
  state.audio.play().catch(() => {});
}

function render() {
  syncHistory();
  clearIntervalsIfNeeded();
  if (state.screen === "home") return renderHome();
  if (state.screen === "prep") return renderPrep();
  if (state.screen === "exam") return renderExam();
  if (state.screen === "result") return renderResult();
  if (state.screen === "review") return renderReview(state.submittedAttempt);
}

function clearIntervalsIfNeeded() {
  if (state.screen !== "exam") {
    if (state.tickId) clearInterval(state.tickId);
    if (state.transitionId) clearInterval(state.transitionId);
    state.tickId = null;
    state.transitionId = null;
    if (state.audio) {
      pauseAudioForAppFlow();
      state.audio = null;
    }
  }
  if (state.screen !== "review" && state.reviewAudio) {
    state.reviewAudio.pause();
    state.reviewAudio = null;
  }
}

function attemptScoreLabel(attempt) {
  const key = state.answerKeys[attempt.testId] || attempt.answerKey || {};
  const answers = attempt.answers || {};
  const lQs = Object.keys(key).map(Number).filter((q) => q >= 1 && q <= 100);
  const rQs = Object.keys(key).map(Number).filter((q) => q >= 101 && q <= 200);
  if (!lQs.length && !rQs.length) return null;
  const lScore = lQs.length ? scaledScore((lQs.filter((q) => answers[q] === key[q]).length / lQs.length) * 100, "listening") : null;
  const rScore = rQs.length ? scaledScore((rQs.filter((q) => answers[q] === key[q]).length / rQs.length) * 100, "reading") : null;
  return `${(lScore ?? 0) + (rScore ?? 0)}/990`;
}

function renderHome() {
  const latest = state.attempts.slice(0, 6);
  app.innerHTML = `
    <main class="home-shell">
      <section class="home-main">
        <div class="brand-row">
          <div class="brand-mark">ETS</div>
          <div>
            <h1>ETS TOEIC Computer-Based Test</h1>
            <p>Mô phỏng thao tác thi IIG trên máy: Listening tự chạy, Reading chia đôi, có mark review và xem lại bài làm.</p>
          </div>
        </div>

        <div class="setup-panel">
          <label class="field-label" for="testSelect">Chọn bộ đề ETS 2026</label>
          <select id="testSelect" class="select" style="margin-bottom: 1rem">
            ${state.tests.map((test) => `
              <option value="${test.id}" ${test.id === state.selectedTestId ? "selected" : ""}>
                ${test.title} · ${test.listening.length} audio files
              </option>
            `).join("")}
          </select>

          <label class="field-label" for="delayInput">Listening delay between items (seconds)</label>
          <input id="delayInput" class="number-input" type="number" min="0" max="20" step="1" value="${state.listeningDelaySeconds}">

          <div class="start-actions">
            <button class="primary-btn" id="startBtn">Start full test</button>
          </div>
        </div>
      </section>

      <aside class="home-side">
        <h2>Recent attempts</h2>
        ${latest.length ? latest.map((attempt) => {
          const score = attemptScoreLabel(attempt);
          return `
            <div class="attempt-row">
              <button class="attempt-review-btn" data-review="${attempt.id}">
                <div class="attempt-row-main">
                  <span>${encodeHtml(attempt.testTitle || attempt.testId)}</span>
                  <small>${new Date(attempt.submittedAt).toLocaleString("vi-VN")}</small>
                </div>
                <strong class="attempt-score ${score ? "" : "muted"}">${score ?? "---/990"}</strong>
              </button>
              <button class="attempt-delete-btn" data-delete-attempt="${attempt.id}" aria-label="Delete attempt">Delete</button>
            </div>
          `;
        }).join("") : `<p class="muted">Chưa có lượt làm nào.</p>`}
      </aside>
    </main>
  `;

  document.querySelector("#testSelect").addEventListener("change", (event) => {
    state.selectedTestId = event.target.value;
  });
  document.querySelector("#delayInput").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    state.listeningDelaySeconds = Number.isFinite(value) ? Math.max(0, Math.min(20, Math.round(value))) : 5;
    localStorage.setItem(LISTENING_DELAY_KEY, String(state.listeningDelaySeconds));
    event.target.value = state.listeningDelaySeconds;
  });
  document.querySelector("#startBtn").addEventListener("click", () => startPrep("listening"));
  document.querySelectorAll("[data-review]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.submittedAttempt = state.attempts.find((item) => item.id === button.dataset.review);
      await fetchAnswerKey(state.submittedAttempt.testId);
      state.drillQuestions = state.submittedAttempt.drillQuestions || [];
      state.drillTitle = state.submittedAttempt.drillTitle || "";
      state.reviewFilter = "all";
      state.reviewSourceQuestion = null;
      state.screen = "review";
      render();
    });
  });
  document.querySelectorAll("[data-delete-attempt]").forEach((button) => {
    button.addEventListener("click", async () => {
      const attempt = state.attempts.find((item) => item.id === button.dataset.deleteAttempt);
      if (!attempt) return;
      if (!confirm(`Xoá attempt "${attempt.testTitle || attempt.testId}"? Hành động này không thể hoàn tác.`)) return;
      const response = await fetch(`/api/attempts/${encodeURIComponent(attempt.id)}`, { method: "DELETE" });
      if (!response.ok) {
        alert("Không xoá được attempt này. Hãy thử lại sau.");
        return;
      }
      state.attempts = state.attempts.filter((item) => item.id !== attempt.id);
      if (state.submittedAttempt?.id === attempt.id) state.submittedAttempt = null;
      renderHome();
    });
  });
}

async function startPrep(initialSection = "listening") {
  state.test = state.tests.find((test) => test.id === state.selectedTestId) || state.tests[0];
  state.pendingInitialSection = initialSection;
  state.prepStep = 0;
  state.audioReady = initialSection === "reading";
  state.answerKey = await fetchAnswerKey(state.test.id);
  state.screen = "prep";
  render();
}

function renderPrep() {
  const steps = prepSteps();
  const step = steps[state.prepStep];
  app.innerHTML = `
    <main class="prep-shell">
      <header class="prep-header">
        <div>
          <h1>${step.title}</h1>
          <p>${state.test.title} · Full Listening &amp; Reading test</p>
        </div>
        <div class="prep-progress">${state.prepStep + 1}/3</div>
      </header>
      <section class="prep-panel">
        ${step.body}
      </section>
      <footer class="prep-actions">
        <button class="ghost-btn" id="prepBackBtn">${state.prepStep === 0 ? "Back home" : "Back"}</button>
        <button class="primary-btn" id="prepNextBtn" ${prepNextDisabled() ? "disabled" : ""}>${state.prepStep === steps.length - 1 ? "Begin test" : "Next"}</button>
      </footer>
    </main>
  `;

  document.querySelector("#prepBackBtn").addEventListener("click", () => {
    if (state.prepStep === 0) {
      state.screen = "home";
    } else {
      state.prepStep -= 1;
    }
    render();
  });
  document.querySelector("#prepNextBtn").addEventListener("click", () => {
    if (state.prepStep < steps.length - 1) {
      state.prepStep += 1;
      render();
    } else {
      startExam(state.pendingInitialSection);
    }
  });
  document.querySelector("#soundCheckBtn")?.addEventListener("click", playSoundCheck);
}

function prepNextDisabled() {
  return state.pendingInitialSection === "listening" && state.prepStep === 1 && !state.audioReady;
}

function prepSteps() {
  const firstAudio = state.test?.listening?.[0]?.audioUrl || "";
  return [
    {
      title: "Candidate information",
      body: `
        <div class="prep-grid">
          <div><span>Test</span><strong>${state.test.title}</strong></div>
          <div><span>Mode</span><strong>IIG strict</strong></div>
          <div><span>Scope</span><strong>Full Listening &amp; Reading</strong></div>
          <div><span>Answer key</span><strong>${Object.keys(state.answerKey || {}).length || 0} saved</strong></div>
        </div>
        <div class="prep-note">
          Confirm the selected test before starting. The timer does not begin until the final Begin test button.
        </div>
      `,
    },
    {
      title: "Sound check",
      body: `
        <div class="sound-card">
          <div>
            <strong>Check your headphones or speaker</strong>
            <p id="soundCheckStatus">${state.audioReady ? "Audio is enabled for this test session." : "Play the sample once to enable audio before the Listening timer starts."}</p>
          </div>
          <button class="primary-btn" id="soundCheckBtn" ${firstAudio ? "" : "disabled"}>${state.audioReady ? "Replay sample" : "Play sample"}</button>
        </div>
        <audio id="soundCheckAudio" src="${firstAudio}" preload="auto"></audio>
      `,
    },
    {
      title: "Directions",
      body: `
        <div class="directions-list">
          <p>Listening starts first with a 45-minute timer. Audio is controlled by the test flow and each item advances automatically.</p>
          <p>After Listening finishes, Reading starts with a 75-minute timer. Listening previous items remain locked.</p>
          <p>Use Finish test to submit. After submission, open Review to inspect answers, source PDF pages, marked items, wrong items, and unanswered items.</p>
        </div>
      `,
    },
  ];
}

function playSoundCheck() {
  const audio = document.querySelector("#soundCheckAudio");
  if (!audio) return;
  audio.currentTime = 0;
  audio.play()
    .then(() => {
      state.audioReady = true;
      const next = document.querySelector("#prepNextBtn");
      const button = document.querySelector("#soundCheckBtn");
      const status = document.querySelector("#soundCheckStatus");
      if (next) next.disabled = false;
      if (button) button.textContent = "Replay sample";
      if (status) status.textContent = "Audio is enabled for this test session.";
    })
    .catch(() => {
      alert("Browser blocked audio. Click Play sample again after interacting with the page.");
    });
}

function startExam(initialSection = "listening") {
  if (initialSection !== "drill") {
    state.examScope = initialSection === "reading" ? "reading" : "full";
    state.drillQuestions = [];
    state.drillSourceAttemptId = null;
    state.drillTitle = "";
  }
  state.section = initialSection === "listening" ? "listening" : "reading";
  state.listeningIndex = 0;
  state.readingIndex = 0;
  state.answers = {};
  state.marked = {};
  state.elapsedByQuestion = {};
  state.timerRemaining = {
    listening: SECTION_TIME.listening,
    reading: state.examScope === "drill" ? Math.min(SECTION_TIME.reading, Math.max(300, state.drillQuestions.length * 75)) : SECTION_TIME.reading,
  };
  state.startedAt = new Date().toISOString();
  state.questionStartedAt = Date.now();
  state.audioStarted = false;
  state.audioError = "";
  state.dialog = null;
  state.questionListOpen = false;
  state.readingReviewUnlocked = false;
  state.pageOffsets = { listening: 0, reading: 0 };
  state.strictSourceVisible = false;
  state.screen = "exam";
  render();
  if (state.section === "listening") {
    playCurrentAudio();
  }
}

function renderExam() {
  window.scrollTo(0, 0);
  const item = currentItem();
  app.innerHTML = `
    <div class="exam-shell">
      <header class="exam-header">
        <div class="ets-logo">ETS<span>TOEIC</span></div>
        <div class="exam-title">${examQuestionTitle()}</div>
        <div class="header-meta">
          <div class="answered-pill">${examAnsweredTitle()}</div>
          ${state.section === "reading" ? `<div class="timer" aria-live="polite">◷ ${formatTime(state.timerRemaining[state.section])}</div>` : ""}
          <button class="submit-btn" id="finishBtn">End practice</button>
        </div>
      </header>

      <main class="exam-work ${state.section}">
          ${state.section === "listening" ? listeningView(item) : readingView(item)}
      </main>
      ${examBottomBar()}
      ${state.questionListOpen ? questionListPanel() : ""}
      ${state.dialog === "finish-info" ? finishInfoDialog() : ""}
      ${state.dialog === "finish-test" ? finishTestDialog() : ""}
    </div>
  `;

  bindExamEvents();
  startTimer();
}

function listeningView(item) {
  return `
    <section class="stimulus-pane">
      <div class="stimulus-card">
        <div class="stimulus-title">
          <span>${item.part === 1 ? "Select the one statement that best describes what you see in the picture." : PART_NAMES[item.part]}</span>
        </div>
        ${listeningStimulus(item)}
      </div>
      
      ${state.audioError ? `<div class="error-banner">${encodeHtml(state.audioError)}</div>` : ""}
      ${state.transitionRemaining > 0 ? `<div class="transition-bar">Next item in ${state.transitionRemaining}s</div>` : ""}
    </section>
    <section class="answer-pane">
      <h2>Question</h2>
      <div class="question-stack">
        ${questionsFor(item).map((question) => listeningQuestion(question)).join("")}
      </div>
    </section>
  `;
}

function listeningStimulus(item) {
  if (item.part === 1) {
    const question = lcQuestionData(item.start);
    return question?.imagePath
      ? `<img class="part1-photo" src="${dataAssetUrl(question.imagePath)}" alt="Question ${item.start} photo">`
      : listeningBlankStimulus(item);
  }

  if (item.part === 2) return listeningBlankStimulus(item);

  const graphics = questionsFor(item)
    .map((questionNumber) => ({ questionNumber, data: lcQuestionData(questionNumber) }))
    .filter((question) => question.data?.graphicImagePath);

  if (!graphics.length) return listeningBlankStimulus(item);

  return `
    <div class="graphic-stack">
      ${graphics.map((question) => `
        <img class="listening-graphic" src="${dataAssetUrl(question.data.graphicImagePath)}" alt="Graphic for question ${question.questionNumber}">
      `).join("")}
    </div>
  `;
}

function listeningBlankStimulus(item) {
  return `
    <div class="blank-stimulus">
      <strong>${PART_NAMES[item.part]}</strong>
      <span>Listen to the audio and answer the question on the right.</span>
    </div>
  `;
}

function finishTestDialog() {
  const scope = scopeRange();
  return `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="finishTitle">
      <section class="modal">
        <h2 id="finishTitle">Finish test?</h2>
        <p>This will end the practice session, save your answers, and show your score before opening the review screen.</p>
        ${state.examScope === "full" ? `
          <p>Listening unanswered: <strong>${unansweredCount(1, 100)}</strong></p>
          <p>Reading unanswered: <strong>${unansweredCount(101, 200)}</strong></p>
        ` : `<p>${scope.label} unanswered: <strong>${scopeUnansweredCount()}</strong></p>`}
        <div class="modal-actions">
          <button class="ghost-btn" id="cancelFinishBtn">Cancel</button>
          <button class="primary-btn" id="confirmFinishBtn">Show score</button>
        </div>
      </section>
    </div>
  `;
}

function finishInfoDialog() {
  const reviewUnlocked = state.section === "reading" && state.readingReviewUnlocked;
  return `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="finishInfoTitle">
      <section class="modal">
        <h2 id="finishInfoTitle">Practice control</h2>
        <p>This button is only for this practice app. In the real TOEIC test, this navigation button is not shown.</p>
        <p>${reviewUnlocked
          ? "You have reached the review step, so you can use the question list to check answers before saving."
          : "The question list stays hidden while you are taking the test. It unlocks only after you move past the final Reading question."}</p>
        <div class="modal-actions">
          <button class="ghost-btn" id="cancelFinishInfoBtn">Continue test</button>
          <button class="primary-btn" id="openFinishBtn">Save options</button>
        </div>
      </section>
    </div>
  `;
}

function examBottomBar() {
  const item = currentItem();
  const canMove = state.section === "reading";
  const maxIndex = state.examScope === "drill" ? state.drillQuestions.length - 1 : state.test.reading.length - 1;
  const isFinalReadingQuestion = state.section === "reading" && state.readingIndex === maxIndex;
  const canOpenQuestionList = state.section === "reading" && (state.readingReviewUnlocked || isFinalReadingQuestion);
  return `
    <footer class="exam-bottom">
      <label class="review-check ${state.section === "reading" ? "" : "disabled"}">
        <input type="checkbox" id="bottomMarkCheck" ${state.marked[item.start] ? "checked" : ""} ${state.section === "reading" ? "" : "disabled"}>
        <span>Mark item for review</span>
      </label>
      <div class="bottom-actions">
        ${state.section === "listening" && state.dev ? `<button class="dev-skip-btn bottom-dev-skip" id="devSkipBtn">⏭ Skip</button>` : ""}
        ${canOpenQuestionList ? `<button class="bottom-list-btn ${state.questionListOpen ? "active" : ""}" id="questionListToggle" aria-label="Question list">☷</button>` : ""}
        <button class="bottom-nav prev" id="bottomPrevBtn" ${canMove && state.readingIndex > 0 ? "" : "disabled"} aria-label="Previous">‹</button>
        <button class="bottom-nav next" id="bottomNextBtn" ${canMove ? "" : "disabled"} aria-label="Next">›</button>
        ${isFinalReadingQuestion ? `<button class="bottom-finish-btn" id="bottomFinishBtn">Finish test</button>` : ""}
      </div>
    </footer>
  `;
}

function questionListPanel() {
  const current = currentItem();
  const questions = state.section === "listening"
    ? Array.from({ length: 100 }, (_, index) => index + 1)
    : Array.from({ length: 100 }, (_, index) => index + 101);
  return `
    <aside class="question-popover">
      <div class="question-popover-head">
        <strong>Question list</strong>
        <button class="ghost-btn" id="questionListClose">Close</button>
      </div>
      ${navigatorGrid(questions, current)}
      <div class="legend">
        <span><i class="dot answered"></i>Answered</span>
        <span><i class="dot marked"></i>Marked</span>
        <span><i class="dot current"></i>Current</span>
      </div>
    </aside>
  `;
}

function listeningQuestion(question) {
  const count = partOfQuestion(question) === 2 ? 3 : 4;
  const data = lcQuestionData(question);
  const showText = partOfQuestion(question) >= 3;
  return `
    <article class="question-card answer-card ${state.answers[question] ? "answered" : ""}">
      <div class="question-head">
        <strong>${question}.</strong>
      </div>
      ${showText && data?.text ? `<p class="prompt">${encodeHtml(data.text)}</p>` : ""}
      ${choices(question, count, showText ? data?.choices : null)}
    </article>
  `;
}

function readingView(item) {
  const question = item.start;
  const page = previewPage("reading", pageFor(state.test.testNumber, "reading", question));
  return `
    <section class="stimulus-pane">
      <div class="stimulus-card">
        <div class="stimulus-title">
          <span>Reading passage</span>
          ${pageControls("reading", page)}
        </div>
        <img class="pdf-page" src="${pdfPageImage("reading", page)}" alt="Reading source page ${page}">
      </div>
    </section>
    <section class="answer-pane">
      <h2>Question</h2>
      <article class="question-card answer-card active">
        <div class="question-head">
          <strong>${question}.</strong>
        </div>
        ${choices(question, 4)}
      </article>
    </section>
  `;
}

function choices(question, count = 4, choiceTexts = null) {
  return `
    <div class="choices" role="radiogroup" aria-label="Question ${question}">
      ${["A", "B", "C", "D"].slice(0, count).map((letter) => `
        <label class="choice ${state.answers[question] === letter ? "selected" : ""}">
          <input type="radio" name="q-${question}" value="${letter}" ${state.answers[question] === letter ? "checked" : ""}>
          <span class="choice-disc">${letter}</span>
          ${choiceTexts?.[letter] ? `<span class="choice-text">${encodeHtml(choiceTexts[letter])}</span>` : ""}
        </label>
      `).join("")}
    </div>
  `;
}

function navigatorGrid(questions = null, current = currentItem()) {
  const list = questions || (state.section === "listening"
    ? Array.from({ length: 100 }, (_, index) => index + 1)
    : scopeQuestions());
  const buttons = [];
  for (const q of list) {
    const isCurrent = q >= current.start && q <= current.end;
    const disabled = state.section === "listening" && q < current.start;
    buttons.push(`
      <button
        class="q-nav ${state.answers[q] ? "answered" : ""} ${state.marked[q] ? "marked" : ""} ${isCurrent ? "current" : ""}"
        data-q="${q}"
        ${disabled ? "disabled" : ""}
      >${q}</button>
    `);
  }
  return `<div class="q-grid">${buttons.join("")}</div>`;
}

function bindExamEvents() {
  document.querySelectorAll(".choice input").forEach((input) => {
    input.addEventListener("change", (event) => {
      const question = Number(event.target.name.replace("q-", ""));
      state.answers[question] = event.target.value;
      renderExam();
    });
  });

  document.querySelector("#finishBtn").addEventListener("click", () => showFinishInfo());
  document.querySelector("#soundBtn")?.addEventListener("click", () => {
    if (state.section === "listening") playCurrentAudio();
  });
  document.querySelector("#cancelFinishInfoBtn")?.addEventListener("click", () => {
    state.dialog = null;
    renderExam();
  });
  document.querySelector("#openFinishBtn")?.addEventListener("click", () => {
    confirmFinishTest();
  });
  document.querySelector("#cancelFinishBtn")?.addEventListener("click", () => {
    state.dialog = null;
    renderExam();
  });
  document.querySelector("#confirmFinishBtn")?.addEventListener("click", () => submitAttempt("manual"));
  document.querySelector("#playAudioBtn")?.addEventListener("click", playCurrentAudio);
  document.querySelector("#devSkipBtn")?.addEventListener("click", () => {
    pauseAudioForAppFlow();
    if (state.transitionId) { clearInterval(state.transitionId); state.transitionId = null; }
    state.transitionRemaining = 0;
    nextListeningItem();
  });
  document.querySelectorAll("[data-page-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.dataset.pageSection;
      const delta = Number(button.dataset.pageDelta || 0);
      state.pageOffsets[section] = (state.pageOffsets[section] || 0) + delta;
      renderExam();
    });
  });
  document.querySelector("#showSourceBtn")?.addEventListener("click", () => {
    state.strictSourceVisible = true;
    renderExam();
  });
  document.querySelector("#hideSourceBtn")?.addEventListener("click", () => {
    state.strictSourceVisible = false;
    renderExam();
  });

  document.querySelector("#questionListToggle")?.addEventListener("click", () => {
    if (!state.readingReviewUnlocked) return;
    state.questionListOpen = !state.questionListOpen;
    renderExam();
  });
  document.querySelector("#questionListClose")?.addEventListener("click", () => {
    state.questionListOpen = false;
    renderExam();
  });
  document.querySelector("#bottomMarkCheck")?.addEventListener("change", (event) => {
    if (state.section !== "reading") return;
    state.marked[currentItem().start] = event.target.checked;
    renderExam();
  });
  document.querySelector("#bottomPrevBtn")?.addEventListener("click", () => moveReading(-1));
  document.querySelector("#bottomNextBtn")?.addEventListener("click", () => moveReading(1));
  document.querySelector("#bottomFinishBtn")?.addEventListener("click", () => confirmFinishTest());

  document.querySelector("#prevReadingBtn")?.addEventListener("click", () => moveReading(-1));
  document.querySelector("#nextReadingBtn")?.addEventListener("click", () => moveReading(1));
  document.querySelector("#markBtn")?.addEventListener("click", () => {
    const q = currentItem().start;
    state.marked[q] = !state.marked[q];
    renderExam();
  });

  document.querySelectorAll(".q-nav").forEach((button) => {
    button.addEventListener("click", () => jumpToQuestion(Number(button.dataset.q)));
  });
}

function startTimer() {
  if (state.tickId) return;
  state.tickId = setInterval(() => {
    state.timerRemaining[state.section] -= 1;
    const timer = document.querySelector(".timer");
    if (timer) timer.textContent = formatTime(state.timerRemaining[state.section]);
    if (state.timerRemaining[state.section] <= 0) {
      if (state.section === "listening") {
        enterReading();
      } else {
        submitAttempt("auto");
      }
    }
  }, 1000);
}

function playCurrentAudio() {
  const item = currentItem();
  if (!item) return;
  pauseAudioForAppFlow();
  state.audioError = "";
  state.audio = new Audio(item.audioUrl);
  state.audioStarted = true;
  state.audio.addEventListener("ended", beginListeningTransition, { once: true });
  state.audio.addEventListener("pause", () => {
    setTimeout(resumeLockedListeningAudio, 0);
  });
  state.audio.addEventListener("error", () => {
    state.audioStarted = false;
    state.audioError = "Không phát được audio này. Kiểm tra file MP3 trong resources/ETS2026/Audio.";
    renderExam();
  });
  state.audio.play().catch(() => {
    state.audioStarted = false;
    state.audioError = "Browser vẫn chặn audio có tiếng. Bấm Play audio một lần tại màn thi; từ đó các câu Listening sau vẫn tự chuyển và tự phát.";
    renderExam();
  });
  renderExam();
}

function beginListeningTransition() {
  state.transitionRemaining = state.listeningDelaySeconds;
  if (state.transitionRemaining <= 0) {
    nextListeningItem();
    return;
  }
  renderExam();
  if (state.transitionId) clearInterval(state.transitionId);
  state.transitionId = setInterval(() => {
    state.transitionRemaining -= 1;
    if (state.transitionRemaining <= 0) {
      clearInterval(state.transitionId);
      state.transitionId = null;
      state.transitionRemaining = 0;
      nextListeningItem();
    } else {
      const bar = document.querySelector(".transition-bar");
      if (bar) bar.textContent = `Next item in ${state.transitionRemaining}s`;
    }
  }, 1000);
}

function nextListeningItem() {
  saveQuestionTime();
  if (state.listeningIndex < state.test.listening.length - 1) {
    state.listeningIndex += 1;
    state.audioStarted = false;
    state.questionStartedAt = Date.now();
    renderExam();
    setTimeout(() => playCurrentAudio(), 350);
  } else {
    enterReading();
  }
}

function enterReading() {
  pauseAudioForAppFlow();
  if (state.transitionId) clearInterval(state.transitionId);
  state.section = "reading";
  state.readingReviewUnlocked = false;
  state.questionListOpen = false;
  state.questionStartedAt = Date.now();
  renderExam();
}

function moveReading(delta) {
  saveQuestionTime();
  const maxIndex = state.examScope === "drill" ? state.drillQuestions.length - 1 : state.test.reading.length - 1;
  const next = Math.max(0, Math.min(maxIndex, state.readingIndex + delta));
  if (next === state.readingIndex && delta > 0) {
    if (state.readingReviewUnlocked) return showFinishInfo();
    state.readingReviewUnlocked = true;
    state.questionListOpen = true;
    renderExam();
    return;
  }
  state.readingIndex = next;
  if (state.readingIndex === maxIndex) {
    state.readingReviewUnlocked = true;
    state.questionListOpen = true;
  }
  state.questionStartedAt = Date.now();
  renderExam();
}

function jumpToQuestion(question) {
  saveQuestionTime();
  if (state.section === "listening") {
    const index = state.test.listening.findIndex((item) => question >= item.start && question <= item.end);
    if (index >= state.listeningIndex) {
      state.listeningIndex = index;
      state.audioStarted = false;
      pauseAudioForAppFlow();
      renderExam();
    }
    return;
  }
  if (!state.readingReviewUnlocked) return;
  const index = state.examScope === "drill"
    ? state.drillQuestions.indexOf(question)
    : state.test.reading.findIndex((item) => item.start === question);
  if (index >= 0) {
    state.readingIndex = index;
    state.questionStartedAt = Date.now();
    renderExam();
  }
}

function showFinishInfo() {
  state.dialog = "finish-info";
  renderExam();
}

function confirmFinishTest() {
  state.dialog = "finish-test";
  renderExam();
}

async function submitAttempt(reason) {
  saveQuestionTime();
  pauseAudioForAppFlow();
  const payload = {
    testId: state.test.id,
    testTitle: state.test.title,
    scope: state.examScope,
    drillQuestions: state.examScope === "drill" ? state.drillQuestions : [],
    drillTitle: state.examScope === "drill" ? state.drillTitle : "",
    sourceAttemptId: state.examScope === "drill" ? state.drillSourceAttemptId : null,
    mode: state.mode,
    reason,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    answers: state.answers,
    marked: state.marked,
    elapsedByQuestion: state.elapsedByQuestion,
    answerKey: state.answerKey,
    summary: buildSummary(state.answers, state.answerKey, state.examScope),
  };

  const response = await fetch("/api/attempts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  state.submittedAttempt = (await response.json()).attempt;
  state.attempts.unshift(state.submittedAttempt);
  state.reviewFilter = "all";
  state.screen = "result";
  render();
}

// Approximate TOEIC scaled score conversion (ETS reference points, linear interpolation)
const SCORE_TABLE = {
  listening: [[0,5],[5,20],[10,40],[15,65],[20,90],[25,120],[30,145],[35,170],[40,200],[45,225],[50,250],[55,275],[60,300],[65,330],[70,355],[75,380],[80,405],[85,430],[90,455],[95,475],[100,495]],
  reading:   [[0,5],[5,10],[10,25],[15,50],[20,70],[25,100],[30,120],[35,145],[40,170],[45,195],[50,220],[55,250],[60,280],[65,310],[70,340],[75,365],[80,390],[85,415],[90,440],[95,465],[100,495]],
};

function scaledScore(correct, section) {
  const table = SCORE_TABLE[section];
  const c = Math.max(0, Math.min(100, Math.round(correct)));
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (c >= x0 && c <= x1) {
      const t = (c - x0) / (x1 - x0);
      return Math.round((y0 + t * (y1 - y0)) / 5) * 5;
    }
  }
  return 495;
}

function buildSummary(answers, key, scope = "full") {
  const questions = scope === "drill" ? state.drillQuestions : scopeQuestions(scope);
  const known = questions.filter((q) => key[q]);
  const correct = known.filter((q) => answers[q] === key[q]).length;

  const lKnown = known.filter((q) => q <= 100);
  const rKnown = known.filter((q) => q > 100);
  const lCorrect = lKnown.filter((q) => answers[q] === key[q]).length;
  const rCorrect = rKnown.filter((q) => answers[q] === key[q]).length;

  return {
    answered: questions.filter((q) => answers[q]).length,
    total: questions.length,
    knownKey: known.length,
    correct,
    listeningAnswered: answerCountFrom(answers, 1, 100),
    readingAnswered: answerCountFrom(answers, 101, 200),
    lKnown: lKnown.length,
    rKnown: rKnown.length,
    lCorrect,
    rCorrect,
  };
}

function answerCountFrom(answers, start, end) {
  let count = 0;
  for (let q = start; q <= end; q += 1) if (answers[q]) count += 1;
  return count;
}

function partStats(attempt, key = attempt.answerKey || {}) {
  const answers = attempt.answers || {};
  const marked = attempt.marked || {};
  const elapsed = attempt.elapsedByQuestion || {};
  const scopedQuestions = new Set(attemptQuestions(attempt));
  return partRanges()
    .filter((range) => attemptQuestions(attempt).some((q) => q >= range.start && q <= range.end))
    .map((range) => {
      let answered = 0;
      let markedCount = 0;
      let known = 0;
      let correct = 0;
      let seconds = 0;
      let total = 0;
      for (let q = range.start; q <= range.end; q += 1) {
        if (!scopedQuestions.has(q)) continue;
        total += 1;
        if (answers[q]) answered += 1;
        if (marked[q]) markedCount += 1;
        if (key[q]) {
          known += 1;
          if (answers[q] === key[q]) correct += 1;
        }
        seconds += Number(elapsed[q] || 0);
      }
      return {
        ...range,
        total,
        answered,
        missing: total - answered,
        marked: markedCount,
        known,
        correct,
        accuracy: known ? Math.round((correct / known) * 100) : null,
        avgSeconds: answered ? Math.round(seconds / answered) : 0,
      };
    });
}

function partStatsTable(attempt, key = attempt.answerKey || {}) {
  return `
    <div class="part-table" role="table" aria-label="Part performance">
      <div class="part-row head" role="row">
        <span>Part</span>
        <span>Answered</span>
        <span>Correct</span>
        <span>Marked</span>
        <span>Avg time</span>
      </div>
      ${partStats(attempt, key).map((part) => `
        <div class="part-row" role="row">
          <span><strong>${part.label}</strong><small>${PART_NAMES[part.part]}</small></span>
          <span>${part.answered}/${part.total}</span>
          <span>${part.known ? `${part.correct}/${part.known} (${part.accuracy}%)` : "-"}</span>
          <span>${part.marked}</span>
          <span>${part.avgSeconds ? `${part.avgSeconds}s` : "-"}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function scoreBlock(summary, scope) {
  if (!summary.knownKey) {
    return `<p class="muted" style="margin:0">Nhập answer key ở màn Review để xem điểm ước tính.</p>`;
  }
  if (scope === "drill") {
    const pct = Math.round((summary.correct / summary.knownKey) * 100);
    return `<div class="score-band"><strong>${summary.correct}/${summary.knownKey}</strong><span>${pct}% correct</span></div>`;
  }
  const hasL = summary.lKnown > 0;
  const hasR = summary.rKnown > 0;
  // Extrapolate to 100-question base if partial key
  const lRaw = hasL ? (summary.lCorrect / summary.lKnown) * 100 : null;
  const rRaw = hasR ? (summary.rCorrect / summary.rKnown) * 100 : null;
  const lScore = lRaw !== null ? scaledScore(lRaw, "listening") : null;
  const rScore = rRaw !== null ? scaledScore(rRaw, "reading") : null;
  const totalScore = (lScore ?? 0) + (rScore ?? 0);
  const partial = summary.lKnown < 100 || summary.rKnown < 100;

  if (scope === "reading") {
    return `
      <div class="score-band">
        <strong>${rScore ?? "—"}<span>/495</span></strong>
        <span>Reading · ${summary.rCorrect}/${summary.rKnown} correct${partial ? " (est.)" : ""}</span>
      </div>`;
  }
  return `
    <div class="score-bands">
      <div class="score-band total">
        <strong>${totalScore}<span>/990</span></strong>
        <span>Total${partial ? " (est.)" : ""}</span>
      </div>
      <div class="score-band">
        <strong>${lScore ?? "—"}<span>/495</span></strong>
        <span>Listening · ${summary.lCorrect}/${summary.lKnown} đúng</span>
      </div>
      <div class="score-band">
        <strong>${rScore ?? "—"}<span>/495</span></strong>
        <span>Reading · ${summary.rCorrect}/${summary.rKnown} đúng</span>
      </div>
    </div>`;
}

function resultScoreDetails(summary, scope) {
  if (!summary.knownKey) {
    return `
      <div class="score-bands result-score-bands">
        <div class="score-band total">
          <strong>—<span>/990</span></strong>
          <span>Total · no answer key</span>
        </div>
        <div class="score-band">
          <strong>—<span>/495</span></strong>
          <span>Listening score</span>
        </div>
        <div class="score-band">
          <strong>—<span>/495</span></strong>
          <span>Reading score</span>
        </div>
      </div>
    `;
  }

  if (scope === "drill") {
    const pct = Math.round((summary.correct / summary.knownKey) * 100);
    return `
      <div class="score-bands result-score-bands">
        <div class="score-band total">
          <strong>${pct}<span>%</span></strong>
          <span>Drill score · ${summary.correct}/${summary.knownKey} correct</span>
        </div>
      </div>
    `;
  }

  const hasL = summary.lKnown > 0;
  const hasR = summary.rKnown > 0;
  const lRaw = hasL ? (summary.lCorrect / summary.lKnown) * 100 : null;
  const rRaw = hasR ? (summary.rCorrect / summary.rKnown) * 100 : null;
  const lScore = lRaw !== null ? scaledScore(lRaw, "listening") : null;
  const rScore = rRaw !== null ? scaledScore(rRaw, "reading") : null;
  const totalScore = (lScore ?? 0) + (rScore ?? 0);
  const partial = summary.lKnown < 100 || summary.rKnown < 100;

  return `
    <div class="score-bands result-score-bands">
      <div class="score-band total">
        <strong>${totalScore}<span>/990</span></strong>
        <span>Total${partial ? " · estimated" : ""}</span>
      </div>
      <div class="score-band">
        <strong>${lScore ?? "—"}<span>/495</span></strong>
        <span>Listening · ${summary.lCorrect}/${summary.lKnown} correct</span>
      </div>
      <div class="score-band">
        <strong>${rScore ?? "—"}<span>/495</span></strong>
        <span>Reading · ${summary.rCorrect}/${summary.rKnown} correct</span>
      </div>
    </div>
  `;
}

function renderResult() {
  const attempt = state.submittedAttempt;
  const key = { ...(attempt.answerKey || {}), ...cachedAnswerKey(attempt.testId) };
  const summary = buildSummary(attempt.answers || {}, key, attempt.scope || "full");
  const scope = attempt.scope || "full";
  app.innerHTML = `
    <main class="result-shell">
      <section class="score-panel">
        <div>
          <h1>Test finished</h1>
          <p>${encodeHtml(attempt.testTitle)} · ${new Date(attempt.submittedAt).toLocaleString("vi-VN")}</p>
          <div class="answered-summary">${summary.answered}/${summary.total} answered · Listening ${summary.listeningAnswered}/100 · Reading ${summary.readingAnswered}/100</div>
        </div>
        ${resultScoreDetails(summary, scope)}
      </section>
      <section class="insight-panel">
        <h2>Part performance</h2>
        ${partStatsTable(attempt, key)}
      </section>
      <section class="insight-panel">
        <h2>Practice notes</h2>
        ${insights(attempt)}
      </section>
      <div class="result-actions">
        <button class="primary-btn" id="reviewBtn">Review attempt</button>
        <button class="ghost-btn" id="homeBtn">Back home</button>
      </div>
    </main>
  `;
  document.querySelector("#reviewBtn").addEventListener("click", async () => {
    await fetchAnswerKey(attempt.testId);
    state.reviewFilter = "all";
    state.reviewSourceQuestion = null;
    state.screen = "review";
    render();
  });
  document.querySelector("#homeBtn").addEventListener("click", () => {
    state.screen = "home";
    render();
  });
}

function insights(attempt) {
  const answers = attempt.answers || {};
  const marked = attempt.marked || {};
  const scoped = new Set(attemptQuestions(attempt));
  const gaps = [];
  for (const { label, start, end } of partRanges().filter((range) => attemptQuestions(attempt).some((q) => q >= range.start && q <= range.end))) {
    const missing = [];
    for (let q = start; q <= end; q += 1) if (scoped.has(q) && !answers[q]) missing.push(q);
    if (missing.length) gaps.push(`<li><strong>${label}</strong>: ${missing.length} unanswered (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "..." : ""})</li>`);
  }
  const markedCount = Object.values(marked).filter(Boolean).length;
  return `
    <ul class="insights">
      ${gaps.length ? gaps.join("") : "<li>Không còn câu trống. Đây là thói quen rất quan trọng khi thi máy.</li>"}
      <li>${markedCount} câu được mark review. Khi luyện Reading, hãy quay lại nhóm này trước khi hết giờ 10 phút.</li>
      <li>Nhập answer key ở màn review để app tự tính đúng/sai và lọc câu yếu theo part.</li>
    </ul>
  `;
}

function renderReview(attempt) {
  const answers = attempt.answers || {};
  const key = { ...(attempt.answerKey || {}), ...cachedAnswerKey(attempt.testId) };
  const test = state.tests.find((item) => item.id === attempt.testId) || state.tests[0];
  const questions = reviewQuestions(attempt, key);
  app.innerHTML = `
    <main class="review-shell">
      <header class="review-header">
        <div>
          <h1>Review attempt</h1>
          <p>${encodeHtml(attempt.testTitle || test.title)} · ${new Date(attempt.submittedAt).toLocaleString("vi-VN")}</p>
        </div>
        <div class="review-actions">
          <button class="ghost-btn" id="keyBtn">Answer key</button>
          <button class="ghost-btn" id="homeBtn">Home</button>
        </div>
      </header>
      <section class="review-analytics">
        <div class="review-score-row">${scoreBlock(buildSummary(answers, key, attempt.scope || "full"), attempt.scope || "full")}</div>
        ${partStatsTable(attempt, key)}
      </section>
      <div class="review-work">
        <section class="review-source" id="reviewSource">
          ${reviewSourceContent(test)}
        </section>
        <div class="review-side">
          <section class="review-filters" aria-label="Review filters">
            ${reviewFilters(attempt, key)}
          </section>
          <section class="review-grid ${questions.length ? "" : "empty"}">
            ${questions.length ? questions.map((q) => {
              const selected = answers[q] || "-";
              const correct = key[q];
              const status = correct ? (selected === correct ? "correct" : "wrong") : "unknown";
              return `
                <button class="review-cell ${status} ${state.reviewSourceQuestion === q ? "active" : ""}" data-review-q="${q}">
                  <span>${q}</span>
                  <strong>${selected}</strong>
                  <small>${correct || ""}</small>
                </button>
              `;
            }).join("") : `<div class="empty-review">Không có câu nào trong filter này.</div>`}
          </section>
        </div>
      </div>
    </main>
  `;

  document.querySelector("#homeBtn").addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  document.querySelector("#keyBtn").addEventListener("click", () => openKeyEditor(test, key));
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.reviewFilter = button.dataset.filter;
      state.reviewSourceQuestion = null;
      renderReview(attempt);
    });
  });
  document.querySelectorAll("[data-review-q]").forEach((button) => {
    button.addEventListener("click", () => {
      state.reviewSourceQuestion = Number(button.dataset.reviewQ);
      markReviewActiveQuestion();
      renderReviewSource(test, true);
    });
  });
  bindReviewSourceControls(test);
}

function markReviewActiveQuestion() {
  document.querySelectorAll("[data-review-q]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.reviewQ) === state.reviewSourceQuestion);
  });
}

function reviewSourceContent(test) {
  const question = state.reviewSourceQuestion;
  if (!question) {
    return `
      <div class="source-title">
        <span>Choose a question to open the estimated ETS PDF page.</span>
      </div>
    `;
  }
  const section = question <= 100 ? "listening" : "reading";
  const page = previewPage(section, pageFor(test.testNumber, section, question));
  return `
    <div class="source-title">
      <span>Question ${question} · ${section} source page ${page}</span>
      <div class="source-actions">
        ${pageControls(section, page)}
        ${section === "listening" ? `<a href="${test.transcriptPdf}#page=${page}" target="_blank">Transcript PDF</a>` : ""}
      </div>
    </div>
    ${section === "listening" ? reviewAudioPlayer(test, question) : ""}
    <img class="pdf-page" src="${pdfPageImage(section, page)}" alt="${section} source page ${page}">
  `;
}

function reviewAudioPlayer(test, question) {
  const item = listeningItemForQuestion(test, question);
  if (!item?.audioUrl) {
    return `<div class="review-audio-player unavailable">Audio file not found for this question.</div>`;
  }
  return `
    <div class="review-audio-player">
      <audio id="reviewAudio" src="${item.audioUrl}" preload="metadata"></audio>
      <button class="review-audio-play" id="reviewAudioPlay" type="button">Play</button>
      <div class="review-audio-main">
        <div class="review-audio-meta">
          <strong>Listening audio ${qRange(item)}</strong>
          <span id="reviewAudioTime">00:00 / 00:00</span>
        </div>
        <input id="reviewAudioSeek" class="review-audio-seek" type="range" min="0" max="100" step="0.1" value="0" aria-label="Audio progress">
      </div>
    </div>
  `;
}

function renderReviewSource(test, shouldScroll = false) {
  const source = document.querySelector("#reviewSource");
  if (!source) return;
  if (state.reviewAudio) {
    state.reviewAudio.pause();
    state.reviewAudio = null;
  }
  source.innerHTML = reviewSourceContent(test);
  bindReviewSourceControls(test);
  if (shouldScroll) source.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindReviewSourceControls(test) {
  document.querySelectorAll("#reviewSource [data-page-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.dataset.pageSection;
      const delta = Number(button.dataset.pageDelta || 0);
      state.pageOffsets[section] = (state.pageOffsets[section] || 0) + delta;
      renderReviewSource(test);
    });
  });
  bindReviewAudio();
}

function bindReviewAudio() {
  const audio = document.querySelector("#reviewAudio");
  const playButton = document.querySelector("#reviewAudioPlay");
  const seek = document.querySelector("#reviewAudioSeek");
  const time = document.querySelector("#reviewAudioTime");
  if (!audio || !playButton || !seek || !time) return;
  state.reviewAudio = audio;

  const update = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    seek.value = duration ? String((current / duration) * 100) : "0";
    time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  };

  playButton.addEventListener("click", () => {
    if (audio.paused) {
      audio.play().catch(() => {
        playButton.textContent = "Play";
      });
    } else {
      audio.pause();
    }
  });
  seek.addEventListener("input", () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (duration) audio.currentTime = (Number(seek.value) / 100) * duration;
    update();
  });
  audio.addEventListener("loadedmetadata", update);
  audio.addEventListener("timeupdate", update);
  audio.addEventListener("play", () => {
    playButton.textContent = "Pause";
  });
  audio.addEventListener("pause", () => {
    playButton.textContent = "Play";
    update();
  });
  audio.addEventListener("ended", () => {
    playButton.textContent = "Play";
    update();
  });
  update();
}

function startDrillFromReview(attempt, questions) {
  if (!questions.length) return;
  const test = state.tests.find((item) => item.id === attempt.testId) || state.tests[0];
  state.test = test;
  state.examScope = "drill";
  state.drillQuestions = [...questions].sort((a, b) => a - b);
  state.drillSourceAttemptId = attempt.id;
  state.drillTitle = drillTitleForFilter();
  state.answerKey = cachedAnswerKey(test.id);
  startExam("drill");
}

function drillTitleForFilter() {
  if (state.reviewFilter === "all") return "Review drill";
  if (state.reviewFilter === "wrong") return "Wrong-answer drill";
  if (state.reviewFilter === "unanswered") return "Unanswered drill";
  if (state.reviewFilter === "marked") return "Marked drill";
  if (state.reviewFilter.startsWith("part-")) return `${state.reviewFilter.replace("part-", "Part ")} drill`;
  return "Drill";
}

function reviewQuestions(attempt, key) {
  const answers = attempt.answers || {};
  const marked = attempt.marked || {};
  const all = attemptQuestions(attempt);

  if (state.reviewFilter === "wrong") {
    return all.filter((q) => key[q] && answers[q] !== key[q]);
  }
  if (state.reviewFilter === "unanswered") {
    return all.filter((q) => !answers[q]);
  }
  if (state.reviewFilter === "marked") {
    return all.filter((q) => marked[q]);
  }
  if (state.reviewFilter.startsWith("part-")) {
    const part = Number(state.reviewFilter.replace("part-", ""));
    return all.filter((q) => partOfQuestion(q) === part);
  }
  return all;
}

function reviewFilters(attempt, key) {
  const answers = attempt.answers || {};
  const marked = attempt.marked || {};
  const all = attemptQuestions(attempt);
  const counts = {
    all: all.length,
    wrong: all.filter((q) => key[q] && answers[q] !== key[q]).length,
    unanswered: all.filter((q) => !answers[q]).length,
    marked: all.filter((q) => marked[q]).length,
  };
  const filterButton = (filter, label, count) => `
    <button class="filter-btn ${state.reviewFilter === filter ? "active" : ""}" data-filter="${filter}">
      ${label}<span>${count}</span>
    </button>
  `;
  return `
    ${filterButton("all", "All", counts.all)}
    ${filterButton("wrong", "Wrong", counts.wrong)}
    ${filterButton("unanswered", "Unanswered", counts.unanswered)}
    ${filterButton("marked", "Marked", counts.marked)}
    ${partRanges()
      .filter((part) => all.some((q) => q >= part.start && q <= part.end))
      .map((part) => filterButton(`part-${part.part}`, part.label, all.filter((q) => partOfQuestion(q) === part.part).length))
      .join("")}
  `;
}

function openKeyEditor(test, existingKey) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const savedCount = Object.keys(existingKey).length;
  backdrop.innerHTML = `
    <div class="modal key-editor-modal">
      <h2>Answer Key</h2>
      <p class="muted" style="font-size:13px;margin-bottom:12px">
        Formats: <code>ABCD...</code> (100 or 200 letters), <code>1:A 2:B</code>, or JSON.<br>
        ${savedCount} answers saved. Submitting will replace all.
      </p>
      <textarea id="keyEditorInput" rows="10" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;border:1px solid var(--line);border-radius:6px;padding:8px;resize:vertical" placeholder="Paste answer key here…">${savedCount ? Object.entries(existingKey).sort((a, b) => Number(a[0]) - Number(b[0])).map(([q, a]) => `${q}:${a}`).join(" ") : ""}</textarea>
      <p id="keyEditorError" style="color:#c00;font-size:13px;margin-top:6px;display:none"></p>
      <div class="modal-actions">
        <button class="ghost-btn" id="keyEditorCancel">Huỷ</button>
        <button class="primary-btn" id="keyEditorSave">Lưu</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#keyEditorCancel").addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector("#keyEditorSave").addEventListener("click", async () => {
    const raw = backdrop.querySelector("#keyEditorInput").value;
    const err = backdrop.querySelector("#keyEditorError");
    try {
      const normalized = parseAnswerKey(raw);
      await saveAnswerKey(test.id, normalized);
      backdrop.remove();
      renderReview(state.submittedAttempt);
    } catch (error) {
      err.textContent = error.message || "Answer key không hợp lệ.";
      err.style.display = "";
    }
  });
}

function parseAnswerKey(raw) {
  const text = raw.trim();
  if (!text) throw new Error("Answer key rỗng.");

  if (text.startsWith("{")) {
    return normalizeAnswerKeyObject(JSON.parse(text));
  }

  const pairs = [...text.matchAll(/\b(\d{1,3})\s*[:=\-.]?\s*([ABCD])\b/gi)];
  if (pairs.length) {
    const parsed = {};
    for (const match of pairs) parsed[Number(match[1])] = match[2].toUpperCase();
    return normalizeAnswerKeyObject(parsed);
  }

  const letters = text.toUpperCase().replace(/[^ABCD]/g, "");
  if (letters.length === 200 || letters.length === 100) {
    const offset = letters.length === 200 ? 1 : 101;
    const parsed = {};
    for (let index = 0; index < letters.length; index += 1) {
      parsed[offset + index] = letters[index];
    }
    return parsed;
  }

  throw new Error("Không nhận diện được format answer key.");
}

function normalizeAnswerKeyObject(input) {
  const normalized = {};
  for (const [question, answer] of Object.entries(input || {})) {
    const number = Number(question);
    const letter = String(answer).trim().toUpperCase();
    if (Number.isInteger(number) && number >= 1 && number <= 200 && ["A", "B", "C", "D"].includes(letter)) {
      normalized[number] = letter;
    }
  }
  if (!Object.keys(normalized).length) throw new Error("Không có đáp án hợp lệ trong answer key.");
  return normalized;
}

bootstrap().catch((error) => {
  app.innerHTML = `<main class="error"><h1>Cannot start app</h1><pre>${encodeHtml(error.stack || error.message)}</pre></main>`;
});
