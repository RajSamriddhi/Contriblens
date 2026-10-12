
const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// Fetch paginated GitHub API data.
// Each page contains up to 100 records.
async function fetchPaginatedData(url, headers, maxPages = 3) {
  const allItems = [];

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = new URL(url);

    pageUrl.searchParams.set("per_page", "100");
    pageUrl.searchParams.set("page", page.toString());

    const response = await fetch(pageUrl, {
      headers,
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const error = new Error(
        `GitHub API request failed with status ${response.status}`
      );

      error.status = response.status;
      error.isGitHubApiError = true;
      throw error;
    }

    const items = await response.json();

    if (!Array.isArray(items)) {
      throw new Error("GitHub returned an unexpected response.");
    }

    allItems.push(...items);

    if (items.length < 100) {
      break;
    }
  }

  return allItems;
}

// POST /analyze
router.post("/", async (req, res) => {
  try {
    // 1. Validate the repository URL.
    const { repoUrl } = req.body ?? {};

    if (typeof repoUrl !== "string" || !repoUrl.trim()) {
      return res.status(400).json({
        error: "Please provide a GitHub repository URL."
      });
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(repoUrl.trim());
    } catch {
      return res.status(400).json({
        error: "Invalid URL. Please provide a valid GitHub repository URL."
      });
    }

    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "github.com" ||
      parsedUrl.port ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      return res.status(400).json({
        error: "Only HTTPS GitHub repository URLs are allowed."
      });
    }

    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

    if (
      pathParts.length !== 2 ||
      !/^[a-zA-Z0-9-]+$/.test(pathParts[0]) ||
      !/^[a-zA-Z0-9_.-]+$/.test(pathParts[1]) ||
      pathParts[1] === "." ||
      pathParts[1] === ".."
    ) {
      return res.status(400).json({
        error: "URL must have the format https://github.com/owner/repo"
      });
    }

    const [owner, repo] = pathParts;

    // 2. Prepare GitHub API request headers.
    const headers = {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

    // 3. Fetch repository details.
    const repoResponse = await fetch(baseUrl, {
      headers,
      signal: AbortSignal.timeout(15000)
    });

    if (repoResponse.status === 404) {
      return res.status(404).json({
        error: "Repository not found or not publicly accessible."
      });
    }

    if (repoResponse.status === 403 || repoResponse.status === 429) {
      const errorBody = await repoResponse.text();

      console.error("GitHub status:", repoResponse.status);
      console.error("GitHub response:", errorBody);

      return res.status(repoResponse.status).json({
        error: "GitHub rejected the request.",
        status: repoResponse.status,
        details: errorBody,
        rateLimitRemaining:
          repoResponse.headers.get("x-ratelimit-remaining"),
        rateLimitReset:
          repoResponse.headers.get("x-ratelimit-reset")
      });
    }

    if (!repoResponse.ok) {
      return res.status(502).json({
        error: "Failed to fetch repository details from GitHub."
      });
    }

    const repositoryData = await repoResponse.json();

    // 4. Fetch contributors, commits and pull requests concurrently.
    const [
      contributorsData,
      commitsData,
      pullsData
    ] = await Promise.all([
      fetchPaginatedData(`${baseUrl}/contributors`, headers),
      fetchPaginatedData(`${baseUrl}/commits`, headers),
      fetchPaginatedData(`${baseUrl}/pulls?state=all`, headers)
    ]);

    // 5. Format contributors.
    const contributors = contributorsData
      .filter(person => person.login)
      .map(person => ({
        username: person.login,
        profileUrl: person.html_url,
        contributions: person.contributions
      }));

    // 6. Format commits.
    const commits = commitsData.map(commit => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.author?.login ?? null,
      authorName: commit.commit.author?.name ?? null,
      date: commit.commit.author?.date ?? null,
      url: commit.html_url
    }));

    // 7. Format pull requests.
    const pullRequests = pullsData.map(pr => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? null,
      state: pr.state,
      merged: pr.merged_at !== null,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      url: pr.html_url
    }));

    // 8. Count pull requests by author in the fetched sample.
    const pullRequestCounts = new Map();

    for (const pr of pullRequests) {
      if (!pr.author) continue;

      pullRequestCounts.set(
        pr.author,
        (pullRequestCounts.get(pr.author) || 0) + 1
      );
    }

    // 9. Calculate relative contribution scores.
    const maxContributions = Math.max(
      0,
      ...contributors.map(person => person.contributions ?? 0)
    );

    const knownContributorScores = contributors.map(person => {
      const rawScore =
        maxContributions > 0
          ? (person.contributions / maxContributions) * 100
          : null;

      return {
        username: person.username,
        contributions: person.contributions,
        pullRequestsInFetchedSample:
          pullRequestCounts.get(person.username) || 0,
        score: rawScore === null ? null : Number(rawScore.toFixed(2)),
        scoreStatus:
          rawScore === null
            ? "unavailable"
            : "based_on_returned_contribution_counts"
      };
    });

    // 10. Include PR authors whose contribution counts are unknown.
    const knownContributorNames = new Set(
      contributors.map(person => person.username)
    );

    const unknownContributorScores = [];

    for (const [username, prCount] of pullRequestCounts) {
      if (knownContributorNames.has(username)) continue;

      unknownContributorScores.push({
        username,
        contributions: null,
        pullRequestsInFetchedSample: prCount,
        score: null,
        scoreStatus: "unknown_contribution_count"
      });
    }

    // 11. Combine and sort scores.
    const contributionScores = [
      ...knownContributorScores,
      ...unknownContributorScores
    ];

    contributionScores.sort((a, b) => {
      if (a.score === null && b.score === null) {
        return a.username.localeCompare(b.username);
      }

      if (a.score === null) return 1;
      if (b.score === null) return -1;

      return b.score - a.score;
    });

    // 12. Find or create the repository in PostgreSQL.
    // Use GitHub's canonical URL to avoid duplicate repository records.
    const canonicalUrl = repositoryData.html_url.replace(/\/+$/, "");

    const savedRepository = await prisma.repository.upsert({
      where: {
        githubUrl: canonicalUrl
      },
      update: {
        owner: repositoryData.owner.login,
        name: repositoryData.name,
        fullName: repositoryData.full_name,
        description: repositoryData.description,
        stars: repositoryData.stargazers_count,
        forks: repositoryData.forks_count,
        openIssues: repositoryData.open_issues_count,
        language: repositoryData.language,
        defaultBranch: repositoryData.default_branch
      },
      create: {
        githubUrl: canonicalUrl,
        owner: repositoryData.owner.login,
        name: repositoryData.name,
        fullName: repositoryData.full_name,
        description: repositoryData.description,
        stars: repositoryData.stargazers_count,
        forks: repositoryData.forks_count,
        openIssues: repositoryData.open_issues_count,
        language: repositoryData.language,
        defaultBranch: repositoryData.default_branch
      }
    });

    // 13. Create a NEW report for every successful analysis.
    // Save its contributor snapshots in the same nested operation.
    const savedReport = await prisma.analysisReport.create({
      data: {
        repositoryId: savedRepository.id,
        contributorCount: contributionScores.length,
        commitCount: commits.length,
        pullRequestCount: pullRequests.length,
        scoringFormula:
          "Contribution count / highest returned contribution count * 100",
        isLimitedSample: true,

        contributors: {
          create: contributionScores.map(person => ({
            username: person.username,
            profileUrl:
              contributors.find(
                contributor => contributor.username === person.username
              )?.profileUrl ?? null,
            contributions: person.contributions,
            pullRequestsInFetchedSample:
              person.pullRequestsInFetchedSample,
            score: person.score,
            scoreStatus: person.scoreStatus
          }))
        }
      },
      select: {
        id: true,
        analyzedAt: true
      }
    });

    console.log("Analysis saved:", savedReport.id);

    // 14. Return the analysis and its saved report details.
    return res.status(200).json({
      message: "Repository analysis data fetched successfully!",

      savedReport: {
        id: savedReport.id,
        analyzedAt: savedReport.analyzedAt,
        repositoryId: savedRepository.id
      },

      repository: {
        name: repositoryData.name,
        fullName: repositoryData.full_name,
        description: repositoryData.description,
        url: repositoryData.html_url,
        stars: repositoryData.stargazers_count,
        forks: repositoryData.forks_count,
        openIssues: repositoryData.open_issues_count,
        language: repositoryData.language,
        defaultBranch: repositoryData.default_branch
      },

      contributors: {
        countReturned: contributors.length,
        items: contributors
      },

      commits: {
        countReturned: commits.length,
        items: commits
      },

      pullRequests: {
        countReturned: pullRequests.length,
        items: pullRequests
      },

      contributionScores: {
        formula:
          "Contribution count / highest returned contribution count × 100",

        note:
          "Scores compare GitHub's returned contributor counts. They do not measure developer quality. A missing score means the contribution count is unknown.",

        dataLimitations: {
          pagination: "Fetches at most 3 pages of 100 records per endpoint.",
          resultsAreLimitedSamples: true,
          maxRecordsPerEndpoint: 300,
          pullRequestCountsArePartial: true,
          pullRequestsIncludedInScore: false,
          scoreIsRelative: true,
          snapshotMayChangeDuringFetch: true
        },

        items: contributionScores
      }
    });
  } catch (error) {
    // 15. Handle timeouts.
    if (
      error.name === "TimeoutError" ||
      error.name === "AbortError"
    ) {
      return res.status(504).json({
        error: "A GitHub request timed out. Please try again."
      });
    }

    // 16. Handle GitHub errors from paginated requests.
    if (error.isGitHubApiError) {
      if (error.status === 403 || error.status === 429) {
        return res.status(error.status).json({
          error: "GitHub rejected a paginated API request.",
          status: error.status
        });
      }

      return res.status(502).json({
        error: "Failed to fetch analysis data from GitHub.",
        details: error.message
      });
    }

    // 17. Log unexpected errors, including database errors.
    console.error("Analysis error:", error);

    return res.status(500).json({
      error: "An unexpected server error occurred."
    });
  }
});

module.exports = router;

