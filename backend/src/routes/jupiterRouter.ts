import express from "express";
import dotenv from "dotenv";
dotenv.config();

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
jupiterRouter.get("/order", async (req, res) => {
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
jupiterRouter.post("/execute", async (req, res) => {
  try {
    const { signedTransaction, requestId } = req.body;
    if (!signedTransaction || !requestId) {
      return res
        .status(400)
        .json({ error: "signedTransaction and requestId required" });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const r = await fetch(`${BASE_URL}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedTransaction, requestId }),
    });

    const json = await r.json();
    return res.json(json);
  } catch (err) {
    console.error("execute error", err);
    return res
      .status(500)
      .json({ error: "internal error", details: String(err) });
  }
});

export default jupiterRouter;