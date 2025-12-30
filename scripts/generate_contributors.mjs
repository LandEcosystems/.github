import fs from "node:fs/promises";

const OWNER = "LandEcosystems";
const GRAPHQL_URL = "https://api.github.com/graphql";

// Keep this focused: we compute "org contributors" as contributors to these key repos.
const REPOS = [
  "Sindbad",
  "Sindbad-Tutorials",
  "SindbadDataExtractor",
  "TimeSamplers.jl",
  "ErrorMetrics.jl",
  "OmniTools.jl",
];

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

function replaceBetweenMarkers(readme, start, end, replacement) {
  const startIdx = readme.indexOf(start);
  const endIdx = readme.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Markers not found: ${start} / ${end}`);
  }
  const before = readme.slice(0, startIdx + start.length);
  const after = readme.slice(endIdx);
  return `${before}\n\n${replacement}\n\n${after}`;
}

function repoLink(owner, repo) {
  const label = mdEscape(`${owner}/${repo}`);
  const url = `https://github.com/${owner}/${repo}`;
  return `[\\\`${label}\\\`](${url})`;
}

async function graphql(query, variables) {
  if (!token) {
    throw new Error("GraphQL requests require GITHUB_TOKEN (needed to read pinned repositories).");
  }

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "LandEcosystems-org-profile",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(`GitHub GraphQL error\n${JSON.stringify(json, null, 2)}`);
  }
  return json.data;
}

async function getPinnedRepos(limit = 6) {
  const query = `
    query($login: String!, $first: Int!) {
      organization(login: $login) {
        pinnedItems(first: $first, types: REPOSITORY) {
          nodes {
            ... on Repository {
              name
              url
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, { login: OWNER, first: limit });
  const nodes = data?.organization?.pinnedItems?.nodes ?? [];
  return nodes.filter(Boolean);
}

async function getRecentlyUpdatedRepos(limit = 6) {
  // Returns public repos (excluding .github), sorted by recently updated.
  const res = await gh(`/orgs/${OWNER}/repos?per_page=100&type=public&sort=updated`);
  const repos = await res.json();
  if (!Array.isArray(repos)) return [];
  return repos
    .filter((r) => r?.name && r.name !== ".github")
    .slice(0, limit)
    .map((r) => ({ name: r.name, url: r.html_url }));
}

function buildFeaturedTable(repos) {
  const cols = 3;
  const cells = repos.slice(0, 6).map((r) => {
    const name = r.name;
    const url = r.url || `https://github.com/${OWNER}/${name}`;
    const img = `https://opengraph.githubassets.com/1/${OWNER}/${name}`;
    return `<a href="${url}"><img alt="${OWNER}/${name}" src="${img}" width="400" /></a>`;
  });

  const rows = [];
  for (let i = 0; i < cells.length; i += cols) {
    rows.push(cells.slice(i, i + cols));
  }

  const html = [
    "<table>",
    ...rows.map((row) => {
      const tds = row.map((c) => `    <td>\n      ${c}\n    </td>`).join("\n");
      return `  <tr>\n${tds}\n  </tr>`;
    }),
    "</table>",
  ].join("\n");

  return html;
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

  const readmePath = new URL("../profile/README.md", import.meta.url);
  let readme = await fs.readFile(readmePath, "utf8");

  // Featured repositories: prefer org pinned repos (via GraphQL); fall back to REPOS.
  const featuredStart = "<!-- FEATURED:START -->";
  const featuredEnd = "<!-- FEATURED:END -->";
  let featuredRepos = [];
  try {
    featuredRepos = await getPinnedRepos(6);
  } catch {}

  // If org has no pins (or GraphQL failed), fall back to recently-updated repos.
  if (featuredRepos.length === 0) {
    try {
      featuredRepos = await getRecentlyUpdatedRepos(6);
    } catch {}
  }

  // Final fallback: the configured list.
  if (featuredRepos.length === 0) {
    featuredRepos = REPOS.map((name) => ({ name, url: `https://github.com/${OWNER}/${name}` })).slice(0, 6);
  }
  readme = replaceBetweenMarkers(readme, featuredStart, featuredEnd, buildFeaturedTable(featuredRepos));

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

  const start = "<!-- CONTRIBUTORS:START -->";
  const end = "<!-- CONTRIBUTORS:END -->";
  const block = [
    `Updated from: ${REPOS.map((r) => repoLink(OWNER, r)).join(", ")}`,
    "",
    buildTable(top),
  ].join("\n");

  const next = replaceBetweenMarkers(readme, start, end, block);

  await fs.writeFile(readmePath, next, "utf8");
  console.log("Updated profile/README.md featured + contributors sections.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


