// Minimal GitHub REST client: upsert the marked PR comment and publish the `archlens/model-diff` check.
import { execFileSync } from "node:child_process";

export const CHECK_NAME = "archlens/model-diff";

function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("no GITHUB_TOKEN and `gh auth token` failed");
  }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      "user-agent": "archlens-poc",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export async function upsertComment(repo: string, pr: number, marker: string, body: string): Promise<{ id: number; url: string; created: boolean }> {
  for (let page = 1; page < 20; page++) {
    const list: any[] = await api("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    const hit = list.find((c) => typeof c.body === "string" && c.body.includes(marker));
    if (hit) {
      const r = await api("PATCH", `/repos/${repo}/issues/comments/${hit.id}`, { body });
      return { id: r.id, url: r.html_url, created: false };
    }
    if (list.length < 100) break;
  }
  const r = await api("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  return { id: r.id, url: r.html_url, created: true };
}

// A check run carries the full R1 messages in its summary (needs `checks: write`, available to Actions).
// Locally, an OAuth token cannot create check runs, so a commit status (140 character description) is used.
export async function publishCheck(repo: string, sha: string, passed: boolean, summary: string, shortDescription: string, detailsUrl?: string, mode: "auto" | "check" | "status" = "auto") {
  const title = passed ? "R1 passed: compose and model agree" : "R1 failed: compose and model disagree";
  if (mode !== "status") {
    try {
      await api("POST", `/repos/${repo}/check-runs`, {
        name: CHECK_NAME,
        head_sha: sha,
        status: "completed",
        conclusion: passed ? "success" : "failure",
        details_url: detailsUrl,
        output: { title, summary: summary.slice(0, 60000) },
      });
      return "check-run";
    } catch (e) {
      if (mode === "check") throw e;
    }
  }
  await api("POST", `/repos/${repo}/statuses/${sha}`, {
    state: passed ? "success" : "failure",
    context: CHECK_NAME,
    description: shortDescription.slice(0, 140),
    target_url: detailsUrl,
  });
  return "status";
}
