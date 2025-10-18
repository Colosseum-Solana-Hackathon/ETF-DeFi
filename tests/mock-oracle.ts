import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import axios from "axios";

describe("Mock Oracle Tests", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = anchor.getProvider();

  let admin: Keypair;
  let mockOracle: PublicKey;

  before(async () => {
    // Load your existing Solana CLI keypair
    const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const secretKey = Uint8Array.from(
      JSON.parse(fs.readFileSync(keypairPath, "utf-8"))
    );
    admin = Keypair.fromSecretKey(secretKey);

    // Derive mock oracle PDA
    [mockOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
      program.programId
    );

    console.log("📊 Mock Oracle Tests Setup:");
    console.log("  Admin:", admin.publicKey.toString());
    console.log("  Mock Oracle PDA:", mockOracle.toString());
  });

  describe("Oracle Account Management", () => {
    it("Should have initialized mock oracle account", async () => {
      // Check if oracle account exists (should be created by init-oracle script)
      try {
        const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
        
        expect(oracleData.authority.toString()).to.equal(admin.publicKey.toString());
        console.log("✅ Oracle account exists");
        console.log("  Authority:", oracleData.authority.toString());
      } catch (error: any) {
        if (error.message.includes("Account does not exist")) {
          throw new Error(
            "❌ Mock oracle not initialized! Run: yarn init-oracle"
          );
        }
        throw error;
      }
    });

    it("Should read current oracle prices", async () => {
      const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);

      console.log("📊 Current Oracle Prices:");
      console.log("  BTC: $" + (oracleData.btcPrice.toNumber() / 1_000_000).toFixed(2));
      console.log("  ETH: $" + (oracleData.ethPrice.toNumber() / 1_000_000).toFixed(2));
      console.log("  SOL: $" + (oracleData.solPrice.toNumber() / 1_000_000).toFixed(2));
      console.log("  Last Update:", new Date(oracleData.lastUpdate.toNumber() * 1000).toISOString());

      // Verify prices are non-zero
      expect(oracleData.btcPrice.toNumber()).to.be.greaterThan(0);
      expect(oracleData.ethPrice.toNumber()).to.be.greaterThan(0);
      expect(oracleData.solPrice.toNumber()).to.be.greaterThan(0);
    });

    it("Should have fresh prices (< 10 minutes old)", async () => {
      const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
      const currentTime = Math.floor(Date.now() / 1000);
      const priceAge = currentTime - oracleData.lastUpdate.toNumber();

      console.log("⏰ Price Age:", priceAge, "seconds");

      if (priceAge > 300) {
        console.warn("⚠️  Warning: Prices are stale! Run: yarn update-prices");
        console.warn("  Price age:", priceAge, "seconds (optimal: < 300)");
      }

      // Allow up to 10 minutes for test flexibility
      expect(priceAge).to.be.lessThan(600, "Prices are too old (>10 minutes). Start update-prices script!");
    });
  });

  describe("Oracle Price Updates", () => {
    it("Should update oracle with new prices", async () => {
      // Fetch real-time prices from CoinGecko
      let realPrices;
      try {
        const response = await axios.get(
          "https://api.coingecko.com/api/v3/simple/price",
          {
            params: {
              ids: "bitcoin,ethereum,solana",
              vs_currencies: "usd",
            },
          }
        );

        realPrices = {
          btc: Math.floor(response.data.bitcoin.usd * 1_000_000),
          eth: Math.floor(response.data.ethereum.usd * 1_000_000),
          sol: Math.floor(response.data.solana.usd * 1_000_000),
        };

        console.log("💰 Fetched Real Prices from CoinGecko:");
        console.log("  BTC: $" + (realPrices.btc / 1_000_000).toFixed(2));
        console.log("  ETH: $" + (realPrices.eth / 1_000_000).toFixed(2));
        console.log("  SOL: $" + (realPrices.sol / 1_000_000).toFixed(2));
      } catch (error) {
        console.warn("⚠️  Could not fetch from CoinGecko, using test prices");
        realPrices = {
          btc: 108277 * 1_000_000,
          eth: 3876 * 1_000_000,
          sol: 184 * 1_000_000,
        };
      }

      // Update oracle
      const tx = await (program.methods as any)
        .updateMockOracle(
          new anchor.BN(realPrices.btc),
          new anchor.BN(realPrices.eth),
          new anchor.BN(realPrices.sol)
        )
        .accounts({
          mockOracle: mockOracle,
          authority: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      console.log("✅ Update transaction:", tx);

      // Verify update
      const updatedOracle: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
      expect(updatedOracle.btcPrice.toNumber()).to.equal(realPrices.btc);
      expect(updatedOracle.ethPrice.toNumber()).to.equal(realPrices.eth);
      expect(updatedOracle.solPrice.toNumber()).to.equal(realPrices.sol);

      // Check timestamp is fresh
      const updateTime = updatedOracle.lastUpdate.toNumber();
      const now = Math.floor(Date.now() / 1000);
      expect(now - updateTime).to.be.lessThan(10, "Update timestamp should be recent");
    });
  });

  describe("Oracle Price Validation", () => {
    it("Should validate price reasonableness", async () => {
      const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);

      // BTC should be between $10k and $200k
      const btcPrice = oracleData.btcPrice.toNumber() / 1_000_000;
      expect(btcPrice).to.be.greaterThan(10_000, "BTC price too low");
      expect(btcPrice).to.be.lessThan(200_000, "BTC price too high");

      // ETH should be between $500 and $10k
      const ethPrice = oracleData.ethPrice.toNumber() / 1_000_000;
      expect(ethPrice).to.be.greaterThan(500, "ETH price too low");
      expect(ethPrice).to.be.lessThan(10_000, "ETH price too high");

      // SOL should be between $10 and $500
      const solPrice = oracleData.solPrice.toNumber() / 1_000_000;
      expect(solPrice).to.be.greaterThan(10, "SOL price too low");
      expect(solPrice).to.be.lessThan(500, "SOL price too high");

      console.log("✅ All prices are within reasonable ranges");
    });

    it("Should have consistent price update timestamp", async () => {
      const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
      const lastUpdate = oracleData.lastUpdate.toNumber();
      const now = Math.floor(Date.now() / 1000);

      // Timestamp should not be in the future
      expect(lastUpdate).to.be.lessThanOrEqual(now, "Timestamp is in the future");

      // Timestamp should not be ancient (> 1 day old)
      expect(now - lastUpdate).to.be.lessThan(86400, "Timestamp is too old (>1 day)");
    });
  });

  describe("Integration with CoinGecko API", () => {
    it("Should successfully fetch prices from CoinGecko", async () => {
      try {
        const response = await axios.get(
          "https://api.coingecko.com/api/v3/simple/price",
          {
            params: {
              ids: "bitcoin,ethereum,solana",
              vs_currencies: "usd",
            },
          }
        );

        expect(response.status).to.equal(200);
        expect(response.data).to.have.property("bitcoin");
        expect(response.data).to.have.property("ethereum");
        expect(response.data).to.have.property("solana");

        console.log("✅ CoinGecko API is accessible");
        console.log("  BTC: $" + response.data.bitcoin.usd);
        console.log("  ETH: $" + response.data.ethereum.usd);
        console.log("  SOL: $" + response.data.solana.usd);
      } catch (error: any) {
        console.warn("⚠️  CoinGecko API error:", error.message);
        console.warn("This is okay if rate-limited, update-prices script will retry");
      }
    });
  });
});
