import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import axios from "axios";

/**
 * High-Frequency Price Updater for Ephemeral Rollup
 * 
 * This script updates MockOracle prices on MagicBlock's Ephemeral Rollup
 * at sub-second intervals (100-500ms) with ZERO transaction fees.
 * 
 * Features:
 * - Fetches BTC, ETH, SOL prices from CoinGecko
 * - Updates every 500ms on ER (vs 30s on L1)
 * - FREE updates (no transaction fees while on ER)
 * - Auto-commits to L1 every 30 seconds (configured in delegate)
 * - Real-time monitoring and statistics
 * 
 * Prerequisites:
 *   1. Run: yarn delegate-oracle (to delegate oracle to ER)
 *   2. Then run this script: yarn update-prices-er
 * 
 * Usage:
 *   yarn update-prices-er
 *   Press Ctrl+C to stop
 */

const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";
const ER_ENDPOINT = "https://devnet.magicblock.app/";
const UPDATE_INTERVAL = 500; // 500ms = 2 updates per second (vs 30s on L1!)
const MICRO_DOLLARS = 1_000_000; // 6 decimals

interface PriceData {
  btc: number;
  eth: number;
  sol: number;
}

interface UpdateStats {
  totalUpdates: number;
  successfulUpdates: number;
  failedUpdates: number;
  startTime: number;
  lastUpdateTime: number;
  priceChanges: {
    btc: { min: number; max: number; current: number };
    eth: { min: number; max: number; current: number };
    sol: { min: number; max: number; current: number };
  };
}

async function fetchRealTimePrices(): Promise<PriceData | null> {
  try {
    const response = await axios.get(COINGECKO_API, {
      params: {
        ids: "bitcoin,ethereum,solana",
        vs_currencies: "usd",
      },
      timeout: 5000,
    });

    const data = response.data;

    if (!data.bitcoin?.usd || !data.ethereum?.usd || !data.solana?.usd) {
      console.error("❌ Invalid price data received from CoinGecko");
      return null;
    }

    return {
      btc: data.bitcoin.usd,
      eth: data.ethereum.usd,
      sol: data.solana.usd,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        // Rate limit - use cached prices or slow down
        return null;
      }
    }
    return null;
  }
}

function convertTomicroUsd(price: number): anchor.BN {
  return new anchor.BN(Math.floor(price * MICRO_DOLLARS));
}

async function updateOracleOnER(
  program: Program<Vault>,
  mockOracle: PublicKey,
  authority: Keypair,
  prices: PriceData
): Promise<boolean> {
  try {
    const btcPrice = convertTomicroUsd(prices.btc);
    const ethPrice = convertTomicroUsd(prices.eth);
    const solPrice = convertTomicroUsd(prices.sol);

    await (program.methods as any)
      .updateMockOracle(btcPrice, ethPrice, solPrice)
      .accounts({
        mockOracle: mockOracle,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc({ skipPreflight: true, commitment: "processed" });

    return true;
  } catch (error) {
    return false;
  }
}

function updatePriceStats(stats: UpdateStats, prices: PriceData) {
  // Update BTC stats
  stats.priceChanges.btc.current = prices.btc;
  stats.priceChanges.btc.min = Math.min(stats.priceChanges.btc.min, prices.btc);
  stats.priceChanges.btc.max = Math.max(stats.priceChanges.btc.max, prices.btc);

  // Update ETH stats
  stats.priceChanges.eth.current = prices.eth;
  stats.priceChanges.eth.min = Math.min(stats.priceChanges.eth.min, prices.eth);
  stats.priceChanges.eth.max = Math.max(stats.priceChanges.eth.max, prices.eth);

  // Update SOL stats
  stats.priceChanges.sol.current = prices.sol;
  stats.priceChanges.sol.min = Math.min(stats.priceChanges.sol.min, prices.sol);
  stats.priceChanges.sol.max = Math.max(stats.priceChanges.sol.max, prices.sol);
}

function formatCurrency(value: number): string {
  return "$" + value.toLocaleString(undefined, { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

async function main() {
  console.log("\n" + "=".repeat(100));
  console.log("⚡ HIGH-FREQUENCY PRICE UPDATER FOR EPHEMERAL ROLLUP");
  console.log("=".repeat(100) + "\n");

  // Setup ER connection and program
  const erConnection = new Connection(ER_ENDPOINT, "processed");
  
  // Load admin keypair
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(keypairPath)) {
    console.error("❌ Admin keypair not found at:", keypairPath);
    console.error("   Please run: solana-keygen new");
    process.exit(1);
  }

  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const admin = Keypair.fromSecretKey(secretKey);

  const erProvider = new anchor.AnchorProvider(
    erConnection,
    new anchor.Wallet(admin),
    { commitment: "processed", skipPreflight: true }
  );
  anchor.setProvider(erProvider);
  const program = anchor.workspace.Vault as Program<Vault>;

  // Derive mock oracle PDA
  const [mockOracle] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
    program.programId
  );

  console.log("📊 Configuration:");
  console.log("  Program ID:", program.programId.toString());
  console.log("  Admin:", admin.publicKey.toString());
  console.log("  Mock Oracle:", mockOracle.toString());
  console.log("  ER Endpoint:", ER_ENDPOINT);
  console.log("  Update Interval:", UPDATE_INTERVAL + "ms", "(2 updates/second!)");
  console.log("  Cost per Update: FREE ⚡ (on ER)");

  // Verify oracle is delegated to ER
  try {
    const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
    console.log("\n✅ Oracle found on ER:");
    console.log("  Current BTC: " + formatCurrency(oracleData.btcPrice.toNumber() / 1_000_000));
    console.log("  Current ETH: " + formatCurrency(oracleData.ethPrice.toNumber() / 1_000_000));
    console.log("  Current SOL: " + formatCurrency(oracleData.solPrice.toNumber() / 1_000_000));

    if (!oracleData.authority.equals(admin.publicKey)) {
      console.error("\n❌ Authority mismatch! You don't have permission to update this oracle.");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Oracle not found on ER:", mockOracle.toString());
    console.error("   Make sure oracle is delegated first: yarn delegate-oracle");
    process.exit(1);
  }

  // Fetch initial prices
  console.log("\n⚡ Fetching initial prices from CoinGecko...");
  const initialPrices = await fetchRealTimePrices();
  
  if (!initialPrices) {
    console.error("❌ Failed to fetch initial prices");
    process.exit(1);
  }

  // Initialize stats
  const stats: UpdateStats = {
    totalUpdates: 0,
    successfulUpdates: 0,
    failedUpdates: 0,
    startTime: Date.now(),
    lastUpdateTime: Date.now(),
    priceChanges: {
      btc: { min: initialPrices.btc, max: initialPrices.btc, current: initialPrices.btc },
      eth: { min: initialPrices.eth, max: initialPrices.eth, current: initialPrices.eth },
      sol: { min: initialPrices.sol, max: initialPrices.sol, current: initialPrices.sol },
    },
  };

  console.log("\n" + "=".repeat(100));
  console.log("🚀 STARTING HIGH-FREQUENCY UPDATES");
  console.log("=".repeat(100));
  console.log("\n💡 Updates running at 500ms intervals (2x per second)");
  console.log("💰 All updates are FREE while on Ephemeral Rollup");
  console.log("🔄 State auto-commits to L1 every 30 seconds");
  console.log("⌨️  Press Ctrl+C to stop and view statistics\n");
  console.log("─".repeat(100));

  let cachedPrices: PriceData = initialPrices;
  let lastFetch = Date.now();
  const FETCH_INTERVAL = 5000; // Fetch from CoinGecko every 5 seconds to avoid rate limits

  // Main update loop
  const updateLoop = setInterval(async () => {
    try {
      const now = Date.now();
      stats.totalUpdates++;

      // Fetch new prices every 5 seconds
      if (now - lastFetch >= FETCH_INTERVAL) {
        const newPrices = await fetchRealTimePrices();
        if (newPrices) {
          cachedPrices = newPrices;
          lastFetch = now;
        }
      }

      // Update oracle on ER with current prices
      const success = await updateOracleOnER(program, mockOracle, admin, cachedPrices);

      if (success) {
        stats.successfulUpdates++;
        stats.lastUpdateTime = now;
        updatePriceStats(stats, cachedPrices);

        // Display update info (every 10th update to avoid spam)
        if (stats.successfulUpdates % 10 === 0) {
          const uptime = formatDuration(now - stats.startTime);
          const successRate = ((stats.successfulUpdates / stats.totalUpdates) * 100).toFixed(1);
          const updatesPerSec = (stats.successfulUpdates / ((now - stats.startTime) / 1000)).toFixed(2);

          console.log(`[${new Date().toLocaleTimeString()}] Update #${stats.successfulUpdates}`);
          console.log(`  📈 BTC: ${formatCurrency(cachedPrices.btc)} | ETH: ${formatCurrency(cachedPrices.eth)} | SOL: ${formatCurrency(cachedPrices.sol)}`);
          console.log(`  ⚡ Updates/sec: ${updatesPerSec} | Success: ${successRate}% | Uptime: ${uptime}`);
          console.log("─".repeat(100));
        }
      } else {
        stats.failedUpdates++;
      }
    } catch (error) {
      stats.failedUpdates++;
    }
  }, UPDATE_INTERVAL);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\n🛑 Stopping high-frequency updater...");
    clearInterval(updateLoop);

    const totalTime = Date.now() - stats.startTime;
    const avgUpdateTime = stats.successfulUpdates > 0 ? totalTime / stats.successfulUpdates : 0;
    const successRate = stats.totalUpdates > 0 ? (stats.successfulUpdates / stats.totalUpdates) * 100 : 0;

    console.log("\n" + "=".repeat(100));
    console.log("📊 FINAL STATISTICS");
    console.log("=".repeat(100));
    console.log("\n⏱️  Session Duration:", formatDuration(totalTime));
    console.log("\n📈 Update Performance:");
    console.log("  Total Updates Attempted:", stats.totalUpdates);
    console.log("  Successful Updates:", stats.successfulUpdates);
    console.log("  Failed Updates:", stats.failedUpdates);
    console.log("  Success Rate:", successRate.toFixed(1) + "%");
    console.log("  Average Update Interval:", avgUpdateTime.toFixed(0) + "ms");
    console.log("  Updates per Second:", (stats.successfulUpdates / (totalTime / 1000)).toFixed(2));

    console.log("\n💰 Cost Analysis:");
    console.log("  Transaction Fees on ER: FREE ⚡");
    console.log("  Estimated L1 Cost (if not using ER): ~" + (stats.successfulUpdates * 0.000005).toFixed(6) + " SOL");
    console.log("  Estimated Savings: ~$" + (stats.successfulUpdates * 0.000005 * 185).toFixed(2) + " USD (at $185/SOL)");

    console.log("\n📊 Price Range During Session:");
    console.log("  BTC: " + formatCurrency(stats.priceChanges.btc.min) + " - " + formatCurrency(stats.priceChanges.btc.max));
    console.log("  ETH: " + formatCurrency(stats.priceChanges.eth.min) + " - " + formatCurrency(stats.priceChanges.eth.max));
    console.log("  SOL: " + formatCurrency(stats.priceChanges.sol.min) + " - " + formatCurrency(stats.priceChanges.sol.max));

    console.log("\n✅ Final Prices on ER:");
    console.log("  BTC: " + formatCurrency(stats.priceChanges.btc.current));
    console.log("  ETH: " + formatCurrency(stats.priceChanges.eth.current));
    console.log("  SOL: " + formatCurrency(stats.priceChanges.sol.current));

    console.log("\n💡 Next Steps:");
    console.log("  • Oracle state will auto-commit to L1 (configured at 30s intervals)");
    console.log("  • To manually undelegate and commit: yarn undelegate-oracle");
    console.log("  • To resume updates: yarn update-prices-er");

    console.log("\n" + "=".repeat(100) + "\n");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});
