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
    from: process.env.EMAIL_FROM || '"Bounty Monitor 🎯" <mail.har.sh10.in>',
  },

  github: {
    token: process.env.GITHUB_TOKEN || process.env.TOKEN || "",
  },

  stateFile: path.join(__dirname, ".seen-issues.json"),
  languages: ["Go", "TypeScript", "Java", "JavaScript"],
  labels: ["💎 Bounty", "bounty", "Bounty"],
};

// ─── GITHUB SEARCH ───────────────────────────────────────────────────────────

async function fetchIssues() {
  const fetch = (await import("node-fetch")).default;
  const allIssues = [];

  for (const lang of CONFIG.languages) {
    const query = encodeURIComponent(
      `is:issue is:open no:assignee label:"💎 Bounty" language:${lang}`
    );
    const url = `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=30`;

    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "bounty-monitor/1.0",
    };
    if (CONFIG.github.token) {
      headers["Authorization"] = `Bearer ${CONFIG.github.token}`;
    }

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.error(`GitHub API error for ${lang}: ${res.status} ${res.statusText}`);
        continue;
      }
      const data = await res.json();
      const issues = (data.items || []).map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        url: i.html_url,
        repo: i.repository_url.replace("https://api.github.com/repos/", ""),
        language: lang,
        labels: i.labels.map((l) => l.name),
        created_at: i.created_at,
        body_snippet: (i.body || "").slice(0, 300).replace(/\n+/g, " "),
      }));
      allIssues.push(...issues);

      await new Promise((r) => setTimeout(r, 1200));
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
      <p style="margin:4px 0 0;opacity:0.85;">Unassigned · No PR · Go / TypeScript / Java / JavaScript</p>
    </div>
    <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
      ${htmlSections}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="color:#999;font-size:12px;text-align:center;">
        Monitored via GitHub Search API &nbsp;·&nbsp;
        <a href="https://github.com/search?q=is:issue+is:open+no:assignee+label:%22%F0%9F%92%8E+Bounty%22&type=issues" style="color:#0969da;">
          View all on GitHub
        </a>
      </p>
    </div>
  </div>`;

  await transporter.sendMail({
    from: CONFIG.email.from,
    to: CONFIG.email.to,
    subject: `🎯 ${newIssues.length} new bounty issue${newIssues.length > 1 ? "s" : ""} — Go/TS/Java/JS`,
    html,
  });

  console.log(`✅ Email sent with ${newIssues.length} new issues`);
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
  if (!CONFIG.email.auth.pass) {
    throw new Error("Missing SMTP_PASS. Add it to your .env or GitHub Actions secrets.");
  }

  const seen = loadSeen();
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
