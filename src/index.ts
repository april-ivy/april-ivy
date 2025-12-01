import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";

interface TrackInfo {
  title: string;
  artist: string;
  album?: string;
  albumArt?: string;
  nowPlaying: boolean;
  playedAt: number;
}

interface CacheEntry {
  title: string;
  artist: string;
  album?: string;
  albumArt?: string;
  nowPlaying: boolean;
  lastUpdatedIso: string;
}

interface EnvConfig {
  lastfmApiKey: string;
  lastfmUsername: string;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  readmePath: string;
  placeholder: string;
  cacheFile: string;
  updateIntervalMs: number;
  cacheTtlMs: number;
  userAgent: string;
}

const config = getConfig();

async function main() {
  console.log(`[music] updater started – interval ${config.updateIntervalMs / 1000}s`);
  while (true) {
    const startedAt = Date.now();
    try {
      await tick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[music] tick failed: ${message}`);
    }

    const elapsed = Date.now() - startedAt;
    const sleepMs = Math.max(0, config.updateIntervalMs - elapsed);
    await sleep(sleepMs);
  }
}

async function tick() {
  const track = await fetchRecentTrack();
  if (!track) {
    console.warn("[music] No recent tracks found");
    return;
  }

  const cache = await loadCache();
  if (!shouldUpdate(track, cache)) {
    console.log(`[music] No change (${track.title} - ${track.artist})`);
    return;
  }

  const updated = await updateReadme(track);
  if (updated) {
    await saveCache(track);
    console.log(`[music] README updated -> ${track.title} - ${track.artist}`);
  }
}

async function fetchRecentTrack(): Promise<TrackInfo | null> {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method: "user.getrecenttracks",
    api_key: config.lastfmApiKey,
    user: config.lastfmUsername,
    format: "json",
    limit: "1",
  }).toString();

  const response = await fetch(url, {
    headers: { "User-Agent": config.userAgent },
  });

  if (!response.ok) {
    throw new Error(`Last.fm request failed (${response.status})`);
  }

  const payload = (await response.json()) as LastFmResponse;
  const recent = payload.recenttracks?.track?.[0];
  if (!recent) {
    return null;
  }

  const images = recent.image || [];
  const albumArt = images.find(img => img.size === "extralarge")?.["#text"] 
    || images.find(img => img.size === "large")?.["#text"]
    || images.find(img => img.size === "medium")?.["#text"];

  const nowPlaying = recent["@attr"]?.nowplaying === "true";
  const uts = recent.date?.uts ? Number(recent.date.uts) * 1000 : Date.now();

  return {
    title: recent.name ?? "Unknown track",
    artist: recent.artist?.["#text"] ?? "Unknown artist",
    album: recent.album?.["#text"],
    albumArt,
    nowPlaying,
    playedAt: uts,
  };
}

async function updateReadme(track: TrackInfo): Promise<boolean> {
  const endpoint = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${config.readmePath}`;
  const headers = {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": config.userAgent,
  };

  const response = await fetch(endpoint + `?ref=${config.githubBranch}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub README fetch failed (${response.status})`);
  }

  const data = (await response.json()) as GithubContentResponse;
  if (data.type !== "file" || !data.content) {
    throw new Error("README content missing in GitHub response");
  }

  const decoded = Buffer.from(data.content, data.encoding ?? "base64").toString("utf-8");
  const formatted = formatTrack(track);
  const spanPattern = /(<span[^>]*data-music[^>]*>)[\s\S]*?(<\/span>)/i;

  let nextReadme: string | null = null;

  if (spanPattern.test(decoded)) {
    nextReadme = decoded.replace(spanPattern, `$1${formatted}$2`);
  } else if (decoded.includes(config.placeholder)) {
    const replacement = `<span data-music>${formatted}</span>`;
    nextReadme = decoded.replace(config.placeholder, replacement);
  } else {
    console.warn(
      `[music] Placeholder ${config.placeholder} or data-music span not found – skipping update`
    );
    return false;
  }

  if (nextReadme === decoded) {
    console.log("[music] README already up-to-date");
    return false;
  }

  const putResponse = await fetch(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `docs(readme): music -> ${track.title} by ${track.artist}`,
      content: Buffer.from(nextReadme, "utf-8").toString("base64"),
      sha: data.sha,
      branch: config.githubBranch,
    }),
  });

  if (!putResponse.ok) {
    throw new Error(`GitHub README update failed (${putResponse.status})`);
  }

  return true;
}

function formatTrack(track: TrackInfo): string {
  const timeAgo = getTimeAgo(track.playedAt);
  
  if (track.albumArt) {
    let lines = [
      `<strong>${track.title}</strong>`,
      `by ${track.artist}`
    ];
    
    if (track.album) {
      lines.push(`from ${track.album}`);
    }
    
    lines.push('');
    
    if (track.nowPlaying) {
      lines.push('<em>now playing</em>');
    } else {
      lines.push(timeAgo);
    }
    
    const info = lines.join('<br/>');
    
    return `<img src="${track.albumArt}" alt="" width="128" height="128" align="left" /><samp>${info}</samp>`;
  }
  
  return `<samp><strong>${track.title}</strong><br/>by ${track.artist}</samp>`;
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

async function loadCache(): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(config.cacheFile, "utf-8");
    return JSON.parse(raw) as CacheEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[music] Unable to read cache", error);
    }
    return null;
  }
}

async function saveCache(track: TrackInfo) {
  await mkdir(path.dirname(config.cacheFile), { recursive: true });
  const entry: CacheEntry = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArt: track.albumArt,
    nowPlaying: track.nowPlaying,
    lastUpdatedIso: new Date().toISOString(),
  };
  await writeFile(config.cacheFile, JSON.stringify(entry, null, 2), "utf-8");
}

function shouldUpdate(track: TrackInfo, cache: CacheEntry | null): boolean {
  if (!cache) {
    return true;
  }

  if (
    cache.title !== track.title ||
    cache.artist !== track.artist ||
    cache.album !== track.album ||
    cache.albumArt !== track.albumArt ||
    cache.nowPlaying !== track.nowPlaying
  ) {
    return true;
  }

  const last = new Date(cache.lastUpdatedIso).getTime();
  if (Number.isNaN(last)) {
    return true;
  }

  return Date.now() - last > config.cacheTtlMs;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfig(): EnvConfig {
  const env = process.env;

  return {
    lastfmApiKey: requireEnv("LASTFM_API_KEY", env.LASTFM_API_KEY),
    lastfmUsername: requireEnv("LASTFM_USERNAME", env.LASTFM_USERNAME),
    githubToken: requireEnv("GITHUB_TOKEN", env.GITHUB_TOKEN),
    githubOwner: requireEnv("GITHUB_OWNER", env.GITHUB_OWNER),
    githubRepo: requireEnv("GITHUB_REPO", env.GITHUB_REPO),
    githubBranch: env.GITHUB_BRANCH || "main",
    readmePath: env.README_PATH || "README.md",
    placeholder: env.MUSIC_PLACEHOLDER || "%music%",
    cacheFile: path.resolve(env.MUSIC_CACHE_FILE || ".cache/music.json"),
    updateIntervalMs: toNumber(env.UPDATE_INTERVAL_MS, 30_000, 5_000),
    cacheTtlMs: toNumber(env.CACHE_TTL_MS, 10 * 60 * 1000, 60_000),
    userAgent: env.APP_USER_AGENT || "april-ivy",
  };
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function toNumber(value: string | undefined, fallback: number, min: number): number {
  const parsed = value ? Number(value) : fallback;
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, parsed);
}

interface LastFmResponse {
  recenttracks?: {
    track?: Array<{
      name?: string;
      artist?: { "#text"?: string };
      album?: { "#text"?: string };
      image?: Array<{ "#text"?: string; size?: string }>;
      date?: { uts?: string };
      "@attr"?: { nowplaying?: string };
    }>;
  };
}

interface GithubContentResponse {
  type?: string;
  sha: string;
  content?: string;
  encoding?: BufferEncoding;
}

process.on("SIGINT", () => {
  console.log("\n[music] Received SIGINT, exiting…");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[music] Received SIGTERM, exiting…");
  process.exit(0);
});

void main();