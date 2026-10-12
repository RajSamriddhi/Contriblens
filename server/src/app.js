require("dotenv").config();
const analyzeRouter = require("./routes/analyze");
const reportsRouter = require("./routes/reports");
const express = require("express");

const app = express();
const PORT = 5000;

// Middleware: allows Express to read JSON request bodies
app.use(express.json());
app.use('/analyze',analyzeRouter)
app.use("/reports", reportsRouter);

// Test route
app.get("/", (req, res) => {
  res.json({
    message: "Welcome to ContribLens API!"
  });
});

// Health-check route
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "ContribLens server is running"
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`ContribLens server running on port ${PORT}`);
});