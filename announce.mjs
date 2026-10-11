import { readFile, writeFile } from "node:fs/promises";

const STATE_FILE = process.env.STATE_FILE ?? "posted.json";
const DRY_RUN = process.argv.includes("--dry-run");
const EXCERPT_LIMIT = 350;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
}

function parseFeed(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
    const link = decodeEntities(tag(item, "link"));
    return {
      guid: decodeEntities(tag(item, "guid")) || link,
      title: decodeEntities(tag(item, "title")),
      link,
      date: new Date(tag(item, "pubDate")),
      html: decodeEntities(tag(item, "description")),
      image: item.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image\//i)?.[1] ?? null,
    };
  });
}

function htmlToMarkdown(html) {
  const md = html
    .replace(/<div class="bb_h[1-3]">([\s\S]*?)<\/div>/gi, "\n**$1**\n")
    .replace(/<li>\s*/gi, "\n• ")
    .replace(/<\/(ul|ol|p|div|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(b|strong)>/gi, "**")
    .replace(/<\/?(i|em)>/gi, "*")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = text.replace(/<[^>]+>/g, "").trim();
      return label ? `[${label}](${href})` : "";
    })
    .replace(/<[^>]+>/g, "");
  return decodeEntities(md)
    .replace(/\*\*[ \t]*\*\*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n+• /g, "\n• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function excerpt(markdown) {
  if (markdown.length <= EXCERPT_LIMIT) return markdown;
  let cut = markdown.slice(0, EXCERPT_LIMIT);
  cut = cut.slice(0, Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n")));
  cut = cut.replace(/\[[^\]]*$/, "");
  if ((cut.match(/\*\*/g) ?? []).length % 2) cut += "**";
  return `${cut.trimEnd()}…`;
}

function buildPayload(feed, target, item) {
  return {
    content: target.ping ?? "",
    allowed_mentions: { parse: target.ping ? ["everyone", "roles"] : [] },
    username: feed.name,
    ...(feed.avatar ? { avatar_url: feed.avatar } : {}),
    embeds: [
      {
        author: { name: "Steam announcement" },
        title: item.title.slice(0, 256),
        url: item.link,
        description: `${excerpt(htmlToMarkdown(item.html))}\n\n[Read the full post on Steam](${item.link})`,
        color: feed.color,
        ...(item.image ? { image: { url: item.image } } : {}),
        footer: { text: `${feed.name} on Steam` },
        timestamp: item.date.toISOString(),
      },
    ],
  };
}

async function post(webhook, payload) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${webhook}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 2) * 1000)));
      continue;
    }
    throw new Error(`Discord returned ${res.status}: ${await res.text()}`);
  }
  throw new Error("Discord kept rate limiting the webhook");
}

function record(item, postedAt) {
  return { guid: item.guid, title: item.title, published: item.date.toISOString(), postedAt };
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

const feeds = JSON.parse(await readFile(new URL("./feeds.json", import.meta.url), "utf8"));
const state = await loadState();
let failed = false;

for (const feed of feeds) {
  const res = await fetch(feed.rss, { headers: { "User-Agent": "SaveSync-announcer" } });
  if (!res.ok) {
    console.error(`${feed.name}: feed returned ${res.status}`);
    failed = true;
    continue;
  }
  const items = parseFeed(await res.text()).sort((a, b) => a.date - b.date);

  if (DRY_RUN) {
    const latest = items.at(-1);
    for (const target of feed.targets) {
      console.log(`${target.channel}: ${items.length} items, latest payload:`);
      if (latest) console.log(JSON.stringify(buildPayload(feed, target, latest), null, 2));
    }
    continue;
  }

  for (const target of feed.targets) {
    if (!(await announce(feed, target, items))) failed = true;
  }
}

if (failed) process.exitCode = 1;

async function announce(feed, target, items) {
  const key = target.channel;

  if (!state[key]) {
    state[key] = items.map((i) => record(i, null));
    await saveState(state);
    console.log(`${key}: first run, recorded ${items.length} existing posts without posting`);
    return true;
  }

  const seen = new Set(state[key].map((r) => r.guid));
  const fresh = items.filter((i) => !seen.has(i.guid));
  if (!fresh.length) {
    console.log(`${key}: nothing new`);
    return true;
  }

  const webhook = process.env[target.webhookEnv];
  if (!webhook) {
    console.error(`${key}: ${target.webhookEnv} is not set`);
    return false;
  }

  for (const item of fresh) {
    try {
      await post(webhook, buildPayload(feed, target, item));
    } catch (err) {
      console.error(`${key}: failed to post "${item.title}": ${err.message}`);
      return false;
    }
    state[key].push(record(item, new Date().toISOString()));
    await saveState(state);
    console.log(`${key}: posted "${item.title}"`);
  }
  return true;
}
