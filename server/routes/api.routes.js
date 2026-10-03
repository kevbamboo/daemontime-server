import express from "express";

const apiRouter = express.Router();

// Preserve the retired endpoint for older clients. Supabase handles signups.
apiRouter.post("/auth/signup", (_req, res) => {
  res.status(410).json({
    error: "Use Supabase authentication to create an account",
  });
});

export default apiRouter;
