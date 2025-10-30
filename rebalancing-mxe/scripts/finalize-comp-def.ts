import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { 
  buildFinalizeCompDefTx,
  getCompDefAccOffset,
} from "@arcium-hq/client";

const PROGRAM_ID = "FwbzbjGyBmb5n7VAPfMnYKZthycScuA6ktGE7rtZ2Z9x";

async function finalizeCompDef() {
  console.log("🏁 Finalizing computation definition...\n");

  // Setup connection and wallet
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load your keypair
  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const payer = anchor.web3.Keypair.fromSecretKey(new Uint8Array(keypairData));

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const mxeProgramId = new PublicKey(PROGRAM_ID);
  
  try {
    const compDefOffsetBuffer = getCompDefAccOffset("compute_rebalancing");
    const compDefOffset = Buffer.from(compDefOffsetBuffer).readUInt32LE(0);
    
    console.log("Comp Def Offset:", compDefOffset);
    console.log("MXE Program:", mxeProgramId.toString());
    
    const finalizeTx = await buildFinalizeCompDefTx(
      provider,
      compDefOffset,
      mxeProgramId
    );
    
    const latestBlockhash = await connection.getLatestBlockhash();
    finalizeTx.recentBlockhash = latestBlockhash.blockhash;
    finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
    finalizeTx.sign(payer);
    
    console.log("\n⏳ Sending finalize transaction...");
    const finalizeSig = await provider.sendAndConfirm(finalizeTx);
    console.log("✅ Comp def finalized!");
    console.log("   Transaction:", finalizeSig);
    console.log(`   View: https://explorer.solana.com/tx/${finalizeSig}?cluster=devnet`);
  } catch (finalizeError: any) {
    console.error("❌ Finalization failed:", finalizeError.message);
    console.error(finalizeError);
    process.exit(1);
  }
}

finalizeCompDef().catch((error) => {
  console.error(error);
  process.exit(1);
});
