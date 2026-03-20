#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
require("dotenv").config();
const CONFIG = {
  email: {
    to: process.env.EMAIL_TO || "harxh@duck.com",

    host: "smtp.resend.com",
    port: 587,
    secure: false,
    auth: {
      user: "resend",
      pass: process.env.SMTP_PASS || "",
    },
    from: process.env.EMAIL_FROM || '"Bounty Monitor" <monitor@mail.har.sh10.in>',
  },

  github: {
    token: process.env.GITHUB_TOKEN || process.env.TOKEN || "",
  },

  stateFile: path.join(__dirname, ".seen-issues.json"),
  languages: ["Go", "TypeScript", "Java", "JavaScript"],
  labels: ["💎 Bounty", "bounty", "Bounty"],
};

/** Open unassigned bounty issues with no PR linked via closing keywords; `language:` added per fetch. */
const BOUNTY_ISSUE_QUERY_PREFIX =
  'is:issue is:open no:assignee -linked:pr label:"💎 Bounty"';

/** Rolling window: only issues with `created_at` within this many ms are kept (search is then filtered in JS). */
const BOUNTY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_DELAY_MS = 2500;
const MAX_RETRIES = 3;

// ─── GITHUB SEARCH ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseGithubErrorText(text) {
  try {
    const errJson = JSON.parse(text);
    if (errJson && errJson.message) return errJson.message;
  } catch {
    /* ignore */
  }
  return text ? text.slice(0, 200) : "";
}

function toGithubDateUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchWithRetry(fetch, url, headers, lang) {
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    const res = await fetch(url, { headers });
    if (res.ok) return res;

    const text = await res.text();
    const message = parseGithubErrorText(text);
    const isSecondaryLimit = res.status === 403 && /secondary rate limit/i.test(message);

    if (!isSecondaryLimit || attempt === MAX_RETRIES) {
      console.error(`GitHub API error for ${lang}: ${res.status} ${res.statusText}${message ? ` — ${message}` : ""}`);
      return { res: null, hitSecondaryLimit: isSecondaryLimit };
    }

    const retryAfterSeconds = Number(res.headers.get("retry-after")) || 0;
    const backoffMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 15000 * (attempt + 1);
    console.warn(
      `GitHub secondary rate limit for ${lang}. Retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(
        backoffMs / 1000
      )}s...`
    );
    await sleep(backoffMs);
    attempt += 1;
  }

  return { res: null, hitSecondaryLimit: false };
}

async function fetchIssues() {
  const fetch = (await import("node-fetch")).default;
  const allIssues = [];
  const minCreatedMs = Date.now() - BOUNTY_MAX_AGE_MS;
  const minCreatedDate = toGithubDateUtc(minCreatedMs);

  for (const lang of CONFIG.languages) {
    const query = encodeURIComponent(
      `${BOUNTY_ISSUE_QUERY_PREFIX} created:>=${minCreatedDate} language:${lang}`
    );
    const url = `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=30`;

    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bounty-monitor/1.0",
    };
    if (CONFIG.github.token) {
      headers.Authorization = `Bearer ${CONFIG.github.token}`;
    }

    try {
      const { res, hitSecondaryLimit } = await fetchWithRetry(fetch, url, headers, lang);
      if (!res) {
        if (hitSecondaryLimit) {
          console.warn("Stopping remaining language searches for this run due to secondary rate limit.");
          break;
        }
        continue;
      }
      const data = await res.json();
      const issues = (data.items || [])
        .map((i) => ({
          id: i.id,
          number: i.number,
          title: i.title,
          url: i.html_url,
          repo: i.repository_url.replace("https://api.github.com/repos/", ""),
          language: lang,
          labels: i.labels.map((l) => l.name),
          created_at: i.created_at,
          body_snippet: (i.body || "").slice(0, 300).replace(/\n+/g, " "),
        }))
        .filter((i) => new Date(i.created_at).getTime() > minCreatedMs);
      allIssues.push(...issues);

      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      console.error(`Fetch error for ${lang}:`, err.message);
    }
  }

  return allIssues;
}

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify([...seen]), "utf8");
}

async function sendEmail(newIssues) {
  const nodemailer = require("nodemailer");
  const fromAddress = normalizeFromAddress(CONFIG.email.from, CONFIG.email.to);

  const transporter = nodemailer.createTransport({
    host: CONFIG.email.host,
    port: CONFIG.email.port,
    secure: CONFIG.email.secure,
    auth: CONFIG.email.auth,
  });

  // Group by language
  const grouped = {};
  for (const issue of newIssues) {
    if (!grouped[issue.language]) grouped[issue.language] = [];
    grouped[issue.language].push(issue);
  }

  const htmlSections = Object.entries(grouped)
    .map(([lang, issues]) => {
      const rows = issues
        .map(
          (i) => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #f0f0f0;">
            <a href="${i.url}" style="color:#0969da;font-weight:600;text-decoration:none;">
              ${escapeHtml(i.title)}
            </a>
            <br/>
            <span style="color:#666;font-size:12px;">
              📁 ${i.repo} &nbsp;|&nbsp; 🏷️ ${i.labels.join(", ")} &nbsp;|&nbsp;
              📅 ${new Date(i.created_at).toDateString()}
            </span>
            ${
              i.body_snippet
                ? `<p style="color:#555;font-size:12px;margin:6px 0 0;">${escapeHtml(i.body_snippet)}…</p>`
                : ""
            }
          </td>
        </tr>`
        )
        .join("");

      return `
      <h3 style="color:#333;border-left:4px solid #0969da;padding-left:10px;">
        ${langEmoji(lang)} ${lang} (${issues.length})
      </h3>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>`;
    })
    .join("<hr/>");

  const html = `
  <div style="font-family:sans-serif;max-width:700px;margin:auto;">
    <div style="background:#0969da;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;">🎯 ${newIssues.length} New Bounty Issue${newIssues.length > 1 ? "s" : ""} Found</h2>
      <p style="margin:4px 0 0;opacity:0.85;">Opened in the last 24h · Unassigned · No linked PR · Go / TS / Java / JS</p>
    </div>
    <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
      ${htmlSections}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="color:#999;font-size:12px;text-align:center;">
        Only issues created in the last 24 hours are emailed (rolling window). &nbsp;·&nbsp;
        <a href="https://github.com/search?q=${encodeURIComponent(
          BOUNTY_ISSUE_QUERY_PREFIX
        )}&type=issues" style="color:#0969da;">
          Similar search on GitHub
        </a>
      </p>
    </div>
  </div>`;

  await transporter.sendMail({
    from: fromAddress,
    to: CONFIG.email.to,
    subject: `🎯 ${newIssues.length} new bounty issue${newIssues.length > 1 ? "s" : ""} (24h) — Go/TS/Java/JS`,
    html,
  });

  console.log(`✅ Email sent with ${newIssues.length} new issues`);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || "").trim());
}

function normalizeFromAddress(from, fallbackTo) {
  const raw = (from || "").trim();
  const angledMatch = raw.match(/^\s*(?:"?([^"]+)"?\s*)?<([^>]+)>\s*$/);

  if (angledMatch) {
    const name = (angledMatch[1] || "Bounty Monitor").trim();
    const email = angledMatch[2].trim();
    if (isValidEmail(email)) return `"${name}" <${email}>`;
  } else if (isValidEmail(raw)) {
    return raw;
  }

  if (isValidEmail(fallbackTo)) return `"Bounty Monitor" <${fallbackTo}>`;
  throw new Error(
    "Invalid EMAIL_FROM format. Use `email@example.com` or `Name <email@example.com>`."
  );
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function langEmoji(lang) {
  return { Go: "🐹", TypeScript: "🔷", Java: "☕", JavaScript: "🟨" }[lang] || "📌";
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Checking GitHub for new bounty issues...`);
  if (!CONFIG.github.token) {
    console.warn(
      "No GITHUB_TOKEN/TOKEN — unauthenticated Search API is heavily limited (403). Set TOKEN locally or rely on Actions passing github.token."
    );
  }
  if (!CONFIG.email.auth.pass) {
    throw new Error("Missing SMTP_PASS. Add it to your .env or GitHub Actions secrets.");
  }

  const resetSeen = ["1", "true", "yes"].includes(
    String(process.env.RESET_SEEN || "").toLowerCase()
  );
  if (resetSeen) {
    console.log("Resetting seen issues state for this run.");
  }

  const seen = resetSeen ? new Set() : loadSeen();
  const issues = await fetchIssues();

  const newIssues = issues.filter((i) => !seen.has(i.id));

  if (newIssues.length === 0) {
    console.log("No new issues found.");
    for (const i of issues) seen.add(i.id);
    saveSeen(seen);
    return;
  }

  console.log(`Found ${newIssues.length} new issue(s):`);
  newIssues.forEach((i) => console.log(`  - [${i.language}] ${i.title} → ${i.url}`));

  await sendEmail(newIssues);

  // Mark all as seen
  for (const i of issues) seen.add(i.id);
  saveSeen(seen);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
