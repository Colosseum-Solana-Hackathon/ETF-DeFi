import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

async function main() {
  // Configure the client to use the local cluster
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = anchor.getProvider();

  console.log("Deploying Vault Program...");
  console.log("Program ID:", program.programId.toString());

  // Create a test authority
  const authority = Keypair.generate();
  console.log("Authority:", authority.publicKey.toString());

  // Airdrop SOL to authority
  await provider.connection.requestAirdrop(authority.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
  console.log("Airdropped SOL to authority");

  // Derive vault PDA
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.publicKey.toBuffer()],
    program.programId
  );

  // Derive vault token mint PDA
  const [vaultTokenMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint"), authority.publicKey.toBuffer()],
    program.programId
  );

  console.log("Vault PDA:", vault.toString());
  console.log("Vault Token Mint PDA:", vaultTokenMint.toString());

  try {
    // Initialize SOL vault
    console.log("\nInitializing SOL vault...");
    const tx = await program.methods
      .initializeVault(null) // null for SOL vault
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

    console.log("SOL Vault initialized successfully!");
    console.log("Transaction signature:", tx);

    // Fetch and display vault state
    const vaultAccount = await program.account.vault.fetch(vault);
    console.log("\nVault State:");
    console.log("- Authority:", vaultAccount.authority.toString());
    console.log("- Vault Token Mint:", vaultAccount.vaultTokenMint.toString());
    console.log("- Total Assets:", vaultAccount.totalAssets.toString());
    console.log("- Underlying Asset Mint:", vaultAccount.underlyingAssetMint);
    console.log("- Bump:", vaultAccount.bump);

  } catch (error) {
    console.error("Error initializing vault:", error);
  }
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});
