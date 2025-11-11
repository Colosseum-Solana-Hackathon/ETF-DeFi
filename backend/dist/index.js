"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const jupiterRouter_1 = __importDefault(require("./routes/jupiterRouter"));
const walletRouter_1 = __importDefault(require("./routes/walletRouter"));
const authRouter_1 = __importDefault(require("./routes/authRouter"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_1 = __importDefault(require("./swagger"));
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
// Middleware
app.use(express_1.default.json());
// allow your frontend origin in dev
app.use((0, cors_1.default)({
    origin: [
        "http://localhost:3000", // your Next dev server
        "https://lyra-fe.vercel.app", // your Vercel domain
        "https://lyra.exchange" // your GoDadday domain
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
}));
app.use("/api/jupiter", jupiterRouter_1.default);
app.use("/api/wallet", walletRouter_1.default);
app.use("/api/auth", authRouter_1.default);
app.use("/api-docs", swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.default));
app.listen(8000, () => console.log("Server running on port 8000"));
