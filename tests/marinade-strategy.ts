import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MarinadeStrategy } from "../target/types/marinade_strategy";
import { Vault } from "../target/types/vault";
import { 
  PublicKey, 
  Keypair, 
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount
} from "@solana/spl-token";
import { assert } from "chai";
import { getMarinadeAccounts, MARINADE_PROGRAM_ID, MSOL_MINT } from "./helpers/marinade-accounts";
import * as fs from "fs";
import * as path from "path";

describe("Marinade Strategy Tests", () => {
  // Configure the client to use devnet
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const marinadeProgram = anchor.workspace.MarinadeStrategy as Program<MarinadeStrategy>;
  const vaultProgram = anchor.workspace.Vault as Program<Vault>;
  
  // Test accounts
  let authority: Keypair;
  let vault: PublicKey;
  let vaultBump: number;
  let strategyAccount: PublicKey;
  let strategyBump: number;
  let msolAta: PublicKey;

  // Marinade state accounts
  let marinadeAccounts: Awaited<ReturnType<typeof getMarinadeAccounts>>;

  before(async () => {
    console.log("Running tests on:", provider.connection.rpcEndpoint);
    
    // Load or create authority keypair
    // Try to load persistent keypair first, fallback to generating new one
    const keypairPath = path.join(__dirname, "..", "test-keypair.json");
    let keypairData;
    
    try {
      if (fs.existsSync(keypairPath)) {
        keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
        authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log("📁 Loaded existing test keypair");
      } else {
        throw new Error("No persistent keypair found");
      }
    } catch (error) {
      console.log("🔄 No persistent keypair found, using your funded wallet");
      // Use your existing funded wallet instead of generating new one
      // This will use the default Solana CLI keypair
      const { execSync } = require('child_process');
      try {
        const configOutput = execSync('solana config get', { encoding: 'utf8' });
        const keypairLine = configOutput.split('\n').find(line => line.startsWith('Keypair Path:'));
        const keypairPath = keypairLine ? keypairLine.split(': ')[1].trim() : null;
        
        if (!keypairPath) {
          throw new Error('Could not find keypair path');
        }
        
        const keypairData = JSON.parse(fs.readFileSync(keypairPath));
        authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log("💰 Using your funded wallet:", authority.publicKey.toString());
      } catch (error) {
        console.log("🔄 Could not load default wallet, generating new one");
        authority = Keypair.generate();
        console.log("💡 To use a persistent keypair, run: node scripts/create-test-keypair.js");
      }
    }

    // Check if we should skip airdrop (set SKIP_AIRDROP=true to skip)
    // Also skip if we're using the default wallet (which should be funded)
    const skipAirdrop = process.env.SKIP_AIRDROP === 'true' || authority.publicKey.toString() === 'F98Hxpo6MJxpQDouu7Gmt9zBVdf7EinkWGuLLrb7YsYh'; //use your funded wallet here
    
    if (!skipAirdrop) {
      // Request devnet airdrop with retry logic
      console.log("Requesting airdrop for authority:", authority.publicKey.toString());
      let airdropSuccess = false;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`Airdrop attempt ${attempt}/${maxRetries}`);
          const airdropSig = await provider.connection.requestAirdrop(
            authority.publicKey,
            2 * LAMPORTS_PER_SOL // Reduced amount to avoid rate limits
          );
          await provider.connection.confirmTransaction(airdropSig, "confirmed");
          console.log("Airdrop confirmed");
          airdropSuccess = true;
          break;
        } catch (error) {
          console.error(`Airdrop attempt ${attempt} failed:`, error.message);
          if (attempt === maxRetries) {
            console.log("All airdrop attempts failed. Please manually fund the address:");
            console.log("Address:", authority.publicKey.toString());
            console.log("You can use: https://faucet.solana.com/ or https://solfaucet.com/");
            console.log("Or run: node scripts/get-devnet-sol.js");
            console.log("Then set SKIP_AIRDROP=true and run tests again");
            throw new Error("Airdrop failed after all retries. Please manually fund the account.");
          }
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    } else {
      console.log("Skipping airdrop - using pre-funded account");
      console.log("Authority address:", authority.publicKey.toString());
      console.log("Make sure this account has sufficient SOL!");
    }

    // Get Marinade accounts
    marinadeAccounts = await getMarinadeAccounts(provider.connection);

    // Derive PDAs
    [vault, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.publicKey.toBuffer()],
      vaultProgram.programId
    );

    [strategyAccount, strategyBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("marinade_strategy"), vault.toBuffer()],
      marinadeProgram.programId
    );

    // Derive mSOL ATA for strategy
    msolAta = await getAssociatedTokenAddress(
      MSOL_MINT,
      strategyAccount,
      true
    );

    console.log("Test Accounts Initialized:");
    console.log("Authority:", authority.publicKey.toString());
    console.log("Vault:", vault.toString());
    console.log("Strategy Account:", strategyAccount.toString());
    console.log("mSOL ATA:", msolAta.toString());
  });

  describe("Test 1: Initialize Strategy Account", () => {
    it("Should initialize strategy account", async () => {
      try {
        const tx = await marinadeProgram.methods
          .initialize()
          .accounts({
            strategyAccount,
            vault,
            payer: authority.publicKey,
            systemProgram: SystemProgram.programId,
            msolAta,
            msolMint: MSOL_MINT,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc({ commitment: "confirmed" });

        console.log("Initialize transaction signature:", tx);

        // Wait for confirmation
        await provider.connection.confirmTransaction(tx, "confirmed");

        // Fetch and verify strategy account
        const strategyAccountData = await marinadeProgram.account.strategyAccount.fetch(strategyAccount);
        
        assert.equal(strategyAccountData.bump, strategyBump, "Bump should match");
        assert.equal(strategyAccountData.vault.toString(), vault.toString(), "Vault pubkey should match");

        console.log("✅ Strategy initialized successfully");
      } catch (error) {
        console.error("Initialize error:", error);
        throw error;
      }
    });
  });

  describe("Test 2: Stake Valid Amount", () => {
    it("Should stake 1 SOL and receive mSOL", async () => {
      const stakeAmount = new BN(1 * LAMPORTS_PER_SOL);

      try {
        const tx = await marinadeProgram.methods
          .stake(stakeAmount)
          .accounts({
            strategyAccount,
            vault,
            payer: authority.publicKey,
            marinadeState: marinadeAccounts.marinadeState,
            reservePda: marinadeAccounts.reservePda,
            msolMint: MSOL_MINT,
            msolAta,
            msolMintAuthority: marinadeAccounts.msolMintAuthority,
            liqPoolSolLegPda: marinadeAccounts.liqPoolSolLegPda,
            liqPoolMsolLeg: marinadeAccounts.liqPoolMsolLeg,
            liqPoolMsolLegAuthority: marinadeAccounts.liqPoolMsolLegAuthority,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc({ commitment: "confirmed" });

        console.log("Stake transaction signature:", tx);
        await provider.connection.confirmTransaction(tx, "confirmed");

        // Verify mSOL was received
        const msolBalance = (await getAccount(provider.connection, msolAta)).amount;
        assert.isTrue(msolBalance > 0n, "mSOL balance should be greater than 0");

        console.log(`✅ Staked ${stakeAmount.toNumber() / LAMPORTS_PER_SOL} SOL, received ${Number(msolBalance) / LAMPORTS_PER_SOL} mSOL`);
      } catch (error) {
        console.error("Stake error:", error);
        throw error;
      }
    });
  });

  describe("Test 3: Unstake and Receive SOL with Yield", () => {
    it("Should unstake mSOL and receive SOL back (potentially with yield)", async () => {
      try {
        // Get initial balances
        const initialMsolBalance = (await getAccount(provider.connection, msolAta)).amount;
        const initialVaultBalance = await provider.connection.getBalance(vault);

        console.log("📊 Initial Balances:");
        console.log(`  mSOL: ${Number(initialMsolBalance) / LAMPORTS_PER_SOL}`);
        console.log(`  Vault SOL: ${initialVaultBalance / LAMPORTS_PER_SOL}`);

        // Unstake all mSOL
        const unstakeAmount = new BN(initialMsolBalance.toString());

        const tx = await marinadeProgram.methods
          .unstake(unstakeAmount)
          .accounts({
            vault,
            marinadeState: marinadeAccounts.marinadeState,
            msolMint: MSOL_MINT,
            liqPoolMsolLeg: marinadeAccounts.liqPoolMsolLeg,
            liqPoolSolLegPda: marinadeAccounts.liqPoolSolLegPda,
            treasuryMsolAccount: marinadeAccounts.treasuryMsolAccount,
            marinadeProgram: MARINADE_PROGRAM_ID,
          })
          .signers([authority])
          .rpc({ commitment: "confirmed" });

        console.log("Unstake transaction signature:", tx);
        await provider.connection.confirmTransaction(tx, "confirmed");

        // Get final balances
        const finalMsolBalance = (await getAccount(provider.connection, msolAta)).amount;
        const finalVaultBalance = await provider.connection.getBalance(vault);

        // Calculate changes
        const msolBurned = initialMsolBalance - finalMsolBalance;
        const solReceived = finalVaultBalance - initialVaultBalance;

        console.log("📊 Final Balances:");
        console.log(`  mSOL: ${Number(finalMsolBalance) / LAMPORTS_PER_SOL}`);
        console.log(`  Vault SOL: ${finalVaultBalance / LAMPORTS_PER_SOL}`);
        
        console.log("💰 Changes:");
        console.log(`  mSOL burned: ${Number(msolBurned) / LAMPORTS_PER_SOL}`);
        console.log(`  SOL received in vault: ${solReceived / LAMPORTS_PER_SOL}`);

        // Calculate yield (if any)
        // Note: On devnet, there might not be actual yield due to lack of time/epochs
        const yieldAmount = solReceived - Number(msolBurned);
        const yieldPercentage = (yieldAmount / Number(msolBurned)) * 100;

        if (yieldAmount > 0) {
          console.log(`Yield earned: ${yieldAmount / LAMPORTS_PER_SOL} SOL (${yieldPercentage.toFixed(4)}%)`);
        } else if (yieldAmount < 0) {
          console.log(`Net loss: ${Math.abs(yieldAmount) / LAMPORTS_PER_SOL} SOL (${Math.abs(yieldPercentage).toFixed(4)}%)`);
          console.log("   Note: This is expected on devnet due to liquidity pool fees and lack of staking rewards");
        } else {
          console.log("Break-even: No yield or loss");
        }

        // Verify unstake worked
        assert.isTrue(Number(msolBurned) > 0, "mSOL should have been burned");
        assert.isTrue(solReceived > 0, "SOL should have been received");
        assert.equal(Number(finalMsolBalance), 0, "All mSOL should be unstaked");

        console.log("✅ Unstake completed successfully!");
        console.log("Full cycle completed: SOL → mSOL → SOL");
      } catch (error) {
        console.error("Unstake error:", error);
        throw error;
      }
    });
  });
});