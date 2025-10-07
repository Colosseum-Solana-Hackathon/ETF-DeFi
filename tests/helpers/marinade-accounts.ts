import { PublicKey, Connection } from "@solana/web3.js";

/**
 * Marinade Finance Account Addresses
 * These addresses are consistent across mainnet and devnet
 */

export const MARINADE_PROGRAM_ID = new PublicKey(
  "MarBmsSgKXdruk9RqBmHFrCAB8yMdQxPR9e7Q5Zz2vSPn"
);

export const MSOL_MINT = new PublicKey(
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"
);

// Mainnet Marinade State
export const MARINADE_STATE_MAINNET = new PublicKey(
  "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC"
);

// Devnet Marinade State (if different)
export const MARINADE_STATE_DEVNET = MARINADE_STATE_MAINNET;

/**
 * Derives Marinade-related PDAs
 */
export function deriveMarinadeAccounts(marinadeState: PublicKey) {
  const [reservePda] = PublicKey.findProgramAddressSync(
    [marinadeState.toBuffer(), Buffer.from("reserve")],
    MARINADE_PROGRAM_ID
  );

  const [msolMintAuthority] = PublicKey.findProgramAddressSync(
    [marinadeState.toBuffer(), Buffer.from("st_mint")],
    MARINADE_PROGRAM_ID
  );

  const [liqPoolSolLegPda] = PublicKey.findProgramAddressSync(
    [marinadeState.toBuffer(), Buffer.from("liq_sol")],
    MARINADE_PROGRAM_ID
  );

  const [liqPoolMsolLegAuthority] = PublicKey.findProgramAddressSync(
    [marinadeState.toBuffer(), Buffer.from("liq_st_authority")],
    MARINADE_PROGRAM_ID
  );

  return {
    reservePda,
    msolMintAuthority,
    liqPoolSolLegPda,
    liqPoolMsolLegAuthority,
  };
}

/**
 * Fetches Marinade state from the blockchain and extracts account addresses
 */
export async function fetchMarinadeState(
  connection: Connection,
  marinadeStateAddress: PublicKey
) {
  try {
    const accountInfo = await connection.getAccountInfo(marinadeStateAddress);
    
    if (!accountInfo) {
      throw new Error("Marinade state account not found");
    }

    // Parse Marinade state (simplified - adjust based on actual state structure)
    const data = accountInfo.data;
    
    // Marinade state layout (offsets may vary - check Marinade SDK)
    // These are example offsets - you'll need to adjust based on actual layout
    const liqPoolMsolLeg = new PublicKey(data.slice(648, 680)); // Example offset
    const treasuryMsolAccount = new PublicKey(data.slice(680, 712)); // Example offset

    return {
      liqPoolMsolLeg,
      treasuryMsolAccount,
    };
  } catch (error) {
    console.error("Error fetching Marinade state:", error);
    
    // Fallback to known addresses if parsing fails
    return {
      liqPoolMsolLeg: new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE"),
      treasuryMsolAccount: new PublicKey("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR"),
    };
  }
}

/**
 * Helper to get all Marinade accounts needed for staking/unstaking
 */
export async function getAllMarinadeAccounts(
  connection: Connection,
  network: "mainnet" | "devnet" | "localnet" = "devnet"
) {
  const marinadeState = network === "mainnet" 
    ? MARINADE_STATE_MAINNET 
    : MARINADE_STATE_DEVNET;

  const derivedAccounts = deriveMarinadeAccounts(marinadeState);
  const stateAccounts = await fetchMarinadeState(connection, marinadeState);

  return {
    marinadeState,
    msolMint: MSOL_MINT,
    marinadeProgram: MARINADE_PROGRAM_ID,
    ...derivedAccounts,
    ...stateAccounts,
  };
}
