import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";

/**
 * Mock Pyth Oracle Price Feed for Testing
 * 
 * This creates a mock account that mimics Pyth's price feed structure
 * for testing purposes when devnet feeds are unavailable or stale.
 */

// Pyth program ID on devnet/mainnet
export const PYTH_PROGRAM_ID = new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

// Pyth price feed account structure
export interface MockPythPrice {
  price: bigint;      // Price value
  conf: bigint;       // Confidence interval
  expo: number;       // Exponent (e.g., -8 for 8 decimals)
  publishTime: bigint; // Unix timestamp
}

/**
 * Create a mock Pyth price feed account
 * Note: This won't work on devnet as we can't create accounts owned by the Pyth program
 * This is more for documentation of the structure
 */
export async function createMockPythAccount(
  provider: anchor.AnchorProvider,
  price: number,
  expo: number,
  payer: Keypair
): Promise<PublicKey> {
  const mockAccount = Keypair.generate();
  
  // Create price feed data structure
  // This is a simplified version - actual Pyth structure is more complex
  const priceData = Buffer.alloc(3312); // Pyth account size
  
  // Write price data at appropriate offsets
  // (This is a simplified mock - real Pyth structure is more complex)
  const priceValue = BigInt(Math.floor(price * Math.pow(10, -expo)));
  priceData.writeBigInt64LE(priceValue, 208); // Price offset
  priceData.writeBigInt64LE(BigInt(Math.floor(price * 0.001)), 216); // Confidence
  priceData.writeInt32LE(expo, 224); // Exponent
  priceData.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 232); // Publish time
  
  throw new Error(
    "Cannot create mock Pyth accounts on devnet - Pyth program must own these accounts. " +
    "For testing, either:\n" +
    "1. Use working devnet feeds (BTC/USD works)\n" +
    "2. Test on localnet with cloned accounts\n" +
    "3. Deploy to mainnet for real price feeds"
  );
}

/**
 * Get Pyth price feed constants for testing
 */
export const PYTH_FEEDS = {
  // Devnet feeds - note: not all may have active data
  BTC_USD: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
  ETH_USD: new PublicKey("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB"),
  SOL_USD: new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"),
  
  // Mainnet feeds (for reference)
  BTC_USD_MAINNET: new PublicKey("GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU"),
  ETH_USD_MAINNET: new PublicKey("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB"),
  SOL_USD_MAINNET: new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"),
};

/**
 * Check if a Pyth price feed has valid data
 */
export async function checkPythFeedStatus(
  provider: anchor.AnchorProvider,
  feedAddress: PublicKey
): Promise<{ exists: boolean; hasData: boolean; ownedByPyth: boolean }> {
  try {
    const accountInfo = await provider.connection.getAccountInfo(feedAddress);
    
    if (!accountInfo) {
      return { exists: false, hasData: false, ownedByPyth: false };
    }
    
    const ownedByPyth = accountInfo.owner.equals(PYTH_PROGRAM_ID);
    const hasData = accountInfo.data.length >= 3312; // Minimum Pyth account size
    
    return {
      exists: true,
      hasData,
      ownedByPyth
    };
  } catch (error) {
    console.error(`Error checking feed ${feedAddress.toBase58()}:`, error);
    return { exists: false, hasData: false, ownedByPyth: false };
  }
}
