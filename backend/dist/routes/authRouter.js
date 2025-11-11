"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const supabase_1 = require("../config/supabase");
const authRouter = express_1.default.Router();
authRouter.use(express_1.default.json());
/**
 * POST /api/auth/refresh
 * Refreshes an access token using a refresh token
 */
authRouter.post("/refresh", async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: "Refresh token is required",
            });
        }
        // Exchange refresh token for new access token
        const { data, error } = await supabase_1.supabase.auth.refreshSession({
            refresh_token: refreshToken,
        });
        if (error || !data.session) {
            console.error("Token refresh error:", error);
            return res.status(401).json({
                success: false,
                message: "Invalid or expired refresh token",
                error: error?.message,
            });
        }
        return res.status(200).json({
            success: true,
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresIn: data.session.expires_in || 3600,
            tokenType: "Bearer",
        });
    }
    catch (err) {
        console.error("Refresh token error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to refresh token",
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
/**
 * POST /api/auth/logout
 * Logs out a user by invalidating their refresh token
 */
authRouter.post("/logout", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(" ")[1];
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "No authorization token provided",
            });
        }
        const { error } = await supabase_1.supabase.auth.signOut();
        if (error) {
            console.error("Logout error:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to logout",
                error: error.message,
            });
        }
        return res.status(200).json({
            success: true,
            message: "Logged out successfully",
        });
    }
    catch (err) {
        console.error("Logout error:", err);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
/**
 * GET /api/auth/me
 * Get current authenticated user info
 */
authRouter.get("/me", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(" ")[1];
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "No authorization token provided",
            });
        }
        const { data: { user }, error, } = await supabase_1.supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired token",
                error: error?.message,
            });
        }
        return res.status(200).json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                ...user.user_metadata,
            },
        });
    }
    catch (err) {
        console.error("Get user error:", err);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
exports.default = authRouter;
