import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { 
  getMXEAccAddress,
  getArciumAccountBaseSeed,
  getArciumProgAddress,
  getCompDefAccOffset,
  uploadCircuit,
  buildFinalizeCompDefTx,
} from "@arcium-hq/client";

// Use the deployed program ID
const PROGRAM_ID = "FUWuF1T2aQMzJm1jy9sXFZmU2nyEeU1u6RDpuxfQ5pYx";

const ARCIUM_BASE_PROGRAM = new PublicKey("BKck65TgoKRokMjQM3datB9oRwJ8rAj2jxPXvHXUvcL6");

// Arcium's official devnet cluster pubkey (from their devnet deployment)
// This cluster is maintained by Arcium team and always available
const ARCIUM_DEVNET_CLUSTER = new PublicKey("8LqiueY9ti4nqWQ4HzrjzT6B7bW9EQgPoHvPFRnbVUXH");

async function initializeComputationDefinition() {
  console.log("🔧 Initializing Arcium Computation Definition...\n");

  // Setup connection and wallet
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load your keypair
  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const payer = anchor.web3.Keypair.fromSecretKey(new Uint8Array(keypairData));

  console.log("Payer:", payer.publicKey.toString());
  console.log("Program ID:", PROGRAM_ID);

  // Load IDL
  const idlPath = path.join(__dirname, "../target/idl/rebalancing_mxe.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // Create provider and program
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const program = new Program(idl, provider);

  // Use Arcium's devnet cluster
  console.log("\n📍 Using Arcium devnet cluster...");
  const clusterAccount = ARCIUM_DEVNET_CLUSTER;
  console.log("Cluster Account:", clusterAccount.toString());

  // Verify cluster exists
  const clusterAccountInfo = await connection.getAccountInfo(clusterAccount);
  if (!clusterAccountInfo) {
    console.error("❌ Arcium cluster not found on devnet");
    console.error("   Using hardcoded cluster pubkey from Arcium docs");
    console.error("   If this persists, check Arcium Discord for latest cluster address");
  } else {
    console.log("✅ Cluster active");
  }

  // Use Arcium client library to derive MXE address properly
  const mxeProgramId = new PublicKey(PROGRAM_ID);
  const mxeAccount = getMXEAccAddress(mxeProgramId);
  console.log("\nMXE Account (derived from Arcium client):", mxeAccount.toString());

  // Derive comp_def account using Arcium client library
  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const compDefOffsetBuffer = getCompDefAccOffset("compute_rebalancing");
  const compDefOffset = Buffer.from(compDefOffsetBuffer).readUInt32LE(0);
  
  const [compDefAccount] = PublicKey.findProgramAddressSync(
    [
      baseSeedCompDefAcc,
      mxeProgramId.toBuffer(),
      compDefOffsetBuffer
    ],
    getArciumProgAddress()
  );
  console.log("Comp Def Offset:", compDefOffset);
  console.log("Comp Def Account:", compDefAccount.toString());

  try {
    // Check if comp_def already initialized
    console.log("\n🔍 Checking Comp Def account...");
    const compDefAccountInfo = await connection.getAccountInfo(compDefAccount);
    if (compDefAccountInfo) {
      console.log("ℹ️  Comp Def account already initialized");
      console.log("Comp Def Account:", compDefAccount.toString());
      return;
    }

    // Initialize computation definition
    console.log("\n📤 Sending init_compute_rebalancing_comp_def transaction...");
    console.log("    (MXE will be created automatically by Arcium program)");

    const tx = await program.methods
      .initComputeRebalancingCompDef()
      .accounts({
        payer: payer.publicKey,
        compDefAccount: compDefAccount,
        mxeAccount: mxeAccount,
        arciumProgram: ARCIUM_BASE_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("✅ Computation definition initialized!");
    console.log("Transaction:", tx);
    console.log(
      `\nView on Solana Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );
    
    // Upload circuit after initialization
    console.log("\n☁️  Uploading circuit to Arcium cluster...");
    const circuitPath = path.join(__dirname, "../build/compute_rebalancing.arcis");
    
    if (!fs.existsSync(circuitPath)) {
      console.error("❌ Circuit file not found:", circuitPath);
      console.error("   Run: arcium build");
      process.exit(1);
    }
    
    const rawCircuit = fs.readFileSync(circuitPath);
    console.log("   Circuit size:", rawCircuit.length, "bytes");
    
    try {
      await uploadCircuit(
        provider,
        "compute_rebalancing",
        mxeProgramId,
        rawCircuit,
        true // use_onchain_source
      );
      console.log("✅ Circuit uploaded successfully");
    } catch (uploadError: any) {
      console.error("⚠️  Circuit upload failed:", uploadError.message);
      console.error("   The comp def is initialized, but circuit upload failed.");
      console.error("   You may need to upload manually or increase compute budget.");
    }
    
    // Finalize comp def
    console.log("\n🏁 Finalizing computation definition...");
    try {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider,
        compDefOffset,
        mxeProgramId
      );
      
      const latestBlockhash = await connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
      finalizeTx.sign(payer);
      
      const finalizeSig = await provider.sendAndConfirm(finalizeTx);
      console.log("✅ Comp def finalized:", finalizeSig);
    } catch (finalizeError: any) {
      console.error("⚠️  Finalization failed:", finalizeError.message);
      console.error("   The comp def is initialized and may work without explicit finalization.");
    }
  } catch (error) {
    console.error("❌ Failed to initialize computation definition:");
    console.error(error);
    process.exit(1);
  }
}

initializeComputationDefinition().catch((error) => {
  console.error(error);
  process.exit(1);
});
