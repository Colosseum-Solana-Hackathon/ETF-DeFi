import express from "express";
import jupiterRouter from "./routes/jupiterRouter";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./swagger";
import cors from "cors";

const app = express();

// allow your frontend origin in dev
app.use(
  cors({
    origin: ["http://localhost:3000"],     // your Next dev server
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

app.use("/api/jupiter", jupiterRouter);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.listen(8000, () => console.log("Server running on port 8000"));

