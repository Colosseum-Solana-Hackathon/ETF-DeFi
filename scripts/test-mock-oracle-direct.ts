import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Simple Mock Oracle Test - Direct on Devnet
 * 
 * This script:
 * 1. Connects to devnet
 * 2. Initializes mock oracle (if not exists)
 * 3. Fetches real-time prices from CoinGecko
 * 4. Updates the on-chain oracle
 * 5. Reads back and verifies
 */
const PROGRAM_ID = new PublicKey("BZAQS5pJ1nWKqmGmv76EJmNPEZWMV4BDebMarGcUSKGd");
const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";

async function fetchPrices() {
  try {
    const response = await fetch(COINGECKO_API + "?ids=bitcoin,ethereum,solana&vs_currencies=usd");
    const data: any = await response.json();
    return {
      btc: Math.floor(data.bitcoin.usd * 1_000_000),
      eth: Math.floor(data.ethereum.usd * 1_000_000),
      sol: Math.floor(data.solana.usd * 1_000_000),
    };
  } catch (error) {
    console.error("Error fetching prices:", error);
    return null;
  }
}

async function main() {
  console.log("\n" + "=".repeat(80));
  console.log("🚀 DIRECT MOCK ORACLE TEST ON DEVNET");
  console.log("=".repeat(80) + "\n");

  // Setup connection
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  
  // Load wallet
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(keypairPath)) {
    console.error("❌ Wallet not found at:", keypairPath);
    process.exit(1);
  }

  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const wallet = Keypair.fromSecretKey(secretKey);
  
  console.log("📊 Configuration:");
  console.log("  Program ID:", PROGRAM_ID.toString());
  console.log("  Wallet:", wallet.publicKey.toString());
  console.log("  Network: Devnet");

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("  Balance:", (balance / 1e9).toFixed(4), "SOL");

  if (balance < 0.5 * 1e9) {
    console.warn("\n⚠️  Low balance! You may need more SOL.");
  }

  // Derive mock oracle PDA
  const [mockOracle, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );

  console.log("\n📍 Mock Oracle PDA:");
  console.log("  Address:", mockOracle.toString());
  console.log("  Bump:", bump);

  // Load IDL
  const idlPath = path.join(__dirname, "..", "target", "idl", "vault.json");
  if (!fs.existsSync(idlPath)) {
    console.error("\n❌ IDL not found. Run: anchor build");
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  
  // Create provider and program
  const provider = new AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);

  console.log("\n✅ Program loaded successfully");

  // Check if oracle exists
  try {
    const oracleData = await connection.getAccountInfo(mockOracle);
    
    if (oracleData) {
      console.log("\n✅ Mock oracle already exists!");
      console.log("  Owner:", oracleData.owner.toString());
      console.log("  Size:", oracleData.data.length, "bytes");
      
      // Try to decode the account data
      try {
        const oracle: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
        console.log("\n📋 Current Oracle State:");
        console.log("  Authority:", oracle.authority.toString());
        console.log("  BTC Price: $" + (oracle.btcPrice.toNumber() / 1_000_000).toFixed(2));
        console.log("  ETH Price: $" + (oracle.ethPrice.toNumber() / 1_000_000).toFixed(2));
        console.log("  SOL Price: $" + (oracle.solPrice.toNumber() / 1_000_000).toFixed(2));
        console.log("  Last Update:", new Date(oracle.lastUpdate.toNumber() * 1000).toISOString());
      } catch (e) {
        console.log("  (Could not decode oracle data - IDL may be outdated)");
      }
    } else {
      console.log("\n❌ Mock oracle not found. Need to initialize...");
      
      console.log("\n🔨 Initializing mock oracle...");
      
      try {
        // Create transaction manually since we might not have updated IDL
        const tx = await program.methods
          .initializeMockOracle()
          .accounts({
            authority: wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wallet])
          .rpc();

        console.log("✅ Initialization successful!");
        console.log("  Transaction:", tx);
        
        // Wait for confirmation
        await connection.confirmTransaction(tx);
        
        console.log("\n✅ Oracle created at:", mockOracle.toString());
      } catch (error: any) {
        console.error("\n❌ Initialization failed:", error.message || error);
        console.log("\n💡 This might be because:");
        console.log("  1. IDL is not up to date (run: anchor build)");
        console.log("  2. Program is not deployed (run: anchor deploy --provider.cluster devnet)");
        console.log("  3. Account already exists (check explorer)");
        process.exit(1);
      }
    }
  } catch (error: any) {
    console.error("\n❌ Error:", error.message || error);
    process.exit(1);
  }

  // Fetch real-time prices
  console.log("\n📡 Fetching real-time prices from CoinGecko...");
  const prices = await fetchPrices();
  
  if (!prices) {
    console.error("❌ Failed to fetch prices");
    process.exit(1);
  }

  console.log("✅ Prices fetched:");
  console.log("  BTC: $" + (prices.btc / 1_000_000).toFixed(2), "→", prices.btc, "micro-USD");
  console.log("  ETH: $" + (prices.eth / 1_000_000).toFixed(2), "→", prices.eth, "micro-USD");
  console.log("  SOL: $" + (prices.sol / 1_000_000).toFixed(2), "→", prices.sol, "micro-USD");

  // Update oracle
  console.log("\n📤 Updating on-chain oracle with real-time prices...");
  
  try {
    const tx = await program.methods
      .updateMockOracle(
        new anchor.BN(prices.btc),
        new anchor.BN(prices.eth),
        new anchor.BN(prices.sol)
      )
      .accountsPartial({
        mockOracle: mockOracle,
        authority: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();

    console.log("✅ Update successful!");
    console.log("  Transaction:", tx);
    
    // Wait for confirmation
    await connection.confirmTransaction(tx);
    
    // Read back and verify
    console.log("\n🔍 Verifying update...");
    const oracle: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
    
    console.log("\n📊 Verified On-Chain Oracle State:");
    console.log("  BTC: $" + (oracle.btcPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  ETH: $" + (oracle.ethPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  SOL: $" + (oracle.solPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  Last Update:", new Date(oracle.lastUpdate.toNumber() * 1000).toISOString());
    
    const age = Math.floor(Date.now() / 1000) - oracle.lastUpdate.toNumber();
    console.log("  Age:", age, "seconds");
    
    if (age < 60) {
      console.log("  ✅ Prices are fresh!");
    }
    
    console.log("\n" + "=".repeat(80));
    console.log("✅ SUCCESS! Real-time prices are being fetched and stored on-chain!");
    console.log("=".repeat(80));
    console.log("\n🎉 Your mock oracle is working perfectly!");
    console.log("\n💡 Next steps:");
    console.log("  1. Run: yarn update-prices (for continuous updates)");
    console.log("  2. Run: yarn test:oracle (to test vault operations)");
    console.log("  3. Check on Solana Explorer:");
    console.log("     https://explorer.solana.com/address/" + mockOracle.toString() + "?cluster=devnet");
    
  } catch (error: any) {
    console.error("\n❌ Update failed:", error.message || error);
    console.log("\n💡 Possible causes:");
    console.log("  1. You're not the oracle authority");
    console.log("  2. Oracle is not initialized");
    console.log("  3. IDL is outdated (run: anchor build)");
    process.exit(1);
  }

  console.log("\n");
}

main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});
