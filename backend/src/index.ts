import express from "express";
import jupiterRouter from "./routes/jupiterRouter";

const app = express();
app.use("/api/jupiter", jupiterRouter);
app.listen(3000, () => console.log("Server running on port 3000"));

