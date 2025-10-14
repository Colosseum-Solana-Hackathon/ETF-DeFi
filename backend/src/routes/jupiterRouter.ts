import express, { Request, Response } from "express";
import dotenv from "dotenv";
dotenv.config();


type JupToken = {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  isVerified?: boolean;
  usdPrice?: number;
};

type Token = {
  symbol: string;
  name: string;
  address: string;
  icon?: string;
  network: "Solana";
  archived: boolean;
  badge?: string;
  decimals: number;
  priceUsd?: number;
};


const jupiterRouter = express.Router();
jupiterRouter.use(express.json());

const BASE_URL = "https://lite-api.jup.ag/ultra/v1";

/**
 * Handles GET /api/jupiter/order
 *
 * @function
 * @name GET /api/jupiter/order
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Responds with the Jupiter order route result or error
 * @description
 * Query params:
 *   - inputMint: string (required)
 *   - outputMint: string (required)
 *   - amount: string or number (required)
 *   - taker: string (optional)
 *   - slippageBps: string or number (optional)
 *   - referralAccount: string (optional)
 *   - referralFee: string or number (optional)
 */
jupiterRouter.get("/order", async (req: Request, res: Response) => {
  try {
    const {
      inputMint,
      outputMint,
      amount,
      taker,
      slippageBps,
      referralAccount,
      referralFee,
    } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res
        .status(400)
        .json({ error: "inputMint, outputMint and amount are required" });
    }

    const url = new URL(`${BASE_URL}/order`);
    url.searchParams.set("inputMint", String(inputMint));
    url.searchParams.set("outputMint", String(outputMint));
    url.searchParams.set("amount", String(amount));
    if (taker) url.searchParams.set("taker", String(taker));
    if (slippageBps) url.searchParams.set("slippageBps", String(slippageBps));
    if (referralAccount)
      url.searchParams.set("referralAccount", String(referralAccount));
    if (referralFee) url.searchParams.set("referralFee", String(referralFee));

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const r = await fetch(url.toString(), { headers });
    const json = await r.json();
    return res.json(json);
  } catch (err) {
    console.error("order error", err);
    return res
      .status(500)
      .json({ error: "internal error", details: String(err) });
  }
});

/**
 * Handles POST /api/jupiter/execute
 *
 * @function
 * @name POST /api/jupiter/execute
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Responds with the Jupiter execute route result or error
 * @description
 * Body:
 *   - signedTransaction: string (base64, required)
 *   - requestId: string (required)
 * Forwards the request to Jupiter /execute endpoint (backend calls with API key).
 */
jupiterRouter.post("/execute", async (req: Request, res: Response) => {
  try {
    const { signedTransaction, requestId } = req.body;
   console.log(`[POST /execute] Received request - requestId: ${requestId}, signedTransaction: ${signedTransaction ? signedTransaction.substring(0, 50) + '...' : 'missing'}`);
    if (!signedTransaction || !requestId) {
      console.warn("[POST /execute] Validation failed: Missing signedTransaction or requestId");
      return res
        .status(400)
        .json({ error: "signedTransaction and requestId required" });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
console.log(`[POST /execute] Sending to Jupiter API: ${BASE_URL}/execute, payload:`, JSON.stringify({ requestId, signedTransaction: signedTransaction }, null, 2));
    const r = await fetch(`${BASE_URL}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedTransaction, requestId }),
    });

    const json = await r.json();
    console.log(`[POST /execute] Jupiter API response - status: ${r.status}, body:`, JSON.stringify(json, null, 2));
    
    return res.json(json);
    
  } catch (err) {
console.error("[POST /execute] Error:", err);
    return res
      .status(500)
      .json({ error: "internal error", details: String(err) });
  }
});
/**
 * GET /api/jupiter/tokens
 * Supports pagination
 * Query params:
 *   - page: number (default: 1)
 *   - limit: number (default: 20)
 */
jupiterRouter.get("/tokens", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const JUP_ALL_TOKENS = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
    const r = await fetch(JUP_ALL_TOKENS);
    if (!r.ok) {
      return res.status(500).json({ error: "Failed to fetch tokens from Jupiter" });
    }
    const response = await r.json();
    if (!Array.isArray(response)) {
      return res.status(500).json({ error: "Unexpected tokens format from Jupiter API" });
    }
    const data: JupToken[] = response;
    
    const mapped: Token[] = data.map((t) => ({
      symbol: t.symbol,
      name: t.name,
      address: t.id,
      icon: t.icon,
      network: "Solana",
      archived: false,
      badge: t.isVerified ? "Verified" : undefined,
      decimals: t.decimals,
      priceUsd: t.usdPrice,
    }));

    const start = (page - 1) * limit;
    const end = start + limit;

    const paginated = mapped.slice(start, end);

    return res.json({
      page,
      limit,
      total: mapped.length,
      tokens: paginated,
    });
  } catch (err) {
    console.error("/tokens error:", err);
    return res.status(500).json({ error: "Internal error", details: String(err) });
  }
});


const JUP_TOKENS_URL = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
const TOKENS_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
let TOKENS_CACHE: { at: number; tokens: Token[] } | null = null;

async function loadAllTokens(): Promise<Token[]> {
  const now = Date.now();
  if (TOKENS_CACHE && now - TOKENS_CACHE.at < TOKENS_CACHE_TTL_MS) {
    return TOKENS_CACHE.tokens;
  }

  const r = await fetch(JUP_TOKENS_URL, { headers: { "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(`Jupiter token fetch failed: HTTP ${r.status}`);

  const rawUnknown = await r.json();
  if (!Array.isArray(rawUnknown)) {
    throw new Error("Unexpected token list shape from Jupiter");
  }

  // Light validation of a few fields
  const raw = rawUnknown as Array<Partial<JupToken>>;
  for (const t of raw) {
    if (typeof t?.id !== "string" || typeof t?.symbol !== "string" || typeof t?.name !== "string") {
      throw new Error("Invalid token item from Jupiter");
    }
  }

  const mapped: Token[] = (raw as JupToken[]).map((t) => ({
    symbol: t.symbol,
    name: t.name,
    address: t.id,
    icon: t.icon,
    network: "Solana",
    archived: false,
    badge: t.isVerified ? "Verified" : undefined,
    decimals: t.decimals,
    priceUsd: t.usdPrice,
  }));

  TOKENS_CACHE = { at: now, tokens: mapped };
  return mapped;
}

/**
 * GET /api/jupiter/tokens/basic
 * Optional query:
 *   - symbols: comma-separated symbols to include (default: "SOL,USDT")
 * Example:
 *   /api/jupiter/tokens/basic
 *   /api/jupiter/tokens/basic?symbols=SOL,USDC
 *
 * Response:
 * {
 *   "data": [Token, ...],
 *   "meta": { "count": number, "symbols": string[] }
 * }
 */
jupiterRouter.get("/tokens/basic", async (req: Request, res: Response) => {
  try {
    const symbolsParam = (req.query.symbols as string | undefined) ?? "SOL,USDT";
    const wantSymbols = symbolsParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const all = await loadAllTokens();
    const bySymbol = new Map(all.map((t) => [t.symbol.toUpperCase(), t]));
    const selected: Token[] = [];

    for (const sym of wantSymbols) {
      const token = bySymbol.get(sym);
      if (token) selected.push(token);
    }

    if (selected.length === 0) {
      return res.status(502).json({ error: "No requested tokens found from Jupiter" });
    }

    return res.json({
      data: selected,                // e.g. [SOL, USDT]
      meta: { count: selected.length, symbols: wantSymbols },
    });
  } catch (err: any) {
    console.error("basic tokens error", err);
    return res.status(500).json({ error: "internal error", details: String(err?.message ?? err) });
  }
});
/**
 * GET /api/jupiter/tokens/search
 * Supports searching tokens by name or address with pagination
 * Query params:
 *   - q: string (search query, required)
 *   - page: number (default: 1)
 *   - limit: number (default: 20)
 */
jupiterRouter.get("/tokens/search", async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!q) {
      return res.status(400).json({ error: "Search query (q) is required" });
    }

    const allTokens = await loadAllTokens();
    const queryLower = q.toLowerCase();

    // Prioritize name matches, then address
    const filtered = allTokens.filter(
      (t) =>
        t.name.toLowerCase().includes(queryLower) ||
        t.address.toLowerCase().includes(queryLower)
    );

    // Sort by name matches first
    filtered.sort((a, b) => {
      const aNameMatch = a.name.toLowerCase().includes(queryLower) ? 0 : 1;
      const bNameMatch = b.name.toLowerCase().includes(queryLower) ? 0 : 1;
      return aNameMatch - bNameMatch;
    });

    const start = (page - 1) * limit;
    const end = start + limit;
    const paginated = filtered.slice(start, end);

    return res.json({
      page,
      limit,
      total: filtered.length,
      tokens: paginated,
    });
  } catch (err) {
    console.error("/tokens/search error:", err);
    return res.status(500).json({ error: "Internal error", details: String(err) });
  }
});

export default jupiterRouter;