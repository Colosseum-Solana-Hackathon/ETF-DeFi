import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import axios from "axios";

/**
 * Real-time Price Updater for Mock Oracle
 * Fetches BTC, ETH, SOL prices from CoinGecko and updates the mock oracle
 * We have to add a cron job to update the prices at every X mins/seconds
 * For the time-being, can run this script manually when running integration tests
 * Later, can be run as a background process during testing
 */

const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";
const UPDATE_INTERVAL = 30000; // 30 seconds
const MICRO_DOLLARS = 1_000_000; // 6 decimals

interface PriceData {
  btc: number;
  eth: number;
  sol: number;
}

async function fetchRealTimePrices(): Promise<PriceData | null> {
  try {
    const response = await axios.get(COINGECKO_API, {
      params: {
        ids: "bitcoin,ethereum,solana",
        vs_currencies: "usd",
      },
      timeout: 10000,
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
      console.error("❌ Failed to fetch prices from CoinGecko:", error.message);
      if (error.response?.status === 429) {
        console.warn("⚠️  Rate limit exceeded, will retry...");
      }
    } else {
      console.error("❌ Unexpected error:", error);
    }
    return null;
  }
}

function convertTomicroUsd(price: number): anchor.BN {
  // Convert USD to micro-USD (6 decimals)
  return new anchor.BN(Math.floor(price * MICRO_DOLLARS));
}

async function updateMockOracle(
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
      .rpc();

    return true;
  } catch (error) {
    console.error("❌ Failed to update oracle on-chain:", error);
    return false;
  }
}

async function main() {
  console.log("🚀 Starting Real-Time Price Updater for Mock Oracle\n");

  // Setup Anchor
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Vault as Program<Vault>;

  // Load admin keypair
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(keypairPath)) {
    console.error("❌ Admin keypair not found at:", keypairPath);
    console.error("   Please run: solana-keygen new");
    process.exit(1);
  }

  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const admin = Keypair.fromSecretKey(secretKey);

  // Derive mock oracle PDA
  const [mockOracle] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
    program.programId
  );

  console.log("📊 Configuration:");
  console.log("  Program ID:", program.programId.toString());
  console.log("  Admin:", admin.publicKey.toString());
  console.log("  Mock Oracle:", mockOracle.toString());
  console.log("  Update Interval:", UPDATE_INTERVAL / 1000, "seconds\n");

  // Verify oracle exists
  try {
    const oracleAccount: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
    console.log("✅ Mock Oracle found");
    console.log("  Authority:", oracleAccount.authority.toString());
    if (!oracleAccount.authority.equals(admin.publicKey)) {
      console.error("❌ Authority mismatch! You don't have permission to update this oracle.");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Mock Oracle not found at:", mockOracle.toString());
    console.error("   Please run: anchor run initialize-mock-oracle");
    process.exit(1);
  }

  console.log("\n🔄 Starting price update loop...\n");
  console.log("Press Ctrl+C to stop\n");
  console.log("═".repeat(80));

  let updateCount = 0;
  let errorCount = 0;

  // Main update loop
  const updateLoop = setInterval(async () => {
    try {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`\n[${timestamp}] Update #${++updateCount}`);

      // Fetch real-time prices
      console.log("📡 Fetching prices from CoinGecko...");
      const prices = await fetchRealTimePrices();

      if (!prices) {
        errorCount++;
        console.warn(`⚠️  Failed to fetch prices (${errorCount} errors)`);
        return;
      }

      console.log("✅ Prices fetched:");
      console.log(`  BTC: $${prices.btc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      console.log(`  ETH: $${prices.eth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      console.log(`  SOL: $${prices.sol.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

      // Update on-chain oracle
      console.log("📤 Updating on-chain oracle...");
      const success = await updateMockOracle(program, mockOracle, admin, prices);

      if (success) {
        console.log("✅ Oracle updated successfully!");
        errorCount = 0; // Reset error count on success
      } else {
        errorCount++;
        console.warn(`⚠️  Oracle update failed (${errorCount} errors)`);
      }

      console.log("─".repeat(80));
    } catch (error) {
      errorCount++;
      console.error("❌ Unexpected error in update loop:", error);
    }
  }, UPDATE_INTERVAL);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\n🛑 Stopping price updater...");
    clearInterval(updateLoop);
    console.log("✅ Stopped gracefully");
    console.log(`\n📊 Final Stats:`);
    console.log(`  Total Updates: ${updateCount}`);
    console.log(`  Errors: ${errorCount}`);
    console.log(`  Success Rate: ${((updateCount - errorCount) / updateCount * 100).toFixed(1)}%\n`);
    process.exit(0);
  });

  // Perform initial update immediately
  console.log("⚡ Performing initial update...");
  const initialPrices = await fetchRealTimePrices();
  if (initialPrices) {
    console.log("✅ Initial prices fetched:");
    console.log(`  BTC: $${initialPrices.btc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`  ETH: $${initialPrices.eth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`  SOL: $${initialPrices.sol.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    
    const success = await updateMockOracle(program, mockOracle, admin, initialPrices);
    if (success) {
      console.log("✅ Initial oracle update successful!");
    }
  }
  console.log("═".repeat(80));
}

main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});
