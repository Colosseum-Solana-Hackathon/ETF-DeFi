import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";

// Your deployed program ID
const PROGRAM_ID = "6sQTw22nEhpV8byHif5M6zTJXSG1Gp8qtsTY4qfdq65K";
const CLUSTER_OFFSET = 1078779259;
const ARCIUM_BASE_PROGRAM = new PublicKey("BKck65TgoKRokMjQM3datB9oRwJ8rAj2jxPXvHXUvcL6");

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

  // Derive cluster account address using the cluster offset (u32 little-endian)
  const clusterOffsetBuffer = Buffer.alloc(4);
  clusterOffsetBuffer.writeUInt32LE(CLUSTER_OFFSET, 0);
  
  const [clusterAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("cluster"), clusterOffsetBuffer],
    ARCIUM_BASE_PROGRAM
  );
  console.log("Cluster Account:", clusterAccount.toString());

  // The MXE account was created by arcium init-mxe command
  // Address from transaction: 4LjdgrW1BVFUi5kVBZynkJbRpvpRPMzr39La8BaoTDihhRsYY1oHfvjy99DzigoiMtei6BnWrA57ZeiBkHKqzFVG
  const mxeAccount = new PublicKey("FFtGZYfUXf2roU7JKpjPux5P5kVjfy6RbvVV1SrNMpVE");
  console.log("MXE Account:", mxeAccount.toString());

  // Derive comp_def account using correct seeds from Arcium docs:
  // Seeds: ["ComputationDefinitionAccount", mxe_program_id, comp_def_offset]
  // comp_def_offset = first 4 bytes of sha256("compute_rebalancing") as u32 LE
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update('compute_rebalancing').digest();
  const compDefOffset = hash.readUInt32LE(0);
  
  const compDefOffsetBuffer = Buffer.alloc(4);
  compDefOffsetBuffer.writeUInt32LE(compDefOffset, 0);
  
  const mxeProgramId = new PublicKey(PROGRAM_ID);
  const [compDefAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("ComputationDefinitionAccount"),
      mxeProgramId.toBuffer(),
      compDefOffsetBuffer
    ],
    ARCIUM_BASE_PROGRAM
  );
  console.log("Comp Def Offset:", compDefOffset);
  console.log("Comp Def Account:", compDefAccount.toString());

  try {
    // Check if MXE account exists
    console.log("\n🔍 Checking MXE account...");
    const mxeAccountInfo = await connection.getAccountInfo(mxeAccount);
    
    if (!mxeAccountInfo) {
      console.log("⚠️  MXE account not found at derived address");
      console.log("   Searching for MXE accounts created by arcium init-mxe...\n");
      
      // Get all accounts owned by Arcium base program
      // Filter by data size to find MXE accounts (they typically have specific sizes)
      const accounts = await connection.getProgramAccounts(ARCIUM_BASE_PROGRAM, {
        filters: [
          {
            dataSize: 1000, // Adjust based on typical MXE account size
          },
        ],
      });
      
      console.log(`Found ${accounts.length} account(s) owned by Arcium base program:`);
      for (const { pubkey, account } of accounts) {
        console.log(`  - ${pubkey.toString()} (${account.data.length} bytes, owner: ${account.owner.toString()})`);
      }
      
      if (accounts.length === 0) {
        console.log("\nTrying without size filter...");
        const allAccounts = await connection.getProgramAccounts(ARCIUM_BASE_PROGRAM);
        console.log(`Total accounts: ${allAccounts.length}`);
        for (const { pubkey, account } of allAccounts.slice(0, 10)) {
          console.log(`  - ${pubkey.toString()} (${account.data.length} bytes)`);
        }
      }
      
      console.log("\nℹ️  The MXE account might not have been created, or uses different seeds");
      console.log("   Transaction was: 4LjdgrW1BVFUi5kVBZynkJbRpvpRPMzr39La8BaoTDihhRsYY1oHfvjy99DzigoiMtei6BnWrA57ZeiBkHKqzFVG");
      console.log("   Check this transaction on Solana Explorer to see which account was created\n");
      process.exit(1);
    }
    console.log("✅ MXE account exists");

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
