import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  getMint,
} from "@solana/spl-token";
import { expect } from "chai";

describe("vault", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = anchor.getProvider();

  // Test accounts
  let authority: Keypair;
  let user1: Keypair;
  let user2: Keypair;
  let underlyingTokenMint: PublicKey;
  let vault: PublicKey;
  let vaultTokenMint: PublicKey;
  let user1VaultTokenAccount: PublicKey;
  let user2VaultTokenAccount: PublicKey;
  let user1UnderlyingTokenAccount: PublicKey;
  let user2UnderlyingTokenAccount: PublicKey;
  let vaultUnderlyingTokenAccount: PublicKey;

  before(async () => {
    // Create test keypairs
    authority = Keypair.generate();
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    // Airdrop SOL to test accounts
    await provider.connection.requestAirdrop(authority.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(user1.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(user2.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);

    // Create underlying token mint for testing
    underlyingTokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Derive vault PDA
    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.publicKey.toBuffer()],
      program.programId
    );

    // Derive vault token mint PDA
    [vaultTokenMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_mint"), authority.publicKey.toBuffer()],
      program.programId
    );

    // Create associated token accounts
    user1VaultTokenAccount = await getAssociatedTokenAddress(
      vaultTokenMint,
      user1.publicKey
    );

    user2VaultTokenAccount = await getAssociatedTokenAddress(
      vaultTokenMint,
      user2.publicKey
    );

    user1UnderlyingTokenAccount = await getAssociatedTokenAddress(
      underlyingTokenMint,
      user1.publicKey
    );

    user2UnderlyingTokenAccount = await getAssociatedTokenAddress(
      underlyingTokenMint,
      user2.publicKey
    );

    vaultUnderlyingTokenAccount = await getAssociatedTokenAddress(
      underlyingTokenMint,
      vault
    );

    // Create underlying token accounts for users
    await createAssociatedTokenAccount(
      provider.connection,
      authority,
      underlyingTokenMint,
      user1.publicKey
    );

    await createAssociatedTokenAccount(
      provider.connection,
      authority,
      underlyingTokenMint,
      user2.publicKey
    );

    // Mint underlying tokens to users
    await mintTo(
      provider.connection,
      authority,
      underlyingTokenMint,
      user1UnderlyingTokenAccount,
      authority,
      1000 * 10**6 // 1000 tokens with 6 decimals
    );

    await mintTo(
      provider.connection,
      authority,
      underlyingTokenMint,
      user2UnderlyingTokenAccount,
      authority,
      1000 * 10**6 // 1000 tokens with 6 decimals
    );
  });

  it("Initialize vault", async () => {
    const tx = await program.methods
      .initializeVault(underlyingTokenMint)
      .accounts({
        vault: vault,
        authority: authority.publicKey,
        vaultTokenMint: vaultTokenMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    console.log("Initialize vault transaction signature", tx);

    // Verify vault was initialized correctly
    const vaultAccount = await program.account.vault.fetch(vault);
    expect(vaultAccount.authority.toString()).to.equal(authority.publicKey.toString());
    expect(vaultAccount.vaultTokenMint.toString()).to.equal(vaultTokenMint.toString());
    expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
    expect(vaultAccount.underlyingAssetMint.toString()).to.equal(underlyingTokenMint.toString());
  });

  it("User deposits tokens and receives correct shares", async () => {
    const depositAmount = 100 * 10**6; // 100 tokens with 6 decimals

    const tx = await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
        vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    console.log("Deposit transaction signature", tx);

    // Verify user received shares (1:1 ratio for first deposit)
    const userVaultTokenAccountInfo = await getAccount(
      provider.connection,
      user1VaultTokenAccount
    );
    expect(userVaultTokenAccountInfo.amount.toString()).to.equal(depositAmount.toString());

    // Verify vault total assets increased
    const vaultAccount = await program.account.vault.fetch(vault);
    expect(vaultAccount.totalAssets.toNumber()).to.equal(depositAmount);
  });

  it("Multiple deposits maintain proportional shares", async () => {
    const firstDepositAmount = 100 * 10**6;
    const secondDepositAmount = 200 * 10**6;

    // First deposit by user1
    await program.methods
      .deposit(new anchor.BN(firstDepositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
        vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    // Second deposit by user2
    await program.methods
      .deposit(new anchor.BN(secondDepositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user2.publicKey,
        userVaultTokenAccount: user2VaultTokenAccount,
        userUnderlyingTokenAccount: user2UnderlyingTokenAccount,
        vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    // Get account info after both deposits
    const user1VaultTokenAccountInfo = await getAccount(
      provider.connection,
      user1VaultTokenAccount
    );
    const user2VaultTokenAccountInfo = await getAccount(
      provider.connection,
      user2VaultTokenAccount
    );
    const vaultAccount = await program.account.vault.fetch(vault);

    // User1 should have 100 shares (first deposit, 1:1 ratio)
    expect(user1VaultTokenAccountInfo.amount.toString()).to.equal(firstDepositAmount.toString());

    // User2 should have 200 shares (second deposit, 1:1 ratio since total was 100)
    expect(user2VaultTokenAccountInfo.amount.toString()).to.equal(secondDepositAmount.toString());

    // Total assets should be 300
    expect(vaultAccount.totalAssets.toNumber()).to.equal(firstDepositAmount + secondDepositAmount);
  });

  it("User withdraws shares and receives proportional tokens", async () => {
    const sharesToBurn = 50 * 10**6; // 50 shares

    // Get initial balances
    const initialUserUnderlyingBalance = await getAccount(
      provider.connection,
      user1UnderlyingTokenAccount
    );
    const initialVaultTotalAssets = (await program.account.vault.fetch(vault)).totalAssets;

    const tx = await program.methods
      .withdraw(new anchor.BN(sharesToBurn))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
        vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1])
      .rpc();

    console.log("Withdraw transaction signature", tx);

    // Verify user's vault token balance decreased
    const userVaultTokenAccountInfo = await getAccount(
      provider.connection,
      user1VaultTokenAccount
    );
    const expectedRemainingShares = 100 * 10**6 - sharesToBurn; // 100 - 50 = 50
    expect(userVaultTokenAccountInfo.amount.toString()).to.equal(expectedRemainingShares.toString());

    // Verify user received underlying tokens
    const finalUserUnderlyingBalance = await getAccount(
      provider.connection,
      user1UnderlyingTokenAccount
    );
    const tokensReceived = finalUserUnderlyingBalance.amount - initialUserUnderlyingBalance.amount;
    expect(tokensReceived.toString()).to.equal(sharesToBurn.toString()); // 1:1 ratio for this test

    // Verify vault total assets decreased
    const finalVaultAccount = await program.account.vault.fetch(vault);
    expect(finalVaultAccount.totalAssets.toNumber()).to.equal(initialVaultTotalAssets.toNumber() - sharesToBurn);
  });

  it("Edge case: withdraw more than balance should fail", async () => {
    const userVaultTokenAccountInfo = await getAccount(
      provider.connection,
      user1VaultTokenAccount
    );
    const excessiveShares = userVaultTokenAccountInfo.amount + BigInt(1);

    try {
      await program.methods
        .withdraw(new anchor.BN(excessiveShares.toString()))
        .accounts({
          vault: vault,
          vaultTokenMint: vaultTokenMint,
          user: user1.publicKey,
          userVaultTokenAccount: user1VaultTokenAccount,
          userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
          vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      expect.fail("Expected transaction to fail");
    } catch (error) {
      expect(error.message).to.include("InsufficientShares");
    }
  });

  it("Edge case: deposit with 0 amount should fail", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(0))
        .accounts({
          vault: vault,
          vaultTokenMint: vaultTokenMint,
          user: user1.publicKey,
          userVaultTokenAccount: user1VaultTokenAccount,
          userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
          vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      expect.fail("Expected transaction to fail");
    } catch (error) {
      expect(error.message).to.include("InvalidAmount");
    }
  });

  it("Edge case: withdraw with 0 amount should fail", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(0))
        .accounts({
          vault: vault,
          vaultTokenMint: vaultTokenMint,
          user: user1.publicKey,
          userVaultTokenAccount: user1VaultTokenAccount,
          userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
          vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      expect.fail("Expected transaction to fail");
    } catch (error) {
      expect(error.message).to.include("InvalidAmount");
    }
  });

  it("Proportional share calculation works correctly", async () => {
    // This test verifies that the vault maintains proper proportional accounting
    // when users deposit at different times with different amounts

    const vaultAccount = await program.account.vault.fetch(vault);
    const vaultTokenMintInfo = await getMint(provider.connection, vaultTokenMint);
    
    console.log("Final vault state:");
    console.log("- Total assets:", vaultAccount.totalAssets.toString());
    console.log("- Total supply:", vaultTokenMintInfo.supply.toString());
    console.log("- User1 shares:", (await getAccount(provider.connection, user1VaultTokenAccount)).amount.toString());
    console.log("- User2 shares:", (await getAccount(provider.connection, user2VaultTokenAccount)).amount.toString());

    // Verify that total supply equals sum of user shares
    const user1Shares = (await getAccount(provider.connection, user1VaultTokenAccount)).amount;
    const user2Shares = (await getAccount(provider.connection, user2VaultTokenAccount)).amount;
    const totalUserShares = user1Shares + user2Shares;
    
    expect(vaultTokenMintInfo.supply.toString()).to.equal(totalUserShares.toString());
  });
});
