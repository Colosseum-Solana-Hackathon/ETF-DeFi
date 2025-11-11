"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const supabase_1 = require("../config/supabase");
const validation_1 = require("../utils/validation");
const walletRouter = express_1.default.Router();
walletRouter.use(express_1.default.json());
/**
 * POST /api/wallet/connect
 *
 * Saves wallet connection data to Supabase
 *
 * Request body:
 * {
 *   walletAddress: string (required) - Solana public key
 *   walletProvider: string (required) - e.g., 'Phantom', 'Solflare'
 *   connectedAt: string (required) - ISO 8601 timestamp
 *   network?: string - 'devnet' or 'mainnet-beta'
 *   userAgent?: string - browser user agent
 *   sessionId?: string - session identifier
 * }
 *
 * Response (200):
 * {
 *   success: true,
 *   message: "Wallet connection tracked successfully",
 *   walletId: "uuid"
 * }
 *
 * Response (400/500):
 * {
 *   success: false,
 *   message: "Error description"
 * }
 */
walletRouter.post("/connect", async (req, res) => {
    try {
        const { walletAddress, walletProvider, connectedAt, network, userAgent, sessionId, } = req.body;
        // Validate required fields
        if (!walletAddress || !walletProvider || !connectedAt) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: walletAddress, walletProvider, and connectedAt are required",
            });
        }
        // Validate Solana public key format
        if (!(0, validation_1.isValidSolanaAddress)(walletAddress)) {
            return res.status(400).json({
                success: false,
                message: "Invalid Solana wallet address format. Must be a valid base58-encoded public key (32-44 characters)",
            });
        }
        // Validate timestamp format
        if (!(0, validation_1.isValidISOTimestamp)(connectedAt)) {
            return res.status(400).json({
                success: false,
                message: "Invalid timestamp format. Must be a valid ISO 8601 timestamp string",
            });
        }
        // Validate network if provided
        if (network && network !== "devnet" && network !== "mainnet-beta") {
            return res.status(400).json({
                success: false,
                message: "Invalid network. Must be 'devnet' or 'mainnet-beta'",
            });
        }
        // Convert ISO string to PostgreSQL TIMESTAMPTZ
        const connectedAtDate = new Date(connectedAt);
        // Check if wallet connection already exists
        const { data: existingConnection } = await supabase_1.supabase
            .from("wallet_connections")
            .select("id")
            .eq("wallet_address", walletAddress)
            .single();
        let walletId;
        if (existingConnection) {
            // Update existing connection
            const { data, error } = await supabase_1.supabase
                .from("wallet_connections")
                .update({
                wallet_provider: walletProvider,
                connected_at: connectedAtDate.toISOString(),
                network: network || null,
                user_agent: userAgent || null,
                session_id: sessionId || null,
                updated_at: new Date().toISOString(),
            })
                .eq("wallet_address", walletAddress)
                .select("id")
                .single();
            if (error) {
                console.error("Supabase update error:", error);
                return res.status(500).json({
                    success: false,
                    message: "Failed to update wallet connection data",
                    error: error.message,
                });
            }
            walletId = data.id;
        }
        else {
            // Insert new connection
            const { data, error } = await supabase_1.supabase
                .from("wallet_connections")
                .insert({
                wallet_address: walletAddress,
                wallet_provider: walletProvider,
                connected_at: connectedAtDate.toISOString(),
                network: network || null,
                user_agent: userAgent || null,
                session_id: sessionId || null,
            })
                .select("id")
                .single();
            if (error) {
                console.error("Supabase insert error:", error);
                return res.status(500).json({
                    success: false,
                    message: "Failed to save wallet connection data",
                    error: error.message,
                });
            }
            walletId = data.id;
        }
        return res.status(200).json({
            success: true,
            message: existingConnection
                ? "Wallet connection updated successfully"
                : "Wallet connection tracked successfully",
            walletId: walletId,
        });
    }
    catch (err) {
        console.error("Wallet connect error:", err);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
exports.default = walletRouter;
