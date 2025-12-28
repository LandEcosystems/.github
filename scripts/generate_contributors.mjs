import fs from "node:fs/promises";

const OWNER = "LandEcosystems";

// Keep this focused: we compute "org contributors" as contributors to these key repos.
const REPOS = ["Sindbad", "Sindbad-Tutorials", "TimeSamplers.jl", "ErrorMetrics.jl"];

const token = process.env.GITHUB_TOKEN; // optional (unauthenticated GitHub API works, but is rate-limited)

async function gh(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "LandEcosystems-org-profile",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`https://api.github.com${path}`, {
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${path}\n${body}`);
  }
  return res;
}

async function listContributors(repo) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await gh(`/repos/${OWNER}/${repo}/contributors?per_page=100&page=${page}&anon=false`);
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    if (items.length < 100) break;
    page += 1;
  }
  return all;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, "\\|");
}

function buildTable(top) {
  if (top.length === 0) return "_No contributors found._";

  const cells = top.map((u) => {
    const login = mdEscape(u.login);
    const url = u.html_url;
    const avatar = `${u.avatar_url}&s=96`;
    return `<a href="${url}"><img src="${avatar}" width="48" height="48" alt="${login}"/><br/><sub>${login}</sub></a>`;
  });

  // 8 columns for a compact grid
  const cols = 8;
  const rows = [];
  for (let i = 0; i < cells.length; i += cols) {
    rows.push(`| ${cells.slice(i, i + cols).join(" | ")} |`);
  }

  const header = `| ${Array.from({ length: Math.min(cols, cells.length) }).map(() => " ").join(" | ")} |`;
  const sep = `| ${Array.from({ length: Math.min(cols, cells.length) }).map(() => "---").join(" | ")} |`;
  return [header, sep, ...rows].join("\n");
}

async function main() {
  const byLogin = new Map(); // login -> {login, html_url, avatar_url, contributions}

  for (const repo of REPOS) {
    const contributors = await listContributors(repo);
    for (const c of contributors) {
      if (!c?.login || !c?.html_url || !c?.avatar_url) continue;
      const prev = byLogin.get(c.login);
      const contributions = Number(c.contributions || 0);
      if (!prev) {
        byLogin.set(c.login, {
          login: c.login,
          html_url: c.html_url,
          avatar_url: c.avatar_url,
          contributions,
        });
      } else {
        prev.contributions += contributions;
      }
    }
  }

  const top = [...byLogin.values()]
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, 32);

  const block = [
    `Updated from: ${REPOS.map((r) => `\`${OWNER}/${r}\``).join(", ")}`,
    "",
    buildTable(top),
  ].join("\n");

  const readmePath = new URL("../profile/README.md", import.meta.url);
  const readme = await fs.readFile(readmePath, "utf8");

  const start = "<!-- CONTRIBUTORS:START -->";
  const end = "<!-- CONTRIBUTORS:END -->";
  const startIdx = readme.indexOf(start);
  const endIdx = readme.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error("Contributors markers not found in profile/README.md");
  }

  const before = readme.slice(0, startIdx + start.length);
  const after = readme.slice(endIdx);
  const next = `${before}\n\n${block}\n\n${after}`;

  await fs.writeFile(readmePath, next, "utf8");
  console.log("Updated profile/README.md contributors section.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


