import { PublicKey, Connection } from "@solana/web3.js";
import { Marinade, MarinadeConfig } from "@marinade.finance/marinade-ts-sdk";

export const MARINADE_PROGRAM_ID = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
export const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");

export async function getMarinadeAccounts(connection: Connection) {
  // Used the official Marinade SDK to get all correct account addresses
  const config = new MarinadeConfig({
    connection,
    publicKey: PublicKey.default,
  });
  
  const marinade = new Marinade(config);
  const state = await marinade.getMarinadeState();
  
  // Fetch all needed accounts from the SDK - these may be async methods
  const reservePda = await state.reserveAddress();
  const liqPoolSolLegPda = await state.solLeg();
  const liqPoolMsolLegAuthority = await state.mSolLegAuthority();
  const msolMintAuthority = await state.mSolMintAuthority();
  
  const accounts = {
    marinadeState: config.marinadeStateAddress,
    reservePda, // Awaited async method
    msolMintAuthority, // Correctly derived PDA
    liqPoolSolLegPda, // Awaited async method
    liqPoolMsolLeg: state.mSolLeg, // Already a PublicKey
    liqPoolMsolLegAuthority, // Derived from marinadeState
    treasuryMsolAccount: state.treasuryMsolAccount, // Already a PublicKey
  };
  
  // Debug: log all account addresses
  console.log("\nMarinade accounts:");
  Object.entries(accounts).forEach(([key, value]) => {
    console.log(`${key}: ${value.toString()}`);
  });
  
  return accounts;
}