import express, { Request, Response } from "express";
import { supabase } from "../config/supabase";
import { isValidSolanaAddress, isValidISOTimestamp } from "../utils/validation";

const walletRouter = express.Router();
walletRouter.use(express.json());

interface WalletConnectRequest {
  walletAddress: string;
  walletProvider: string;
  connectedAt: string;
  network?: string;
  userAgent?: string;
  sessionId?: string;
}

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
walletRouter.post("/connect", async (req: Request, res: Response) => {
  try {
    const {
      walletAddress,
      walletProvider,
      connectedAt,
      network,
      userAgent,
      sessionId,
    }: WalletConnectRequest = req.body;

    // Validate required fields
    if (!walletAddress || !walletProvider || !connectedAt) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: walletAddress, walletProvider, and connectedAt are required",
      });
    }

    // Validate Solana public key format
    if (!isValidSolanaAddress(walletAddress)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Solana wallet address format. Must be a valid base58-encoded public key (32-44 characters)",
      });
    }

    // Validate timestamp format
    if (!isValidISOTimestamp(connectedAt)) {
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

    // Insert into Supabase
    const { data, error } = await supabase
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

    return res.status(200).json({
      success: true,
      message: "Wallet connection tracked successfully",
      walletId: data.id,
    });
  } catch (err) {
    console.error("Wallet connect error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

export default walletRouter;

