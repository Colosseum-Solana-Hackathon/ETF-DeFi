import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MarinadeStrategy } from "../target/types/marinade_strategy";
import { Vault } from "../target/types/vault";
import { 
  PublicKey, 
  Keypair, 
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("Marinade Strategy Tests", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const marinadeProgram = anchor.workspace.MarinadeStrategy as Program<MarinadeStrategy>;
  const vaultProgram = anchor.workspace.Vault as Program<Vault>;
  
  // Marinade constants (devnet)
  const MARINADE_PROGRAM_ID = new PublicKey("MarBmsSgKXdruk9RqBmHFrCAB8yMdQxPR9e7Q5Zz2vSPn");
  const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
  
  // Test accounts
  let authority: Keypair;
  let user: Keypair;
  let vault: PublicKey;
  let vaultBump: number;
  let strategyAccount: PublicKey;
  let strategyBump: number;
  let msolAta: PublicKey;
  let vaultTokenMint: PublicKey;

  // Marinade state accounts (you'll need to fetch these from devnet/mainnet)
  let marinadeState: PublicKey;
  let reservePda: PublicKey;
  let msolMintAuthority: PublicKey;
  let liqPoolSolLegPda: PublicKey;
  let liqPoolMsolLeg: PublicKey;
  let liqPoolMsolLegAuthority: PublicKey;
  let treasuryMsolAccount: PublicKey;

  before(async () => {
    // Initialize test accounts
    authority = Keypair.generate();
    user = Keypair.generate();

    // Airdrop SOL to test accounts
    const airdropSig1 = await provider.connection.requestAirdrop(
      authority.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig1);

    const airdropSig2 = await provider.connection.requestAirdrop(
      user.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig2);

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
      true // allowOwnerOffCurve
    );

    // TODO: Fetch these from Marinade program on devnet/mainnet
    // For now, using placeholder addresses - you'll need to replace these
    marinadeState = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
    reservePda = new PublicKey("Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN");
    msolMintAuthority = new PublicKey("3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM");
    liqPoolSolLegPda = new PublicKey("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q");
    liqPoolMsolLeg = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
    liqPoolMsolLegAuthority = new PublicKey("EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL");
    treasuryMsolAccount = new PublicKey("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR");

    console.log("Test Accounts Initialized:");
    console.log("Authority:", authority.publicKey.toString());
    console.log("User:", user.publicKey.toString());
    console.log("Vault:", vault.toString());
    console.log("Strategy Account:", strategyAccount.toString());
    console.log("mSOL ATA:", msolAta.toString());
  });

  describe("Test 1: Initialize Strategy Account", () => {
    it("Should initialize strategy account with correct seeds and create mSOL ATA", async () => {
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
          .rpc();

        console.log("Initialize transaction signature:", tx);

        // Fetch and verify strategy account
        const strategyAccountData = await marinadeProgram.account.strategyAccount.fetch(strategyAccount);
        
        assert.equal(strategyAccountData.bump, strategyBump, "Bump should match");
        assert.equal(strategyAccountData.vault.toString(), vault.toString(), "Vault pubkey should match");
        assert.equal(strategyAccountData.totalStaked.toNumber(), 0, "Total staked should be 0");
        assert.equal(strategyAccountData.msolBalance.toNumber(), 0, "mSOL balance should be 0");

        // Verify mSOL ATA was created
        const msolAtaInfo = await getAccount(provider.connection, msolAta);
        assert.equal(msolAtaInfo.mint.toString(), MSOL_MINT.toString(), "mSOL ATA mint should match");
        assert.equal(msolAtaInfo.owner.toString(), strategyAccount.toString(), "mSOL ATA owner should be strategy");

        console.log("✅ Strategy initialized successfully");
      } catch (error) {
        console.error("Initialize error:", error);
        throw error;
      }
    });

    it("Should fail to initialize with invalid PDA seeds", async () => {
      const [wrongPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("wrong_seed"), vault.toBuffer()],
        marinadeProgram.programId
      );

      try {
        await marinadeProgram.methods
          .initialize()
          .accounts({
            strategyAccount: wrongPda,
            vault,
            payer: authority.publicKey,
            systemProgram: SystemProgram.programId,
            msolAta,
            msolMint: MSOL_MINT,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        assert.fail("Should have failed with invalid PDA seeds");
      } catch (error) {
        assert.include(error.toString(), "seeds constraint", "Should fail with seeds constraint error");
        console.log("✅ Correctly rejected invalid PDA seeds");
      }
    });
  });

  describe("Test 2: Stake Valid Amount", () => {
    it("Should stake 1 SOL and receive mSOL", async () => {
      const stakeAmount = new BN(1 * LAMPORTS_PER_SOL);

      // Get initial balances
      const initialStrategyBalance = await provider.connection.getBalance(strategyAccount);
      const initialMsolBalance = (await getAccount(provider.connection, msolAta)).amount;

      try {
        const tx = await marinadeProgram.methods
          .stake(stakeAmount)
          .accounts({
            strategyAccount,
            vault,
            marinadeState,
            reservePda,
            msolMint: MSOL_MINT,
            msolAta,
            msolMintAuthority,
            liqPoolSolLegPda,
            liqPoolMsolLeg,
            liqPoolMsolLegAuthority,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        console.log("Stake transaction signature:", tx);

        // Verify strategy account updated
        const strategyData = await marinadeProgram.account.strategyAccount.fetch(strategyAccount);
        assert.equal(
          strategyData.totalStaked.toString(),
          stakeAmount.toString(),
          "Total staked should equal stake amount"
        );

        // Verify mSOL was received
        const finalMsolBalance = (await getAccount(provider.connection, msolAta)).amount;
        assert.isTrue(
          finalMsolBalance > initialMsolBalance,
          "mSOL balance should increase"
        );

        console.log(`✅ Staked ${stakeAmount.toNumber() / LAMPORTS_PER_SOL} SOL, received ${(Number(finalMsolBalance) - Number(initialMsolBalance)) / LAMPORTS_PER_SOL} mSOL`);
      } catch (error) {
        console.error("Stake error:", error);
        throw error;
      }
    });

    it("Should fail to stake zero amount", async () => {
      try {
        await marinadeProgram.methods
          .stake(new BN(0))
          .accounts({
            strategyAccount,
            vault,
            marinadeState,
            reservePda,
            msolMint: MSOL_MINT,
            msolAta,
            msolMintAuthority,
            liqPoolSolLegPda,
            liqPoolMsolLeg,
            liqPoolMsolLegAuthority,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        assert.fail("Should have failed with zero amount");
      } catch (error) {
        assert.include(error.toString(), "ZeroAmount", "Should fail with ZeroAmount error");
        console.log("✅ Correctly rejected zero stake amount");
      }
    });

    it("Should fail stake from unauthorized caller", async () => {
      const unauthorizedUser = Keypair.generate();
      
      // Airdrop to unauthorized user
      const airdropSig = await provider.connection.requestAirdrop(
        unauthorizedUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      try {
        await marinadeProgram.methods
          .stake(new BN(0.5 * LAMPORTS_PER_SOL))
          .accounts({
            strategyAccount,
            vault: unauthorizedUser.publicKey, // Wrong vault
            marinadeState,
            reservePda,
            msolMint: MSOL_MINT,
            msolAta,
            msolMintAuthority,
            liqPoolSolLegPda,
            liqPoolMsolLeg,
            liqPoolMsolLegAuthority,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([unauthorizedUser])
          .rpc();

        assert.fail("Should have failed with unauthorized caller");
      } catch (error) {
        assert.include(error.toString(), "constraint", "Should fail with constraint error");
        console.log("✅ Correctly rejected unauthorized caller");
      }
    });
  });

  describe("Test 3: Report Value", () => {
    it("Should report value with zero balance before staking", async () => {
      // Create a new strategy for this test
      const newAuthority = Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        newAuthority.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const [newVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), newAuthority.publicKey.toBuffer()],
        vaultProgram.programId
      );

      const [newStrategy] = PublicKey.findProgramAddressSync(
        [Buffer.from("marinade_strategy"), newVault.toBuffer()],
        marinadeProgram.programId
      );

      const newMsolAta = await getAssociatedTokenAddress(
        MSOL_MINT,
        newStrategy,
        true
      );

      // Initialize
      await marinadeProgram.methods
        .initialize()
        .accounts({
          strategyAccount: newStrategy,
          vault: newVault,
          payer: newAuthority.publicKey,
          systemProgram: SystemProgram.programId,
          msolAta: newMsolAta,
          msolMint: MSOL_MINT,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([newAuthority])
        .rpc();

      // Report value with zero balance
      const value = await marinadeProgram.methods
        .reportValue()
        .accounts({
          strategyAccount: newStrategy,
          vault: newVault,
          marinadeState,
          msolAta: newMsolAta,
          msolMint: MSOL_MINT,
        })
        .view();

      assert.equal(value.toNumber(), 0, "Value should be 0 with no mSOL");
      console.log("✅ Report value returns 0 with empty balance");
    });

    it("Should report value after staking", async () => {
      const value = await marinadeProgram.methods
        .reportValue()
        .accounts({
          strategyAccount,
          vault,
          marinadeState,
          msolAta,
          msolMint: MSOL_MINT,
        })
        .view();

      const msolBalance = (await getAccount(provider.connection, msolAta)).amount;
      
      assert.isTrue(value.toNumber() > 0, "Value should be greater than 0");
      assert.isTrue(
        value.toNumber() >= Number(msolBalance),
        "Value should be at least mSOL balance"
      );

      console.log(`✅ Report value: ${value.toNumber() / LAMPORTS_PER_SOL} SOL equivalent`);
    });
  });

  describe("Test 4: Unstake Operations", () => {
    it("Should fail to unstake zero amount", async () => {
      try {
        await marinadeProgram.methods
          .unstake(new BN(0))
          .accounts({
            strategyAccount,
            vault,
            marinadeState,
            msolMint: MSOL_MINT,
            liqPoolMsolLeg,
            liqPoolSolLegPda,
            msolAta,
            treasuryMsolAccount,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        assert.fail("Should have failed with zero amount");
      } catch (error) {
        assert.include(error.toString(), "ZeroAmount", "Should fail with ZeroAmount error");
        console.log("✅ Correctly rejected zero unstake amount");
      }
    });

    it("Should unstake partial amount", async () => {
      const msolBalanceBefore = (await getAccount(provider.connection, msolAta)).amount;
      const unstakeAmount = new BN(Number(msolBalanceBefore) / 2); // Unstake half

      const vaultBalanceBefore = await provider.connection.getBalance(vault);

      try {
        const tx = await marinadeProgram.methods
          .unstake(unstakeAmount)
          .accounts({
            strategyAccount,
            vault,
            marinadeState,
            msolMint: MSOL_MINT,
            liqPoolMsolLeg,
            liqPoolSolLegPda,
            msolAta,
            treasuryMsolAccount,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        console.log("Unstake partial transaction signature:", tx);

        // Verify mSOL balance decreased
        const msolBalanceAfter = (await getAccount(provider.connection, msolAta)).amount;
        assert.isTrue(
          msolBalanceAfter < msolBalanceBefore,
          "mSOL balance should decrease"
        );
        assert.approximately(
          Number(msolBalanceAfter),
          Number(msolBalanceBefore) / 2,
          1e6, // Allow small rounding difference
          "Should unstake approximately half"
        );

        // Verify vault received SOL
        const vaultBalanceAfter = await provider.connection.getBalance(vault);
        assert.isTrue(
          vaultBalanceAfter > vaultBalanceBefore,
          "Vault should receive SOL"
        );

        console.log(`✅ Unstaked ${Number(unstakeAmount) / LAMPORTS_PER_SOL} mSOL, vault received ${(vaultBalanceAfter - vaultBalanceBefore) / LAMPORTS_PER_SOL} SOL`);
      } catch (error) {
        console.error("Unstake partial error:", error);
        throw error;
      }
    });

    it("Should unstake full remaining amount", async () => {
      const msolBalanceBefore = (await getAccount(provider.connection, msolAta)).amount;
      const unstakeAmount = new BN(Number(msolBalanceBefore)); // Unstake all

      const vaultBalanceBefore = await provider.connection.getBalance(vault);

      try {
        const tx = await marinadeProgram.methods
          .unstake(unstakeAmount)
          .accounts({
            strategyAccount,
            vault,
            marinadeState,
            msolMint: MSOL_MINT,
            liqPoolMsolLeg,
            liqPoolSolLegPda,
            msolAta,
            treasuryMsolAccount,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        console.log("Unstake full transaction signature:", tx);

        // Verify mSOL balance is ~0
        const msolBalanceAfter = (await getAccount(provider.connection, msolAta)).amount;
        assert.equal(
          Number(msolBalanceAfter),
          0,
          "mSOL balance should be 0"
        );

        // Verify vault received SOL
        const vaultBalanceAfter = await provider.connection.getBalance(vault);
        assert.isTrue(
          vaultBalanceAfter > vaultBalanceBefore,
          "Vault should receive SOL"
        );

        console.log(`✅ Unstaked all mSOL, vault received ${(vaultBalanceAfter - vaultBalanceBefore) / LAMPORTS_PER_SOL} SOL`);
      } catch (error) {
        console.error("Unstake full error:", error);
        throw error;
      }
    });

    it("Should fail to unstake more than available balance", async () => {
      const msolBalance = (await getAccount(provider.connection, msolAta)).amount;
      const excessAmount = new BN(Number(msolBalance) + 1 * LAMPORTS_PER_SOL);

      try {
        await marinadeProgram.methods
          .unstake(excessAmount)
          .accounts({
            strategyAccount,
            vault,
            marinadeState,
            msolMint: MSOL_MINT,
            liqPoolMsolLeg,
            liqPoolSolLegPda,
            msolAta,
            treasuryMsolAccount,
            marinadeProgram: MARINADE_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        assert.fail("Should have failed with insufficient balance");
      } catch (error) {
        assert.include(
          error.toString(),
          "InsufficientMsol",
          "Should fail with InsufficientMsol error"
        );
        console.log("✅ Correctly rejected unstake exceeding balance");
      }
    });
  });

  describe("Test 5: Harvest", () => {
    it("Should harvest (no-op for Marinade)", async () => {
      const harvestValue = await marinadeProgram.methods
        .harvest()
        .accounts({
          strategyAccount,
          vault,
          marinadeState,
        })
        .view();

      assert.equal(harvestValue.toNumber(), 0, "Harvest should return 0 for Marinade");
      console.log("✅ Harvest correctly returns 0 (yields auto-compound in mSOL price)");
    });
  });

  describe("Test 6: Integration with Vault", () => {
    // These tests would require the vault program to be fully implemented
    // and integrated with the strategy

    it.skip("Should trigger stake when vault receives deposit", async () => {
      // TODO: Implement when vault deposit -> strategy stake flow is complete
    });

    it.skip("Should trigger unstake when user withdraws from vault", async () => {
      // TODO: Implement when vault withdrawal -> strategy unstake flow is complete
    });

    it.skip("Should track yield accrual over time", async () => {
      // TODO: Implement epoch simulation or time-based testing
    });
  });
});
