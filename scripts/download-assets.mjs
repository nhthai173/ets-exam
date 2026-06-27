import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, process.argv[2] || "asset-manifest.json");

const PLACEHOLDER_RE = /PASTE_|YOUR_|drive\/folders\/|example/i;

function driveIdFrom(value = "") {
  if (!value) return "";
  const patterns = [
    /\/file\/d\/([^/]+)/,
    /[?&]id=([^&]+)/,
    /^([a-zA-Z0-9_-]{20,})$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return decodeURIComponent(match[1]);
  }
  return "";
}

function downloadUrl(asset) {
  if (asset.url && !asset.googleDriveId && !/drive\.google\.com|drive\.usercontent\.google\.com/.test(asset.url)) {
    return asset.url;
  }
  const id = asset.googleDriveId || driveIdFrom(asset.url);
  if (!id) return "";
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}

function assetLabel(asset) {
  return asset.path || asset.filename || asset.extractTo || "asset";
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { headers: { "user-agent": "toeic-assets-downloader/1.0" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) reject(new Error(`Too many redirects for ${url}`));
        else resolve(request(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

async function download(asset, target) {
  const url = downloadUrl(asset);
  if (!url || PLACEHOLDER_RE.test(url)) {
    throw new Error(`Missing Google Drive URL or file ID for ${assetLabel(asset)}`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.download`;
  const res = await request(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`Download failed for ${assetLabel(asset)}: HTTP ${res.statusCode}`);
  }
  const contentType = String(res.headers["content-type"] || "");

  await new Promise((resolve, reject) => {
    const file = createWriteStream(tmp);
    res.pipe(file);
    file.on("finish", () => file.close(resolve));
    file.on("error", reject);
    res.on("error", reject);
  });

  const downloaded = await stat(tmp);
  if ((downloaded.size < 8192 || contentType.includes("text/html")) && /google/i.test(url)) {
    const preview = await readFile(tmp, "utf8").catch(() => "");
    if (/<html|quota|virus|download/i.test(preview)) {
      await rm(tmp, { force: true });
      throw new Error(`Google Drive returned an HTML confirmation page for ${assetLabel(asset)}. Make sure the file is shared publicly.`);
    }
  }

  if (asset.sha256) {
    const actual = createHash("sha256").update(await readFile(tmp)).digest("hex");
    if (actual !== asset.sha256) {
      await rm(tmp, { force: true });
      throw new Error(`Checksum mismatch for ${assetLabel(asset)}`);
    }
  }

  await rename(tmp, target);
}

async function unzip(zipPath, extractTo) {
  await mkdir(extractTo, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-o", zipPath, "-d", extractTo], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip exited with ${code}`));
    });
  });
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const assets = manifest.assets || [];
  if (!assets.length) throw new Error("No assets found in asset-manifest.json");

  for (const asset of assets) {
    if (asset.type === "zip") {
      const zipName = asset.filename || `${path.basename(asset.extractTo || "assets")}.zip`;
      const zipPath = path.join(rootDir, ".asset-cache", zipName);
      const extractTo = path.join(rootDir, asset.extractTo || ".");
      console.log(`Downloading ${zipName}...`);
      await download(asset, zipPath);
      console.log(`Extracting to ${path.relative(rootDir, extractTo)}...`);
      await unzip(zipPath, extractTo);
      continue;
    }

    const target = path.join(rootDir, asset.path);
    if (!asset.force && await exists(target)) {
      console.log(`Skip existing ${asset.path}`);
      continue;
    }
    console.log(`Downloading ${asset.path}...`);
    await download(asset, target);
  }

  console.log("Assets ready.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
