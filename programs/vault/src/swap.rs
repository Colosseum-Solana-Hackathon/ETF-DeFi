use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use pyth_sdk_solana::PriceFeed;

/// Mock swap module for devnet testing
/// 
/// This module simulates DEX swaps using Pyth price feeds to calculate fair exchange rates.
/// In production (mainnet), this should be replaced with Jupiter aggregator integration.
/// 
/// **Design Philosophy:**
/// - Uses real Pyth prices for realistic simulations
/// - Simple atomic swaps without slippage/fees for devnet testing
/// - Easy to replace with Jupiter CPI when moving to mainnet
pub struct MockSwap;

impl MockSwap {

    /// Calculate output amount for a swap using Pyth prices
    /// 
    /// Formula: amount_out = (amount_in * from_price * 10^to_decimals) / (to_price * 10^from_decimals)
    /// 
    /// This normalizes prices to a common base and accounts for different token decimals.
    pub fn calculate_swap_output(
        amount_in: u64,
        from_price: i64,
        from_expo: i32,
        to_price: i64,
        to_expo: i32,
        from_decimals: u8,
        to_decimals: u8,
    ) -> Result<u64> {
        // Convert amounts to i128 for safe math
        let amount_in_i128 = amount_in as i128;
        let from_price_i128 = from_price as i128;
        let to_price_i128 = to_price as i128;

        // Calculate value in USD (normalized)
        // value = amount_in * from_price * 10^from_expo
        let value_from = amount_in_i128
            .checked_mul(from_price_i128)
            .ok_or(error!(crate::VaultError::MathOverflow))?;

        // Adjust for price exponents
        // Both Pyth prices have negative exponents (e.g., -8 for BTC)
        let expo_diff = from_expo - to_expo;
        let value_adjusted = if expo_diff > 0 {
            value_from
                .checked_mul(10i128.pow(expo_diff as u32))
                .ok_or(error!(crate::VaultError::MathOverflow))?
        } else if expo_diff < 0 {
            value_from
                .checked_div(10i128.pow((-expo_diff) as u32))
                .ok_or(error!(crate::VaultError::MathOverflow))?
        } else {
            value_from
        };

        // Calculate output amount: value / to_price
        let amount_out_base = value_adjusted
            .checked_div(to_price_i128)
            .ok_or(error!(crate::VaultError::MathOverflow))?;

        // Adjust for token decimals difference
        let decimals_diff = to_decimals as i32 - from_decimals as i32;
        let amount_out = if decimals_diff > 0 {
            amount_out_base
                .checked_mul(10i128.pow(decimals_diff as u32))
                .ok_or(error!(crate::VaultError::MathOverflow))?
        } else if decimals_diff < 0 {
            amount_out_base
                .checked_div(10i128.pow((-decimals_diff) as u32))
                .ok_or(error!(crate::VaultError::MathOverflow))?
        } else {
            amount_out_base
        };

        // Ensure positive result
        require!(amount_out > 0, crate::VaultError::InvalidAmount);

        Ok(amount_out as u64)
    }

    /*
    /// Execute a swap from native SOL to an SPL token
    /// 
    /// This is a specialized version for SOL deposits where users send native SOL
    /// and we need to convert it to wrapped SOL or directly to target assets.
    pub fn swap_sol_to_token<'info>(
        token_program: &Program<'info, Token>,
        destination_ata: &Account<'info, TokenAccount>,
        vault_authority: &AccountInfo<'info>,
        sol_price: &PriceFeed,
        token_price: &PriceFeed,
        token_decimals: u8,
        sol_amount: u64,
        signer_seeds: &[&[&[u8]]],
    ) -> Result<u64> {
        // Would need clock timestamp for price feed
        Ok(0)
    }
    */
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_calculation() {
        // Test BTC -> ETH swap
        // BTC: $50,000 with expo -8
        // ETH: $3,000 with expo -8
        // Amount: 0.1 BTC = 10_000_000 (8 decimals)
        // Expected: ~1.666 ETH = 1_666_666_666_666_666_666 (18 decimals)

        let amount_in = 10_000_000u64; // 0.1 BTC
        let btc_price = 50_000_00000000i64; // $50k with 8 decimals
        let eth_price = 3_000_00000000i64; // $3k with 8 decimals
        let btc_expo = -8i32;
        let eth_expo = -8i32;
        let btc_decimals = 8u8;
        let eth_decimals = 18u8;

        let result = MockSwap::calculate_swap_output(
            amount_in,
            btc_price,
            btc_expo,
            eth_price,
            eth_expo,
            btc_decimals,
            eth_decimals,
        );

        assert!(result.is_ok());
        let amount_out = result.unwrap();
        
        // 0.1 BTC (~$5000) should give roughly 1.666 ETH
        // With 18 decimals: 1.666 * 10^18 ≈ 1_666_000_000_000_000_000
        assert!(amount_out > 1_600_000_000_000_000_000u64);
        assert!(amount_out < 1_700_000_000_000_000_000u64);
    }

    #[test]
    fn test_sol_to_usdc_swap() {
        // SOL: $100 with expo -8
        // USDC: $1 with expo -8
        // Amount: 1 SOL = 1_000_000_000 lamports (9 decimals)
        // Expected: ~100 USDC = 100_000_000 (6 decimals)

        let amount_in = 1_000_000_000u64; // 1 SOL
        let sol_price = 100_00000000i64; // $100
        let usdc_price = 1_00000000i64; // $1
        let sol_expo = -8i32;
        let usdc_expo = -8i32;
        let sol_decimals = 9u8;
        let usdc_decimals = 6u8;

        let result = MockSwap::calculate_swap_output(
            amount_in,
            sol_price,
            sol_expo,
            usdc_price,
            usdc_expo,
            sol_decimals,
            usdc_decimals,
        );

        assert!(result.is_ok());
        let amount_out = result.unwrap();
        
        // 1 SOL ($100) should give 100 USDC
        assert_eq!(amount_out, 100_000_000u64);
    }
}
