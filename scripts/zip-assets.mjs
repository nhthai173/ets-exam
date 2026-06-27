import { mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outFile = process.argv[2] || ".asset-cache/toeic-assets.zip";
const outputPath = path.resolve(rootDir, outFile);

const assetPaths = [
  "resources/ETS2026/READING ETS 2026 .pdf",
  "resources/ETS2026/LISTENING ETS 2026 .pdf",
  "resources/ETS2026/Transcript.pdf",
  "resources/ETS2026/Vocab/Vocab/ETS TOEIC 정기시험 기출문제집 1000 5 LC_단어장.pdf",
  "resources/ETS2026/Vocab/Vocab/ETS 토익 정기시험 기출문제집 1000 5 RC_단어장.pdf",
];

async function main() {
  const missing = [];
  for (const assetPath of assetPaths) {
    try {
      await stat(path.join(rootDir, assetPath));
    } catch {
      missing.push(assetPath);
    }
  }
  if (missing.length) {
    throw new Error(`Missing asset files:\n${missing.map((item) => `- ${item}`).join("\n")}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const child = spawn("zip", ["-r", outputPath, ...assetPaths], {
      cwd: rootDir,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zip exited with ${code}`));
    });
  });

  console.log(`Created ${path.relative(rootDir, outputPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
