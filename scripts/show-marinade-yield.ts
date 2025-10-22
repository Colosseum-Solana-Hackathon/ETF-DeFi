import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { MarinadeStrategy } from "../target/types/marinade_strategy";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { MSOL_MINT } from "../tests/helpers/marinade-accounts";

/**
 * Show Marinade Yield Information
 * Displays staked SOL, mSOL received, current value, and accumulated yield
 * 
 * Usage:
 *   VAULT_ADDRESS=<vault_pda> npx ts-node scripts/show-marinade-yield.ts
 */

interface YieldInfo {
  strategyAddress: string;
  initialSolStaked: number;
  msolBalance: number;
  currentSolValue: number;
  yieldEarned: number;
  yieldPercentage: number;
  msolExchangeRate: number;
}

async function getMarinadeExchangeRate(connection: anchor.web3.Connection): Promise<number> {
  // Marinade's mSOL/SOL exchange rate
  // In production, this would query Marinade's state account
  // For now, we'll use a conservative estimate of 1.05 (5% APY over time)
  // TODO: Integrate with actual Marinade state to get real-time exchange rate
  return 1.05; // 1 mSOL = 1.05 SOL (example)
}

async function showMarinadeYield(vaultAddress: PublicKey): Promise<void> {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  
  const vaultProgram = anchor.workspace.Vault as Program<Vault>;
  const strategyProgram = anchor.workspace.MarinadeStrategy as Program<MarinadeStrategy>;

  console.log("\n🌊 Marinade Yield Report\n");
  console.log("═".repeat(80));
  console.log(`Vault Address: ${vaultAddress.toString()}`);
  
  // Fetch vault data
  const vaultData = await vaultProgram.account.vault.fetch(vaultAddress);
  
  if (!vaultData.marinadeStrategy) {
    console.log("\n❌ This vault does not have a Marinade strategy configured");
    console.log("   No staked SOL to display\n");
    return;
  }

  const strategyAddress = vaultData.marinadeStrategy;
  console.log(`Strategy Address: ${strategyAddress.toString()}\n`);
  
  // Fetch strategy data
  const strategyData = await strategyProgram.account.strategyAccount.fetch(strategyAddress);
  
  // Derive mSOL ATA for strategy
  const [msolAta] = await PublicKey.findProgramAddress(
    [
      strategyAddress.toBuffer(),
      anchor.utils.token.TOKEN_PROGRAM_ID.toBuffer(),
      MSOL_MINT.toBuffer(),
    ],
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );
  
  // Get mSOL balance
  let msolBalance = 0;
  try {
    const msolAccount = await getAccount(provider.connection, msolAta);
    msolBalance = Number(msolAccount.amount) / anchor.web3.LAMPORTS_PER_SOL;
  } catch (e) {
    console.log("⚠️  mSOL account not found or empty");
  }
  
  // Get Marinade exchange rate
  const exchangeRate = await getMarinadeExchangeRate(provider.connection);
  
  // Calculate values
  const initialSolStaked = Number(strategyData.totalStaked) / anchor.web3.LAMPORTS_PER_SOL;
  const currentSolValue = msolBalance * exchangeRate;
  const yieldEarned = currentSolValue - initialSolStaked;
  const yieldPercentage = initialSolStaked > 0 ? (yieldEarned / initialSolStaked) * 100 : 0;
  
  const yieldInfo: YieldInfo = {
    strategyAddress: strategyAddress.toString(),
    initialSolStaked,
    msolBalance,
    currentSolValue,
    yieldEarned,
    yieldPercentage,
    msolExchangeRate: exchangeRate,
  };
  
  // Display results
  console.log("📊 Staking Summary:");
  console.log("─".repeat(80));
  console.log(`  Initial SOL Staked:       ${yieldInfo.initialSolStaked.toFixed(9)} SOL`);
  console.log(`  mSOL Received:            ${yieldInfo.msolBalance.toFixed(9)} mSOL`);
  console.log(`  mSOL Exchange Rate:       1 mSOL = ${yieldInfo.msolExchangeRate.toFixed(6)} SOL`);
  console.log();
  
  console.log("💰 Current Value:");
  console.log("─".repeat(80));
  console.log(`  Current SOL Value:        ${yieldInfo.currentSolValue.toFixed(9)} SOL`);
  console.log(`  Yield Earned:             ${yieldInfo.yieldEarned.toFixed(9)} SOL`);
  console.log(`  Yield Percentage:         ${yieldInfo.yieldPercentage >= 0 ? '+' : ''}${yieldInfo.yieldPercentage.toFixed(2)}%`);
  console.log();
  
  if (yieldInfo.yieldEarned > 0) {
    console.log("✅ Your staked SOL is earning yield through Marinade! 🎉");
    console.log("   Staking rewards automatically increase your mSOL value over time.");
  } else if (yieldInfo.yieldEarned < 0) {
    console.log("⚠️  Negative yield may indicate early unstaking or market conditions.");
  } else {
    console.log("ℹ️  No yield yet - staking rewards accrue over time.");
  }
  
  console.log();
  console.log("📈 How Yield Works:");
  console.log("   • SOL is staked with Marinade validators");
  console.log("   • Validators earn staking rewards (~6-8% APY)");
  console.log("   • Rewards increase the mSOL/SOL exchange rate");
  console.log("   • Your mSOL becomes worth more SOL over time");
  console.log("   • Withdraw anytime to receive SOL + accumulated yield");
  console.log();
  console.log("═".repeat(80));
  console.log();
}

async function main() {
  const vaultAddressStr = process.env.VAULT_ADDRESS;
  
  if (!vaultAddressStr) {
    console.error("\n❌ Error: VAULT_ADDRESS environment variable not set");
    console.error("\nUsage:");
    console.error("  VAULT_ADDRESS=<your_vault_pda> npx ts-node scripts/show-marinade-yield.ts");
    console.error("\nExample:");
    console.error("  VAULT_ADDRESS=CGL64zCov7WqvJm4moJKE3XMLGPLBvTaynCYDCPRVU2K npx ts-node scripts/show-marinade-yield.ts\n");
    process.exit(1);
  }
  
  try {
    const vaultAddress = new PublicKey(vaultAddressStr);
    await showMarinadeYield(vaultAddress);
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});

