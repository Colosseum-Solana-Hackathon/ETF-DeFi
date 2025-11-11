import express from "express";
import jupiterRouter from "./routes/jupiterRouter";
import walletRouter from "./routes/walletRouter";
import authRouter from "./routes/authRouter";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./swagger";
import cors from "cors";

const app = express();

// Middleware
app.use(express.json());

// allow your frontend origin in dev
app.use(
  cors({
    origin: [
      "http://localhost:3000",     // your Next dev server
      "https://lyra-fe.vercel.app", // your Vercel domain
      "https://lyra.exchange" // your GoDadday domain
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

app.use("/api/jupiter", jupiterRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/auth", authRouter);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.listen(8000, () => console.log("Server running on port 8000"));

