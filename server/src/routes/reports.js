
const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");

// GET /reports
// Fetch the latest 20 analysis reports
router.get("/", async (req, res) => {
  try {
    const reports = await prisma.analysisReport.findMany({
      orderBy: {
        analyzedAt: "desc",
      },
      take: 20,
      include: {
        repository: {
          select: {
            owner: true,
            name: true,
            fullName: true,
            githubUrl: true,
            language: true,
            stars: true,
          },
        },
      },
    });

    return res.status(200).json({
      message: "Report history fetched successfully!",
      count: reports.length,
      reports,
    });
  } catch (error) {
    console.error("Error fetching report history:", error);

    return res.status(500).json({
      error: "Failed to fetch report history.",
    });
  }
});

/*
 * GET /reports/:id
 * Fetch one saved report and its contributors.
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const report = await prisma.analysisReport.findUnique({
      where: {
        id: id,
      },
      include: {
        repository: true,
        contributors: {
        orderBy: [
            { score: { sort: "desc", nulls: "last" } },
            { contributions: { sort: "desc", nulls: "last" } },
            { username: "asc" }
        ]
        }
      },
    });

    if (!report) {
      return res.status(404).json({
        error: "Analysis report not found.",
      });
    }

    return res.status(200).json({
      message: "Report details fetched successfully!",
      report,
    });
  } catch (error) {
    console.error("Error fetching report details:", error);

    return res.status(500).json({
      error: "Failed to fetch report details.",
    });
  }
});


module.exports = router;
