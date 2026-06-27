import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const appDir = path.join(rootDir, "app");
const resourcesDir = path.join(rootDir, "resources");
const audioDir = path.join(resourcesDir, "ETS2026", "Audio");
const dataDir = path.join(rootDir, "data");
const attemptsFile = path.join(dataDir, "attempts.json");
const answerKeysFile = path.join(dataDir, "answer-keys.json");
const pdfPageDir = path.join(dataDir, "pdf-pages");
const pdftoppmPath = "/Users/thainguyen/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm";
const port = Number(process.env.PORT || 4173);

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".mp3", "audio/mpeg"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
]);

function json(res, code, payload) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function partFor(questionNumber) {
  if (questionNumber <= 6) return 1;
  if (questionNumber <= 31) return 2;
  if (questionNumber <= 70) return 3;
  if (questionNumber <= 100) return 4;
  if (questionNumber <= 130) return 5;
  if (questionNumber <= 146) return 6;
  return 7;
}

async function scanTests() {
  const files = await fs.readdir(audioDir);
  const tests = new Map();

  for (const file of files) {
    const match = /^E26-T(\d{2})-(\d{2})(?:-(\d{2,3}))?\.mp3$/i.exec(file);
    if (!match) continue;

    const testNumber = Number(match[1]);
    const start = Number(match[2]);
    const end = Number(match[3] || match[2]);
    const id = `ets2026-t${String(testNumber).padStart(2, "0")}`;
    if (!tests.has(id)) {
      tests.set(id, {
        id,
        title: `ETS 2026 Test ${String(testNumber).padStart(2, "0")}`,
        testNumber,
        listeningPdf: "/resources/ETS2026/LISTENING%20ETS%202026%20.pdf",
        readingPdf: "/resources/ETS2026/READING%20ETS%202026%20.pdf",
        transcriptPdf: "/resources/ETS2026/Transcript.pdf",
        listening: [],
        reading: Array.from({ length: 100 }, (_, index) => {
          const questionNumber = index + 101;
          return {
            start: questionNumber,
            end: questionNumber,
            part: partFor(questionNumber),
          };
        }),
      });
    }

    tests.get(id).listening.push({
      start,
      end,
      part: partFor(start),
      file,
      audioUrl: `/resources/ETS2026/Audio/${encodeURIComponent(file)}`,
    });
  }

  return [...tests.values()]
    .map((test) => ({
      ...test,
      listening: test.listening.sort((a, b) => a.start - b.start),
    }))
    .sort((a, b) => a.testNumber - b.testNumber);
}

async function readAttempts() {
  try {
    return JSON.parse(await fs.readFile(attemptsFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAttempt(attempt) {
  await fs.mkdir(dataDir, { recursive: true });
  const attempts = await readAttempts();
  attempts.unshift(attempt);
  await fs.writeFile(attemptsFile, JSON.stringify(attempts.slice(0, 200), null, 2));
}

async function readAnswerKeys() {
  try {
    return JSON.parse(await fs.readFile(answerKeysFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeAnswerKey(testId, key) {
  await fs.mkdir(dataDir, { recursive: true });
  const keys = await readAnswerKeys();
  keys[testId] = {
    updatedAt: new Date().toISOString(),
    key,
  };
  await fs.writeFile(answerKeysFile, JSON.stringify(keys, null, 2));
  return keys[testId];
}

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const target = path.normalize(path.join(base, decoded));
  if (!target.startsWith(base)) return null;
  return target;
}

function pdfPathFor(kind) {
  if (kind === "listening") return path.join(resourcesDir, "ETS2026", "LISTENING ETS 2026 .pdf");
  if (kind === "reading") return path.join(resourcesDir, "ETS2026", "READING ETS 2026 .pdf");
  if (kind === "transcript") return path.join(resourcesDir, "ETS2026", "Transcript.pdf");
  return null;
}

async function ensurePdfPage(kind, page) {
  const source = pdfPathFor(kind);
  if (!source || !existsSync(source)) return null;
  const safePage = Math.max(1, Math.min(400, Number(page) || 1));
  const outDir = path.join(pdfPageDir, kind);
  const outPrefix = path.join(outDir, `page-${String(safePage).padStart(3, "0")}`);
  const outFile = `${outPrefix}.png`;
  if (existsSync(outFile)) return outFile;

  await fs.mkdir(outDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(pdftoppmPath, [
      "-png",
      "-singlefile",
      "-r",
      "120",
      "-f",
      String(safePage),
      "-l",
      String(safePage),
      source,
      outPrefix,
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && existsSync(outFile)) resolve();
      else reject(new Error(stderr || `pdftoppm exited with ${code}`));
    });
  });
  return outFile;
}

async function serveFile(req, res, filePath) {
  if (!filePath || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mime.get(ext) || "application/octet-stream";
  const range = req.headers.range;
  if (range && (ext === ".mp3" || ext === ".pdf")) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start <= end && end < stat.size) {
        res.writeHead(206, {
          "content-type": contentType,
          "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=3600",
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    "content-type": contentType,
    "content-length": stat.size,
    "accept-ranges": "bytes",
    "cache-control": ext === ".mp3" || ext === ".pdf" ? "public, max-age=3600" : "no-store",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/config") {
      return json(res, 200, { dev: process.env.NODE_ENV === "development" });
    }

    if (url.pathname === "/api/tests") {
      return json(res, 200, { tests: await scanTests() });
    }

    if (url.pathname === "/api/attempts" && req.method === "GET") {
      return json(res, 200, { attempts: await readAttempts() });
    }

    if (url.pathname === "/api/attempts" && req.method === "POST") {
      const payload = await bodyJson(req);
      const attempt = {
        id: `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        submittedAt: new Date().toISOString(),
        ...payload,
      };
      await writeAttempt(attempt);
      return json(res, 201, { attempt });
    }

    const answerKeyMatch = /^\/api\/answer-keys\/([^/]+)$/.exec(url.pathname);
    if (answerKeyMatch && req.method === "GET") {
      const testId = decodeURIComponent(answerKeyMatch[1]);
      const keys = await readAnswerKeys();
      return json(res, 200, { testId, ...(keys[testId] || { key: {}, updatedAt: null }) });
    }

    if (answerKeyMatch && req.method === "PUT") {
      const testId = decodeURIComponent(answerKeyMatch[1]);
      const payload = await bodyJson(req);
      const saved = await writeAnswerKey(testId, normalizeAnswerKey(payload.key || {}));
      return json(res, 200, { testId, ...saved });
    }

    if (url.pathname === "/api/pdf-page") {
      const kind = url.searchParams.get("kind");
      const page = url.searchParams.get("page");
      const file = await ensurePdfPage(kind, page);
      return serveFile(req, res, file);
    }

    if (url.pathname.startsWith("/resources/")) {
      return serveFile(req, res, safeJoin(rootDir, url.pathname.slice(1)));
    }

    const filePath = url.pathname === "/"
      ? path.join(appDir, "index.html")
      : safeJoin(appDir, url.pathname.slice(1));
    return serveFile(req, res, filePath);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: "Internal server error", detail: error.message });
  }
});

function normalizeAnswerKey(input) {
  const normalized = {};
  for (const [question, answer] of Object.entries(input || {})) {
    const number = Number(question);
    const letter = String(answer).trim().toUpperCase();
    if (Number.isInteger(number) && number >= 1 && number <= 200 && ["A", "B", "C", "D"].includes(letter)) {
      normalized[number] = letter;
    }
  }
  return normalized;
}

server.listen(port, () => {
  console.log(`TOEIC local trainer running at http://localhost:${port}`);
});
