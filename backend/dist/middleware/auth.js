"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateToken = authenticateToken;
exports.optionalAuth = optionalAuth;
const supabase_1 = require("../config/supabase");
/**
 * Middleware to authenticate requests using Supabase JWT
 */
async function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN
        if (!token) {
            res.status(401).json({
                success: false,
                message: "No authorization token provided",
            });
            return;
        }
        // Verify the JWT token with Supabase
        const { data: { user }, error, } = await supabase_1.supabase.auth.getUser(token);
        if (error || !user) {
            res.status(401).json({
                success: false,
                message: "Invalid or expired token",
                error: error?.message,
            });
            return;
        }
        // Attach user info to request
        req.user = {
            id: user.id,
            email: user.email,
            ...user.user_metadata,
        };
        req.accessToken = token;
        next();
    }
    catch (err) {
        console.error("Authentication error:", err);
        res.status(500).json({
            success: false,
            message: "Authentication failed",
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
/**
 * Optional middleware - only require auth if token is provided
 */
async function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(" ")[1];
        if (token) {
            const { data: { user }, } = await supabase_1.supabase.auth.getUser(token);
            if (user) {
                req.user = {
                    id: user.id,
                    email: user.email,
                    ...user.user_metadata,
                };
                req.accessToken = token;
            }
        }
        next();
    }
    catch (err) {
        // Continue without auth if token is invalid
        next();
    }
}
