const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");


/**
 * @fileoverview
 * Utility script to safely close an existing Marinade strategy account on Solana Devnet.
 * 
 * This script is primarily used during development or testing phases to clean up old 
 * on-chain state (e.g., strategy PDAs) that might otherwise cause deployment or testing 
 * conflicts in Anchor-based programs.
 * 
 * It performs the following actions:
 * 1. Loads environment configuration (wallet, RPC).
 * 2. Loads a funded wallet (either test or default Solana CLI keypair).
 * 3. Derives the Program Derived Address (PDA) for the strategy account.
 * 4. Calls the `closeStrategy` instruction on the deployed program to reclaim rent.
 * 
 * Useful when repeatedly deploying, testing, or resetting strategy logic between program iterations.
 */
async function closeStrategy() {
    console.log("🔧 Closing existing strategy account...");
    
    // Set environment variables
    process.env.ANCHOR_WALLET = "/home/mustafa/.config/solana/id.json";
    process.env.ANCHOR_PROVIDER_URL = "https://api.devnet.solana.com";
    
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    
    // Load the program
    const program = anchor.workspace.MarinadeStrategy;
    
    // Load your funded wallet
    const keypairPath = path.join(__dirname, "..", "test-keypair.json");
    let authority;
    
    try {
        if (fs.existsSync(keypairPath)) {
            const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
            authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
            console.log("📁 Loaded existing test keypair");
        } else {
            // Use default CLI wallet
            const { execSync } = require('child_process');
            const configOutput = execSync('solana config get', { encoding: 'utf8' });
            const keypairLine = configOutput.split('\n').find(line => line.startsWith('Keypair Path:'));
            const keypairPath = keypairLine ? keypairLine.split(': ')[1].trim() : null;
            
            if (!keypairPath) {
                throw new Error('Could not find keypair path');
            }
            
            const keypairData = JSON.parse(fs.readFileSync(keypairPath));
            authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
            console.log("💰 Using your funded wallet:", authority.publicKey.toString());
        }
    } catch (error) {
        console.log("❌ Could not load keypair:", error.message);
        return;
    }
    
    // Derive the strategy account PDA
    const [strategyAccount, strategyBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("marinade_strategy"), new PublicKey("7ZZ1bMZRGRJahobo8dTsVyNsa7uk6sRfN2ypii2FhvHd").toBuffer()],
        program.programId
    );
    
    console.log("Strategy Account:", strategyAccount.toString());
    
    try {
        // Try to close the strategy account
        const tx = await program.methods
            .closeStrategy()
            .accounts({
                strategyAccount: strategyAccount,
                vault: new PublicKey("7ZZ1bMZRGRJahobo8dTsVyNsa7uk6sRfN2ypii2FhvHd"),
                payer: authority.publicKey,
            })
            .signers([authority])
            .rpc();
            
        console.log("✅ Strategy account closed successfully!");
        console.log("Transaction signature:", tx);
    } catch (error) {
        if (error.message.includes("AccountNotFound")) {
            console.log("ℹ️ Strategy account doesn't exist, no need to close");
        } else {
            console.log("❌ Error closing strategy account:", error.message);
        }
    }
}

closeStrategy().catch(console.error);
