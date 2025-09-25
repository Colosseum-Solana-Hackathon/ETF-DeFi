import express from "express";
import jupiterRouter from "./routes/jupiterRouter";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./swagger";

const app = express();
app.use("/api/jupiter", jupiterRouter);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.listen(3000, () => console.log("Server running on port 3000"));

